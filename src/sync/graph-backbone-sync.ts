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
 * Data paths: shaped resolves through the sidecar wherever a read shape
 * exists (dispatch pool / walk state); the composition graph is the one
 * REST-only fetch left (no compositionGraph shape yet), and its base is
 * resolved via discovery with transport-proxy rows filtered out, each
 * candidate health-probed, and the configured activityApiUrl as the last
 * fallback — no hardcoded vessel endpoints, no blind public_endpoint trust.
 * Every REST call uses Obsidian's requestUrl (the Electron renderer blocks
 * cross-origin fetch).
 */

import type { App, TFile } from 'obsidian';
import { requestUrl } from 'obsidian';
import type { ObsidianVesselSettings } from '../settings';
import { sidecarHttpAuto, sidecarResolveBody } from '../sidecar-manager';
import type { CompositionGraph } from '../api-client';

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

  async syncAll(): Promise<{ vessels: number; shapes: number; activities: number; dispatches: number }> {
    const vs = await this.syncVesselShapes();
    const acts = await this.syncComposition();
    let dispatches = 0;
    try { dispatches = await this.syncDispatches(); } catch { /* non-fatal */ }
    return { ...vs, activities: acts, dispatches };
  }

  // ── discovery-routed network (requestUrl, never fetch) ────────────────────
  private authHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.settings.apiKey ? { Authorization: `ApiKey ${this.settings.apiKey}` } : {}) };
  }
  /**
   * POST a pointer to discovery /resolve through the single sidecar conduit
   * (reaches discovery locally or over the federation overlay).
   */
  private async discoveryResolve(pointer: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const via = await sidecarHttpAuto({ service: 'discovery', method: 'POST', path: '/resolve', body: { pointer } });
    if (via && via.ok) return (via.body ?? null) as Record<string, unknown> | null;
    return null;
  }

  // ── vessel ↔ shape topology (discovery vesselRegistry) ────────────────────
  private async syncVesselShapes(): Promise<{ vessels: number; shapes: number }> {
    const j = await this.discoveryResolve({ type: 'vesselRegistry' });
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
    const edges = await this.fetchCompositionEdges();
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
      // (unchanged rendering below)
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

  /**
   * SWAP POINT: the composition graph has no read shape yet (gap
   * composition-graph-not-a-shape — substrate coax pending), so this is the
   * one REST-only fetch left in this service. When the compositionGraph shape
   * lands, replace the body of THIS function with
   * `sidecarResolveBody({ type: 'compositionGraph', limit: 400 })` and the
   * REST base machinery stops being used for activity-api entirely.
   */
  private async fetchCompositionEdges(): Promise<Array<Record<string, unknown>>> {
    return ((await sidecarResolveBody({ type: 'compositionGraph', limit: 400 }))?.edges as Array<Record<string, unknown>>) ?? [];
  }

  // ── dispatch pool + provenance-by-relevancy (goal-host walk state) ────────
  //
  // Per dispatch: a #sub/dispatch note that links into the backbone —
  //   Pool: every shape in the final pool, RANKED by relevancy = how many
  //         walk decisions consumed it as context (poolBefore membership).
  //         impulseRelevance resolves empty, so this per-dispatch consumption
  //         count is the honest relevance signal (w:N + bar, like concepts).
  //   Decisions: each step's selected activity → the shape(s) it produced
  //         (satisfier steps show the resolved shape; real templates link the
  //         backbone Activities/ note). Opening the dispatch note → local graph
  //         = its compositional context (pool ↔ activities ↔ produced shapes).
  private async syncDispatches(): Promise<number> {
    // Shaped resolves through the single sidecar conduit are the only route
    // (they cross the federation overlay — no REST base needed at all).
    const resolveShaped = async (pointer: Record<string, unknown>): Promise<Record<string, unknown> | null> =>
      sidecarResolveBody(pointer);
    const listBody = await resolveShaped({ type: 'activeDispatches' });
    if (listBody === null) return 0;
    const dispatches = ((listBody?.dispatches ?? []) as Array<Record<string, unknown>>);
    if (dispatches.length === 0) return 0;
    const recent = [...dispatches]
      .sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0))
      .slice(0, 15);
    let n = 0;
    for (const d of recent) {
      const did = String(d.dispatchId ?? '');
      if (!did) continue;
      const ws = ((await resolveShaped({ type: 'goalWalkState', dispatchId: did })) ?? {}) as Record<string, unknown>;
      const steps = (Array.isArray(ws.steps) ? ws.steps : []) as Array<Record<string, unknown>>;
      const pool = (Array.isArray(ws.poolShapes) ? ws.poolShapes : []) as string[];
      if (pool.length === 0 && steps.length === 0) continue;

      // relevancy = # decisions that had the shape available as context
      const useCount = new Map<string, number>();
      for (const st of steps) {
        for (const sh of (Array.isArray(st.poolBefore) ? st.poolBefore : []) as string[]) {
          useCount.set(sh, (useCount.get(sh) ?? 0) + 1);
        }
      }
      const maxUse = Math.max(1, ...[...useCount.values(), 1]);
      const poolRanked = [...pool].sort((a, b) => (useCount.get(b) ?? 0) - (useCount.get(a) ?? 0));
      const poolLinks = poolRanked.map((sh) => {
        const c = useCount.get(sh) ?? 0;
        const bar = '█'.repeat(Math.round((7 * c) / maxUse));
        return `- [[${ROOT}/Shapes/${slug(sh)}|${sh}]] \`w:${c}\` ${bar}`;
      });

      const decisions = steps.map((st, i) => {
        const sel = (st.selected ?? {}) as Record<string, unknown>;
        const source = String(sel.source ?? '');
        const tid = String(sel.templateId ?? '');
        const produced = (Array.isArray(st.newShapes) ? st.newShapes : []) as string[];
        const plinks = produced.map((p) => `[[${ROOT}/Shapes/${slug(p)}|${p}]]`).join(', ');
        // satisfier steps have no real activity — show the resolved shape instead
        const head = source === 'satisfier' || !tid || tid.startsWith('satisfier:')
          ? `satisfier`
          : `[[${ROOT}/Activities/${slug(cleanId(tid))}|${cleanId(tid)}]]`;
        return `${i + 1}. ${head} \`${source || 'step'}\`${plinks ? ` → ${plinks}` : ''}`;
      });

      const goal = String(d.goal ?? '');
      const reached = ws.reached === true ? 'yes' : ws.reached === false ? 'no' : 'pending';
      const status = String(ws.status ?? d.status ?? 'unknown');
      // Retention: the boredom / self-exercise loop floods activeDispatches. Only
      // persist a backbone node for dispatches worth keeping — operator-attributed,
      // or a reach that taught something (filed a gap / moved a posterior / wrote an
      // oracle label). Ephemeral self-exercise stays in the live panel and never
      // bloats the vault or the graph. (Existing nodes are left untouched here — a
      // one-time cleanup of the pre-gate backlog is a separate, confirmable step.)
      const trigger = String(d.trigger ?? '');
      const operatorAttributed = trigger === 'operator' || (typeof d.operator === 'string' && d.operator.length > 0);
      const learning = (ws.learning ?? {}) as Record<string, unknown>;
      const taughtSomething = ws.reached === true && (
        (Array.isArray(learning.gapsFiled) && learning.gapsFiled.length > 0) ||
        (learning.alphaBetaDelta != null && (!Array.isArray(learning.alphaBetaDelta) || learning.alphaBetaDelta.length > 0)) ||
        learning.oracleLabelWritten === true
      );
      if (!operatorAttributed && !taughtSomething) continue;
      // Trust tags → graph color-groups: tier = how learned the resolution was,
      // reached = outcome — the same axes the panel surfaces, expressed here as the
      // graph view's native channel (colour, which the panel deliberately reserves).
      const walkTier = typeof ws.walkTier === 'string' ? ws.walkTier : '';
      const body = [
        '---', 'tags:', '  - sub/dispatch',
        ...(walkTier ? [`  - tier/${walkTier}`] : []),
        `  - reached/${reached}`,
        'cssclasses:', '  - substrate-authored',
        `dispatch: ${did}`, `reached: ${reached}`, `status: ${status}`, '---',
        `# ${did.slice(0, 8)} · ${status}${ws.reached === true ? ' · reached' : ''}`, '',
        goal ? `> ${goal}` : '_(no goal text)_', '',
        `## Pool — ${pool.length} shapes (ranked by relevancy)`, '',
        ...(poolLinks.length ? poolLinks : ['_(empty pool)_']), '',
        `## Decisions — ${steps.length}`, '',
        ...(decisions.length ? decisions : ['_(no decisions recorded)_']), '',
        '---', '*substrate graph · dispatch pool + provenance (walk state). Relevancy = decision-consumption count.*', '',
      ].join('\n');
      await this.upsert(`${ROOT}/Dispatches/${slug(did)}.md`, body);
      n++;
    }
    return n;
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
