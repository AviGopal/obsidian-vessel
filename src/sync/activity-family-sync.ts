/**
 * ActivityFamilySyncService
 *
 * Groups activity templates by their first tag segment (family prefix)
 * and writes one vault note per family under `activityFamilyFolder`.
 * Runs on the same interval cadence as ConceptSyncService.
 *
 * Families tracked: gap-closing, substrate-health, detection, coverage,
 * boredom, vessel-construction, concept-db, topology.
 *
 * Uses ActivityAPIClient.listActivityTemplates() with a search query,
 * then groups client-side by first tag prefix since the API's ?tag_prefix
 * filter is advisory (falls through to FTS if not supported).
 */

import type { App } from 'obsidian';
import type { MetabobVesselSettings } from '../settings';
import type { ActivityAPIClient } from '../api-client';
import type { ActivityTemplate } from '../types';

const TRACKED_FAMILIES = [
  'gap-closing',
  'substrate-health',
  'detection',
  'coverage',
  'boredom',
  'vessel-construction',
  'concept-db',
  'topology',
] as const;

type FamilyName = (typeof TRACKED_FAMILIES)[number];

interface FamilyStats {
  family: FamilyName;
  members: ActivityTemplate[];
  totalExecutions: number;
  successRate: number;
  avgThompsonAlpha: number;
  avgThompsonBeta: number;
}

function firstTagPrefix(template: ActivityTemplate): string | null {
  const tags: string[] = (template as any).tags ?? [];
  if (!tags.length) return null;
  // Accept both "gap-closing.some-sub" and "gap-closing" forms
  return tags[0].split('.')[0].toLowerCase();
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function toPercent(r: number): string {
  return `${Math.round(r * 100)}%`;
}

function buildFamilyNote(stats: FamilyStats, now: string): string {
  const { family, members, totalExecutions, successRate, avgThompsonAlpha, avgThompsonBeta } =
    stats;
  const title = humanize(family);
  const top20 = members
    .slice()
    .sort(
      (a, b) =>
        ((b.metrics?.total_executions ?? 0) as number) -
        ((a.metrics?.total_executions ?? 0) as number),
    )
    .slice(0, 20);

  const fm = [
    '---',
    `activity_family: ${family}`,
    `total_members: ${members.length}`,
    `total_executions: ${totalExecutions}`,
    `success_rate: ${successRate.toFixed(2)}`,
    `avg_thompson_alpha: ${avgThompsonAlpha.toFixed(1)}`,
    `avg_thompson_beta: ${avgThompsonBeta.toFixed(1)}`,
    `last_updated: ${now}`,
    'type: activity-family',
    '---',
  ].join('\n');

  const statsTable = [
    '## Stats',
    '',
    '| Members | Executions | Success Rate | Thompson |',
    '|---------|-----------|--------------|---------|',
    `| ${members.length} | ${totalExecutions} | ${toPercent(successRate)} | α=${avgThompsonAlpha.toFixed(1)} β=${avgThompsonBeta.toFixed(1)} |`,
    '',
  ].join('\n');

  const memberLines = top20.map((t) => {
    const name = (t as any).name || (t as any).activity_id || t.id || 'Unknown';
    const execs = (t.metrics?.total_executions ?? 0) as number;
    const sr = (t.metrics?.success_rate ?? 0) as number;
    const alpha = (t.metrics?.thompson_alpha ?? 1) as number;
    const beta = (t.metrics?.thompson_beta ?? 1) as number;
    return `- [[${name}]] · executions: ${execs} · sr: ${toPercent(sr)} · α: ${alpha.toFixed(1)} β: ${beta.toFixed(1)}`;
  });

  const membersSection = ['## Members', '', ...memberLines, ''].join('\n');

  const body = [
    fm,
    '',
    `# ${title}`,
    '',
    `Activities in the **${family}** family.`,
    '',
    statsTable,
    membersSection,
  ].join('\n');

  return body.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export class ActivityFamilySyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly log = (msg: string, data?: Record<string, unknown>) => {
    const tail = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[ActivityFamilySync] ${msg}${tail}`);
  };

  constructor(
    private readonly app: App,
    private readonly settings: MetabobVesselSettings,
    private readonly apiClient: ActivityAPIClient,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.log('starting', { folder: this.settings.activityFamilyFolder });
    this.syncAll().catch((err) => this.log('initial sync failed', { error: String(err) }));
    const ms = Math.max(60_000, this.settings.syncIntervalMinutes * 60_000);
    this.timer = setInterval(() => {
      this.syncAll().catch((err) => this.log('periodic sync failed', { error: String(err) }));
    }, ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncAll(): Promise<void> {
    this.log('sync tick');
    const now = new Date().toISOString();

    // Fetch all templates in one paginated pass (up to 500)
    const allTemplates: ActivityTemplate[] = [];
    try {
      const resp = await this.apiClient.listActivityTemplates({ limit: 100, offset: 0 });
      allTemplates.push(...(resp.templates ?? []));
      // If there are more, fetch them
      const total = resp.total ?? 0;
      for (let offset = 100; offset < Math.min(total, 500); offset += 100) {
        const page = await this.apiClient.listActivityTemplates({ limit: 100, offset });
        allTemplates.push(...(page.templates ?? []));
      }
    } catch (err) {
      this.log('failed to fetch templates', { error: String(err) });
      return;
    }

    this.log('fetched templates', { count: allTemplates.length });

    // Group by first tag prefix
    const familyMap = new Map<FamilyName, ActivityTemplate[]>();
    for (const family of TRACKED_FAMILIES) familyMap.set(family, []);

    for (const t of allTemplates) {
      const prefix = firstTagPrefix(t);
      if (prefix && familyMap.has(prefix as FamilyName)) {
        familyMap.get(prefix as FamilyName)!.push(t);
      }
    }

    // Write one note per family
    for (const family of TRACKED_FAMILIES) {
      const members = familyMap.get(family) ?? [];
      const stats = computeStats(family, members);
      const content = buildFamilyNote(stats, now);
      const notePath = `${this.settings.activityFamilyFolder}/${humanize(family)}.md`;
      await this.writeNote(notePath, content);
    }

    this.log('sync complete', { families: TRACKED_FAMILIES.length });
  }

  private async writeNote(notePath: string, content: string): Promise<void> {
    const folderPath = notePath.substring(0, notePath.lastIndexOf('/'));
    await ensureFolderExists(this.app, folderPath);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing) {
      const { TFile } = await import('obsidian');
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      }
    } else {
      await this.app.vault.create(notePath, content);
    }
  }
}

function computeStats(family: FamilyName, members: ActivityTemplate[]): FamilyStats {
  if (!members.length) {
    return {
      family,
      members: [],
      totalExecutions: 0,
      successRate: 0,
      avgThompsonAlpha: 1,
      avgThompsonBeta: 1,
    };
  }
  let totalExec = 0;
  let totalSucc = 0;
  let sumAlpha = 0;
  let sumBeta = 0;
  for (const t of members) {
    const m = t.metrics;
    if (!m) continue;
    totalExec += (m.total_executions as number) ?? 0;
    totalSucc += (m.successful_executions as number) ?? 0;
    sumAlpha += (m.thompson_alpha as number) ?? 1;
    sumBeta += (m.thompson_beta as number) ?? 1;
  }
  const withMetrics = members.filter((t) => !!t.metrics).length || 1;
  return {
    family,
    members,
    totalExecutions: totalExec,
    successRate: totalExec > 0 ? totalSucc / totalExec : 0,
    avgThompsonAlpha: sumAlpha / withMetrics,
    avgThompsonBeta: sumBeta / withMetrics,
  };
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.split('/').filter((p) => p.length > 0);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      try {
        await app.vault.createFolder(current);
      } catch {
        // may have been created concurrently
      }
    }
  }
}
