/**
 * GraphBackboneSyncService
 *
 * Projects the substrate's STRUCTURE into vault notes so Obsidian's NATIVE
 * graph view renders it — no bespoke canvas. Nodes are notes, edges are
 * wikilinks, node type is a tag (for graph color-groups), node size is the
 * link count (load-bearing shapes/vessels grow automatically).
 *
 * Three note families under `Substrate/Graph/`:
 *   Vessels/   #sub/vessel   — one per registered vessel, links to shapes it serves
 *   Shapes/    #sub/shape    — one per shape, links to serving vessels (backlinks)
 *   Activities/#sub/activity — one per composing activity, parent→child edges (weight)
 *
 * All data flows through discovery (the one fixed point): vesselRegistry for the
 * vessel↔shape topology, and the activity-api base is resolved via discovery
 * (vesselCapability for activityTemplate → public_endpoint) before reading its
 * composition graph — no hardcoded vessel endpoints. Every network call uses
 * Obsidian's requestUrl (the Electron renderer blocks cross-origin fetch).
 */

import type { App, TFile } from 'obsidian';
import { requestUrl } from 'obsidian';
import type { ObsidianVesselSettings } from '../settings';

const ROOT = 'Substrate/Graph';

/** Filesystem/wikilink-safe slug. */
function slug(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'unknown';
}
/** Strip SurrealDB angle-bracket / table-prefix noise from an activity id for display. */
function cleanId(id: string): string {
  return String(id).replace(/^activity:/, '').replace(/[⟨⟩]/g, '').slice(0, 100);
}

export class GraphBackboneSyncService {
  private timer: number | null = null;

  constructor(
    private app: App,
    private settings: ObsidianVesselSettings,
  ) {}

  async start(): Promise<void> {
    await this.syncAll();
    const mins = Math.max(5, this.settings.syncIntervalMinutes || 15);
    this.timer = window.setInterval(() => void this.syncAll(), mins * 60_000);
  }
  stop(): void {
    if (this.timer !== null) { window.clearInterval(this.timer); this.timer = null; }
  }

  async syncAll(): Promise<{ vessels: number; shapes: number; activities: number }> {
    const vs = await this.syncVesselShapes();
    const acts = await this.syncComposition();
    return { ...vs, activities: acts };
  }

  // ── discovery-routed network (requestUrl, never fetch) ────────────────────
  private authHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.settings.apiKey ? { Authorization: `ApiKey ${this.settings.apiKey}` } : {}) };
  }
  private async postJson(url: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const r = await requestUrl({ url, method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body), throw: false });
      if (r.status < 200 || r.status >= 300) return null;
      return r.json as Record<string, unknown>;
    } catch { return null; }
  }
  /** Resolve a shape's host-reachable base URL via discovery (prefers public_endpoint). */
  private async resolveVesselBase(shape: string): Promise<string | null> {
    const disco = (this.settings.discoveryVesselEndpoint || '').replace(/\/+$/, '');
    if (!disco) return null;
    const j = await this.postJson(`${disco}/resolve`, { pointer: { type: 'vesselCapability', shape } });
    const vessels = ((j?.content as Record<string, unknown> | undefined)?.vessels ?? []) as Array<Record<string, unknown>>;
    const v = vessels[0];
    if (!v) return null;
    return String(v.public_endpoint || v.endpoint || '').replace(/\/+$/, '') || null;
  }

  // ── vessel ↔ shape topology (discovery vesselRegistry) ────────────────────
  private async syncVesselShapes(): Promise<{ vessels: number; shapes: number }> {
    const disco = (this.settings.discoveryVesselEndpoint || '').replace(/\/+$/, '');
    if (!disco) return { vessels: 0, shapes: 0 };
    const j = await this.postJson(`${disco}/resolve`, { pointer: { type: 'vesselRegistry' } });
    const content = (j?.content ?? {}) as Record<string, unknown>;
    const vessels = ((content.vessels ?? []) as Array<Record<string, unknown>>).filter(Boolean);
    if (vessels.length === 0) return { vessels: 0, shapes: 0 };

    // shape -> set of serving vessel ids (for the shape notes / backbone)
    const shapeToVessels = new Map<string, Set<string>>();
    for (const v of vessels) {
      const vid = String(v.vesselId || v.vessel_id || 'vessel');
      const shapes = (Array.isArray(v.shapes) ? v.shapes : []) as string[];
      const links = shapes.map((s) => `- [[${ROOT}/Shapes/${slug(s)}|${s}]]`);
      const body = [
        '---', 'tags:', '  - sub/vessel', 'cssclasses:', '  - substrate-authored', '---',
        `# ${vid}`, '', `Vessel node · serves **${shapes.length}** shapes.`, '',
        '## Serves', '', ...(links.length ? links : ['_(no shapes advertised)_']), '',
        '---', '*substrate graph backbone · vessel↔shape topology (discovery vesselRegistry)*', '',
      ].join('\n');
      await this.upsert(`${ROOT}/Vessels/${slug(vid)}.md`, body);
      for (const s of shapes) {
        if (!shapeToVessels.has(s)) shapeToVessels.set(s, new Set());
        shapeToVessels.get(s)!.add(vid);
      }
    }
    for (const [shape, servers] of shapeToVessels) {
      const links = [...servers].map((vid) => `- [[${ROOT}/Vessels/${slug(vid)}|${vid}]]`);
      const body = [
        '---', 'tags:', '  - sub/shape', 'cssclasses:', '  - substrate-authored', '---',
        `# ${shape}`, '', `Shape node · served by **${servers.size}** vessel(s).`, '',
        '## Served by', '', ...links, '',
        '---', '*substrate graph backbone · shape node*', '',
      ].join('\n');
      await this.upsert(`${ROOT}/Shapes/${slug(shape)}.md`, body);
    }
    return { vessels: vessels.length, shapes: shapeToVessels.size };
  }

  // ── activity ↔ activity composition edges (activity-api, base via discovery) ─
  private async syncComposition(): Promise<number> {
    const base = await this.resolveVesselBase('activityTemplate');
    if (!base) return 0;
    let edges: Array<Record<string, unknown>> = [];
    try {
      const r = await requestUrl({ url: `${base}/v2/activities/composition/graph?limit=400`, method: 'GET', headers: this.authHeaders(), throw: false });
      if (r.status >= 200 && r.status < 300) {
        edges = ((r.json as Record<string, unknown>)?.edges ?? []) as Array<Record<string, unknown>>;
      }
    } catch { return 0; }
    if (edges.length === 0) return 0;

    // group edges by parent activity → its children (with weight)
    const children = new Map<string, Array<{ child: string; weight: number; genuine: boolean }>>();
    const nodes = new Set<string>();
    for (const e of edges) {
      const parent = String(e.parent_activity_id || '');
      const child = String(e.child_activity_id || '');
      if (!parent || !child) continue;
      nodes.add(parent); nodes.add(child);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push({ child, weight: Number(e.weight ?? 1), genuine: e.genuine === true || e.edge_kind === 'genuine' });
    }
    for (const id of nodes) {
      const outs = children.get(id) ?? [];
      const links = outs.map((o) => `- → [[${ROOT}/Activities/${slug(cleanId(o.child))}|${cleanId(o.child)}]] \`w:${o.weight}\`${o.genuine ? ' ✓' : ''}`);
      const body = [
        '---', 'tags:', '  - sub/activity', 'cssclasses:', '  - substrate-authored', '---',
        `# ${cleanId(id)}`, '', `Activity node · composes into **${outs.length}** downstream activit${outs.length === 1 ? 'y' : 'ies'}.`, '',
        '## Composes into', '', ...(links.length ? links : ['_(terminal — no downstream composition recorded)_']), '',
        '---', '*substrate graph backbone · composition edge (activity→activity, weight = success count)*', '',
      ].join('\n');
      await this.upsert(`${ROOT}/Activities/${slug(cleanId(id))}.md`, body);
    }
    return nodes.size;
  }

  // ── vault write helpers ───────────────────────────────────────────────────
  private async upsert(path: string, content: string): Promise<void> {
    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) { await this.app.vault.modify(existing as TFile, content); }
    else { await this.app.vault.create(path, content); }
  }
  private async ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch { /* exists */ }
      }
    }
  }
}
