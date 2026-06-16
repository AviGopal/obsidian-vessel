/**
 * VesselSyncService
 *
 * Queries the discovery-vessel registry and writes one vault note per
 * registered vessel under `vesselFolder`. The discovery-vessel is
 * reached via `discoveryVesselEndpoint` (default http://127.0.0.1:8100).
 *
 * Probe order:
 *   1. GET {endpoint}/registry/stats  — returns summary + vessel list
 *   2. GET {endpoint}/shapes           — fallback shape list per vessel
 *
 * Runs on the same interval cadence as ActivityFamilySyncService.
 */

import type { App } from 'obsidian';
import type { MetabobVesselSettings } from '../settings';

interface DiscoveryVesselEntry {
  vessel_id: string;
  vessel_name?: string;
  status?: string;
  shapes?: string[];
  shapes_count?: number;
  last_heartbeat?: string;
  resolve_endpoint?: string;
  registered_at?: string;
}

interface RegistryStatsResponse {
  vessels?: DiscoveryVesselEntry[];
  registrations?: DiscoveryVesselEntry[];
  total?: number;
  total_vessels?: number;
}

function humanizeName(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function buildVesselNote(entry: DiscoveryVesselEntry, now: string): string {
  const id = entry.vessel_id;
  const name = entry.vessel_name || humanizeName(id);
  const status = entry.status || 'unknown';
  const shapes = entry.shapes ?? [];
  const shapesCount = entry.shapes_count ?? shapes.length;
  const lastHeartbeat = entry.last_heartbeat ?? entry.registered_at;

  const fm = [
    '---',
    `vessel_id: ${id}`,
    `vessel_name: "${name}"`,
    `status: ${status}`,
    `shapes_count: ${shapesCount}`,
    `last_heartbeat: ${lastHeartbeat ?? 'unknown'}`,
    `last_updated: ${now}`,
    'type: vessel',
    '---',
  ].join('\n');

  const statusLine = `${status} · last seen: ${relativeTime(lastHeartbeat)}`;

  const shapesLines =
    shapes.length > 0
      ? shapes.map((s) => `- \`${s}\``).join('\n')
      : '_No shapes advertised_';

  const body = [
    fm,
    '',
    `# ${name}`,
    '',
    '## Status',
    statusLine,
    '',
    '## Shapes',
    shapesLines,
    '',
  ].join('\n');

  return body.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export class VesselSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly log = (msg: string, data?: Record<string, unknown>) => {
    const tail = data ? ` ${JSON.stringify(data)}` : '';
    console.log(`[VesselSync] ${msg}${tail}`);
  };

  constructor(
    private readonly app: App,
    private readonly settings: MetabobVesselSettings,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.log('starting', {
      endpoint: this.settings.discoveryVesselEndpoint,
      folder: this.settings.vesselFolder,
    });
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
    const vessels = await this.fetchVessels();
    if (!vessels.length) {
      this.log('no vessels returned');
      return;
    }
    this.log('fetched vessels', { count: vessels.length });
    for (const v of vessels) {
      const content = buildVesselNote(v, now);
      const safeId = v.vessel_id.replace(/[\/\\:*?"<>|]/g, '-');
      const notePath = `${this.settings.vesselFolder}/${humanizeName(safeId)}.md`;
      await this.writeNote(notePath, content);
    }
    this.log('sync complete', { count: vessels.length });
  }

  private async fetchVessels(): Promise<DiscoveryVesselEntry[]> {
    const base = this.settings.discoveryVesselEndpoint.replace(/\/$/, '');
    const apiKey = this.settings.apiKey;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['Authorization'] = `ApiKey ${apiKey}`;

    // Strategy 1: GET /registry/stats
    try {
      const resp = await fetch(`${base}/registry/stats`, { headers });
      if (resp.ok) {
        const data: RegistryStatsResponse = await resp.json();
        const list = data.vessels ?? data.registrations ?? [];
        if (list.length > 0) return list;
      }
    } catch (err) {
      this.log('registry/stats failed', { error: String(err) });
    }

    // Strategy 2: GET /shapes — returns per-vessel shape map
    try {
      const resp = await fetch(`${base}/shapes`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        // shapes endpoint may return { vessels: [...] } or { shapes: { vesselId: [...] } }
        if (Array.isArray(data.vessels)) return data.vessels;
        if (data.shapes && typeof data.shapes === 'object') {
          return Object.entries(data.shapes as Record<string, string[]>).map(
            ([vessel_id, shapes]) => ({ vessel_id, shapes }),
          );
        }
      }
    } catch (err) {
      this.log('shapes fallback failed', { error: String(err) });
    }

    // Strategy 3: GET /vessels (legacy)
    try {
      const resp = await fetch(`${base}/vessels`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.vessels)) return data.vessels;
      }
    } catch (err) {
      this.log('vessels fallback failed', { error: String(err) });
    }

    return [];
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
