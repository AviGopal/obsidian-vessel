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

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { ObsidianVesselSettings } from '../settings';
import { sidecarHttp } from "../sidecar-manager";

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
  // Registry rows sometimes carry shapes as a count or map — only an array is renderable.
  const shapes = Array.isArray(entry.shapes) ? entry.shapes : [];
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
    private readonly settings: ObsidianVesselSettings,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    this.log('starting', {
      endpoint: 'sidecar conduit (service:discovery)',
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
    // Single conduit: discovery is the sidecar's own fixed point, so this works
    // with zero endpoint config and no CORS (loopback).
    const viaSidecar = await sidecarHttp(this.settings, { service: 'discovery', path: '/registry/stats' });
    if (viaSidecar && viaSidecar.ok && viaSidecar.body) {
      const data = viaSidecar.body as RegistryStatsResponse;
      const list = data.vessels ?? data.registrations ?? [];
      if (list.length > 0) return list;
    }
    this.log('sidecar conduit yielded no vessels');
    return [];
  }

  private async writeNote(notePath: string, content: string): Promise<void> {
    const folderPath = notePath.substring(0, notePath.lastIndexOf('/'));
    await ensureFolderExists(this.app, folderPath);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing) {
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
