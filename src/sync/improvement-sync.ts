/**
 * Substrate-improvement note sync ("is the substrate getting better").
 *
 * Exports `syncImprovements(settings, writeNote)`, invoked by main.ts's
 * `scheduleImprovementSync()` on plugin load and on an interval timer.
 * The note is PULLED by the plugin — the substrate never pushes it, never
 * blocks on Obsidian being open, and obsidian is not part of the
 * substrate's boredom rotation.
 *
 * Metric sources (each fail-soft; an unreachable source renders as
 * "unavailable" instead of failing the whole note):
 *   1. Execution traces — activity-api GET /v2/activities/execution-traces
 *   2. Goal verification labels (reach-gate / oracle corpus) — activity-api
 *      POST /v2/impulses/resolve, shape goal_verification_label
 *   3. Substrate gaps — development-vessel POST /v2/impulses/resolve,
 *      shape substrateGap
 *   4. Goal-path stats — activity-api GET /v2/goal-paths/stats
 *
 * DATA-FRESHNESS HONESTY: a known trace-persistence defect can starve the
 * trace store. The note always states how many traces the window actually
 * contains and flags low counts instead of presenting starved data as calm.
 */

import type { ObsidianVesselSettings } from '../settings';
import { formatSuccessRate } from '../formatters/metrics-formatter';

export const IMPROVEMENT_NOTE_PATH = 'Substrate/Improvement.md';
import { sidecarHttp } from '../sidecar-manager';
const WINDOW_HOURS = 24;
const LOW_TRACE_THRESHOLD = 10;
const TRACE_FETCH_LIMIT = 200;
const LABEL_FETCH_LIMIT = 100;

interface TraceRow {
  activity_id?: string;
  success?: boolean;
  executed_at?: string;
}

interface LabelRow {
  verdict?: string;
  created_at?: string;
}

interface GapRow {
  status?: string;
}

interface GoalPathStats {
  total_goals?: number;
  total_paths?: number;
}

type NoteWriter = (path: string, content: string) => Promise<void>;

function log(msg: string, data?: Record<string, unknown>): void {
  const tail = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[ImprovementSync] ${msg}${tail}`);
}

function authHeaders(settings: ObsidianVesselSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) {
    headers['Authorization'] = `ApiKey ${settings.apiKey}`;
  }
  return headers;
}

async function fetchTraces(settings: ObsidianVesselSettings): Promise<TraceRow[] | null> {
  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();
  const path = `/v2/activities/execution-traces?limit=${TRACE_FETCH_LIMIT}&start_date=${encodeURIComponent(since)}`;
  // Sidecar-first: routed to the vessel owning the trace store via discovery.
  const viaSidecar = await sidecarHttp(settings, { shape: 'activityExecutionTrace', path });
  if (viaSidecar && viaSidecar.ok && Array.isArray(viaSidecar.body?.executions)) {
    return viaSidecar.body.executions as TraceRow[];
  }
  log('trace fetch unavailable (sidecar conduit unreachable)');
  return null;
}

async function fetchLabels(settings: ObsidianVesselSettings): Promise<LabelRow[] | null> {
  const payload = {
    impulse: {
      id: `improvement-note-labels-${Date.now()}`,
      pointer: { type: 'goal_verification_label', limit: LABEL_FETCH_LIMIT },
    },
  };
  const parse = (data: any): LabelRow[] | null => {
    if (!data || !data.success || typeof data.content !== 'string') return null;
    try {
      const rows = JSON.parse(data.content);
      return Array.isArray(rows) ? (rows as LabelRow[]) : null;
    } catch {
      return null;
    }
  };
  const viaSidecar = await sidecarHttp(settings, {
    shape: 'goal_verification_label',
    path: '/v2/impulses/resolve',
    method: 'POST',
    body: payload,
  });
  if (viaSidecar && viaSidecar.ok) {
    const rows = parse(viaSidecar.body);
    if (rows) return rows;
  }
  log('label fetch unavailable (sidecar conduit unreachable or unauthorized)');
  return null;
}

async function fetchGaps(settings: ObsidianVesselSettings): Promise<GapRow[] | null> {
  // Routed by shape ownership: the sidecar asks discovery which vessel serves
  // substrateGap — no hardcoded development-vessel endpoint, no CORS (loopback).
  const viaSidecar = await sidecarHttp(settings, {
    shape: 'substrateGap',
    path: '/v2/impulses/resolve',
    method: 'POST',
    body: { impulse: { type: 'substrateGap' } },
  });
  if (viaSidecar && viaSidecar.ok) {
    const data = viaSidecar.body;
    const gaps = data && data.body && Array.isArray(data.body.gaps) ? data.body.gaps : null;
    if (gaps) return gaps as GapRow[];
  }
  log('gap fetch unavailable (sidecar unreachable or no substrateGap owner)');
  return null;
}

async function fetchGoalPathStats(settings: ObsidianVesselSettings): Promise<GoalPathStats | null> {
  const viaSidecar = await sidecarHttp(settings, { shape: 'activityExecutionTrace', path: '/v2/goal-paths/stats' });
  if (viaSidecar && viaSidecar.ok && viaSidecar.body) return viaSidecar.body as GoalPathStats;
  log('goal-path stats unavailable (sidecar conduit unreachable)');
  return null;
}

function funnelLine(traces: TraceRow[], needle: string): string {
  const rows = traces.filter((t) => (t.activity_id || '').includes(needle));
  const ok = rows.filter((t) => t.success === true).length;
  if (rows.length === 0) return '0 runs';
  return formatSuccessRate(ok, rows.length);
}

function buildNote(
  traces: TraceRow[] | null,
  labels: LabelRow[] | null,
  gaps: GapRow[] | null,
  pathStats: GoalPathStats | null,
): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push('---');
  lines.push('type: substrate-improvement');
  lines.push(`last_updated: ${now}`);
  lines.push(`window_hours: ${WINDOW_HOURS}`);
  lines.push('---');
  lines.push('');
  lines.push('# Substrate Improvement');
  lines.push('');
  lines.push(`_Pulled by the plugin at ${now}. Window: last ${WINDOW_HOURS}h._`);
  lines.push('');

  const traceCount = traces ? traces.length : 0;
  lines.push('## Data freshness');
  if (traces === null) {
    lines.push('> [!warning] Trace store unavailable\n> All trace-derived numbers below are missing, not zero.');
  } else if (traceCount < LOW_TRACE_THRESHOLD) {
    lines.push(`> [!warning] Only ${traceCount} trace(s) in the ${WINDOW_HOURS}h window\n> A known trace-persistence defect can starve the store — treat these numbers as floor estimates (under-reporting), not as low activity.`);
  } else {
    lines.push(`- ${traceCount} trace(s) in the ${WINDOW_HOURS}h window${traceCount >= TRACE_FETCH_LIMIT ? ` (capped at fetch limit ${TRACE_FETCH_LIMIT}; actual count may be higher)` : ''}. The store may still under-report while the trace-persistence defect is being fixed.`);
  }
  lines.push('');

  lines.push('## Goal reaching');
  if (traces && traceCount > 0) {
    const ok = traces.filter((t) => t.success === true).length;
    lines.push(`- Exit-status success (window traces): ${formatSuccessRate(ok, traceCount)}`);
  } else {
    lines.push('- Exit-status success: unavailable');
  }
  if (labels && labels.length > 0) {
    const achieved = labels.filter((l) => l.verdict === 'achieved').length;
    const partial = labels.filter((l) => l.verdict === 'partial').length;
    const notAchieved = labels.filter((l) => l.verdict === 'not_achieved').length;
    lines.push(`- Reach verdicts (last ${labels.length} oracle labels): achieved ${achieved} / partial ${partial} / not_achieved ${notAchieved} — reach rate ${formatSuccessRate(achieved, labels.length)}`);
    lines.push('- Hollow-completion signal: the gap between exit-status success and reach rate. Exit-status counts templates that ran; reach verdicts count goals actually achieved. A large gap means hollow completions.');
  } else {
    lines.push('- Reach verdicts: unavailable (oracle labels unreachable)');
  }
  lines.push('');

  lines.push('## Gap drain');
  if (gaps) {
    const byStatus: Record<string, number> = {};
    for (const g of gaps) {
      const s = g.status || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    const parts = Object.keys(byStatus).sort().map((s) => `${s}: ${byStatus[s]}`);
    lines.push(`- ${gaps.length} gap(s) tracked — ${parts.join(', ')}`);
  } else {
    lines.push('- Gap store unavailable (development-vessel unreachable)');
  }
  lines.push('');

  lines.push('## Drafter funnel (window)');
  if (traces && traceCount > 0) {
    lines.push(`- Drafts authored: ${funnelLine(traces, 'draft-gap-closing-activity')}`);
    lines.push(`- Draft dispatches: ${funnelLine(traces, 'dispatch-latest-auto-draft')}`);
    lines.push(`- Mitosis cutovers (drafts landing as commits): ${funnelLine(traces, 'mitosis-tick')}`);
  } else {
    lines.push('- Unavailable (no window traces)');
  }
  lines.push('');

  lines.push('## Recently exercised templates (window)');
  if (traces && traceCount > 0) {
    const byTemplate: Record<string, { runs: number; ok: number }> = {};
    for (const t of traces) {
      const id = t.activity_id || 'unknown';
      if (!byTemplate[id]) byTemplate[id] = { runs: 0, ok: 0 };
      byTemplate[id].runs += 1;
      if (t.success === true) byTemplate[id].ok += 1;
    }
    const top = Object.entries(byTemplate)
      .sort((a, b) => b[1].runs - a[1].runs)
      .slice(0, 10);
    lines.push('| Template | Runs | Success |');
    lines.push('| --- | --- | --- |');
    for (const [id, s] of top) {
      lines.push(`| \`${id}\` | ${s.runs} | ${formatSuccessRate(s.ok, s.runs)} |`);
    }
    lines.push('');
    lines.push('_Window success rates; each outcome moves the Thompson alpha/beta posterior for that template in activity-api._');
  } else {
    lines.push('- Unavailable (no window traces)');
  }
  lines.push('');

  lines.push('## Oracle corpus & goal paths');
  if (pathStats) {
    lines.push(`- Goal paths learned: ${pathStats.total_paths ?? 'unknown'} across ${pathStats.total_goals ?? 'unknown'} distinct goals`);
  } else {
    lines.push('- Goal-path stats unavailable');
  }
  if (labels) {
    const since = Date.now() - WINDOW_HOURS * 3_600_000;
    const inWindow = labels.filter((l) => l.created_at && new Date(l.created_at).getTime() >= since).length;
    const capped = labels.length >= LABEL_FETCH_LIMIT && inWindow === labels.length;
    lines.push(`- Verification labels written in window: ${inWindow}${capped ? '+' : ''} (of last ${labels.length} fetched)`);
  } else {
    lines.push('- Verification labels unavailable');
  }
  lines.push('');

  return lines.join('\n');
}

export interface ImprovementEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface SyncState {
  lastSyncedAt: string | null;
  syncedIds: string[];
}

export class ImprovementSync {
  private vaultPath: string;
  private syncDir: string;
  private state: SyncState;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.syncDir = `${vaultPath}/improvements`;
    this.state = { lastSyncedAt: null, syncedIds: [] };
    this.ensureSyncDir();
  }

  private ensureSyncDir(): void {
    try {
      const fs = require("fs") as typeof import("fs");
      if (!fs.existsSync(this.syncDir)) {
        fs.mkdirSync(this.syncDir, { recursive: true });
      }
      const stateFile = `${this.syncDir}/.sync-state.json`;
      if (fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, "utf-8");
        this.state = JSON.parse(raw) as SyncState;
      }
    } catch {
      // non-fatal: vault may not be writable yet
    }
  }

  private persistState(): void {
    try {
      const fs = require("fs") as typeof import("fs");
      fs.writeFileSync(
        `${this.syncDir}/.sync-state.json`,
        JSON.stringify(this.state, null, 2),
        "utf-8"
      );
    } catch {
      // non-fatal
    }
  }

  private entryToMarkdown(entry: ImprovementEntry): string {
    const tags = entry.tags.map((t) => `- ${t}`).join("\n");
    return [
      `# ${entry.title}`,
      ``,
      `**Created:** ${entry.createdAt}`,
      `**Updated:** ${entry.updatedAt}`,
      ``,
      `## Tags`,
      tags,
      ``,
      `## Body`,
      ``,
      entry.body,
    ].join("\n");
  }

  syncEntry(entry: ImprovementEntry): { written: boolean; path: string } {
    const fs = require("fs") as typeof import("fs");
    const safeName = entry.title.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 80);
    const filePath = `${this.syncDir}/${entry.id}-${safeName}.md`;
    const content = this.entryToMarkdown(entry);
    fs.writeFileSync(filePath, content, "utf-8");
    if (!this.state.syncedIds.includes(entry.id)) {
      this.state.syncedIds.push(entry.id);
    }
    this.state.lastSyncedAt = new Date().toISOString();
    this.persistState();
    return { written: true, path: filePath };
  }

  syncAll(entries: ImprovementEntry[]): { written: number; paths: string[] } {
    const paths: string[] = [];
    for (const entry of entries) {
      const result = this.syncEntry(entry);
      if (result.written) {
        paths.push(result.path);
      }
    }
    return { written: paths.length, paths };
  }

  getState(): SyncState {
    return { ...this.state };
  }

  listSynced(): string[] {
    return [...this.state.syncedIds];
  }
}

/**
 * Pull all improvement metrics and render/update the vault note.
 * Called by main.ts scheduleImprovementSync() on load + interval.
 */
export async function syncImprovements(
  settings: ObsidianVesselSettings,
  writeNote: NoteWriter,
): Promise<void> {
  log('sync tick');
  const [traces, labels, gaps, pathStats] = await Promise.all([
    fetchTraces(settings),
    fetchLabels(settings),
    fetchGaps(settings),
    fetchGoalPathStats(settings),
  ]);
  const content = buildNote(traces, labels, gaps, pathStats);
  await writeNote(IMPROVEMENT_NOTE_PATH, content);
  log('sync complete', {
    traces: traces ? traces.length : -1,
    labels: labels ? labels.length : -1,
    gaps: gaps ? gaps.length : -1,
  });
}
