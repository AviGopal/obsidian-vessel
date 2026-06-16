/**
 * Concept Canvas Builder
 *
 * Builds an Obsidian `.canvas` file showing a concept's local
 * neighborhood (N hops). Reuses CanvasManager for write semantics.
 *
 * Modeled on ExecutionCanvasBuilder. Layout is simple radial — the
 * focal concept sits at the origin, immediate neighbors are placed on
 * a ring, and second-hop neighbors (if requested) are placed on an
 * outer ring around each first-hop neighbor.
 */

import type { App, TFile } from 'obsidian';
import type { CanvasData, CanvasNode, CanvasEdge } from '../types/canvas';
import type { MetabobVesselSettings } from '../settings';
import type {
  ConceptDbClient,
  ConceptRecord,
  ConceptNeighbor,
} from '../concept-db-client';
import { shortConceptId } from '../concept-db-client';
import { conceptNotePath } from '../formatters/concept-formatter';
import { CanvasManager } from './canvas-manager';

/**
 * Edge-type → Obsidian canvas color (1=red, 2=orange, 3=yellow,
 * 4=green, 5=cyan, 6=purple). Unknown edge types fall through to '5'.
 */
const EDGE_TYPE_COLORS: Record<string, string> = {
  derived_from: '4',
  related_to: '5',
  resolves_to: '6',
  description_of: '3',
  example_of: '2',
  contradicts: '1',
  sequence_next: '5',
  sequence_prev: '5',
};

function edgeColor(t: string): string {
  return EDGE_TYPE_COLORS[t] || '5';
}

export interface ConceptCanvasOptions {
  /** Neighborhood radius in hops. 1 = immediate neighbors only. */
  hops?: number;
  /** Maximum nodes to include (default 50). */
  maxNodes?: number;
}

export class ConceptCanvasBuilder {
  private canvasManager: CanvasManager;

  constructor(
    private app: App,
    private settings: MetabobVesselSettings,
  ) {
    this.canvasManager = new CanvasManager(app, settings);
  }

  /**
   * Build (and write) a canvas for `conceptId`. Returns the
   * vault-relative path the canvas was written to.
   */
  async buildConceptCanvas(
    client: ConceptDbClient,
    conceptId: string,
    options: ConceptCanvasOptions = {},
  ): Promise<string> {
    const hops = Math.max(1, Math.min(3, options.hops ?? 2));
    const maxNodes = Math.max(5, options.maxNodes ?? 50);

    const center = await client.getConcept(conceptId);
    if (!center) throw new Error(`Concept not found: ${conceptId}`);

    const visited = new Map<string, ConceptRecord | ConceptNeighbor>();
    visited.set(center.id, center);

    type EdgeInfo = { from: string; to: string; type: string };
    const edges: EdgeInfo[] = [];

    // BFS layers: layer 0 = [center]; layer k = neighbors of layer k-1
    let frontier: string[] = [center.id];
    for (let depth = 0; depth < hops && visited.size < maxNodes; depth++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        if (visited.size >= maxNodes) break;
        let neighbors: ConceptNeighbor[] = [];
        try {
          neighbors = await client.getNeighbors(id, 'both', undefined, 20);
        } catch {
          neighbors = [];
        }
        for (const n of neighbors) {
          if (visited.size >= maxNodes) break;
          if (!visited.has(n.id)) {
            visited.set(n.id, n);
            nextFrontier.push(n.id);
          }
          edges.push({ from: id, to: n.id, type: n.edge_type || 'related_to' });
        }
      }
      frontier = nextFrontier;
    }

    const canvas = this.layoutCanvas(center, visited, edges);
    const name = `concept-${shortConceptId(center.id)}`;
    await this.canvasManager.createOrUpdateCanvas(name, canvas);

    const folder = this.settings.canvasFolder || 'Metabob/Canvases';
    return `${folder}/${name}.canvas`;
  }

  /**
   * Position nodes radially around the focal concept.
   */
  private layoutCanvas(
    center: ConceptRecord,
    visited: Map<string, ConceptRecord | ConceptNeighbor>,
    edges: Array<{ from: string; to: string; type: string }>,
  ): CanvasData {
    const nodeWidth = 280;
    const nodeHeight = 140;
    const radius = 480;

    const allIds = Array.from(visited.keys()).filter((id) => id !== center.id);
    const nodes: CanvasNode[] = [];

    // Center node
    nodes.push(this.makeNode(center, 0, 0, nodeWidth, nodeHeight, '4'));

    // Place each non-center node on a circle
    const angleStep = allIds.length > 0 ? (2 * Math.PI) / allIds.length : 0;
    for (let i = 0; i < allIds.length; i++) {
      const id = allIds[i];
      const angle = i * angleStep;
      const x = Math.round(Math.cos(angle) * radius);
      const y = Math.round(Math.sin(angle) * radius);
      const v = visited.get(id)!;
      // Edge type for color: find any edge into this node
      const incoming = edges.find((e) => e.to === id);
      const color = incoming ? edgeColor(incoming.type) : '5';
      nodes.push(this.makeNode(v, x, y, nodeWidth, nodeHeight, color));
    }

    const canvasEdges: CanvasEdge[] = edges.map((e, idx) => ({
      id: `edge-${idx}`,
      fromNode: shortConceptId(e.from),
      toNode: shortConceptId(e.to),
      fromSide: 'right',
      toSide: 'left',
      toEnd: 'arrow',
      label: e.type,
      color: edgeColor(e.type),
    }));

    return { nodes, edges: canvasEdges };
  }

  private makeNode(
    c: ConceptRecord | ConceptNeighbor,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
  ): CanvasNode {
    const short = shortConceptId(c.id);
    // Try to reference an existing vault note (file node); if we cannot
    // confidently derive a path, fall back to a text node.
    const sourceType = (c as ConceptRecord).source_type || 'uncategorized';
    const shape = c.shape || sourceType;
    const slug = shape.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const candidatePath = `${this.settings.conceptDbSyncRoot}/${sourceType}/${short}__${slug}.md`;

    const existing = this.app.vault.getAbstractFileByPath(candidatePath);
    if (existing && 'extension' in existing) {
      return {
        id: short,
        type: 'file',
        x,
        y,
        width,
        height,
        file: candidatePath,
        color,
      };
    }

    const summary = (c.summary || c.shape || short).slice(0, 200);
    return {
      id: short,
      type: 'text',
      x,
      y,
      width,
      height,
      text: `**${shape}**\n\n${summary}\n\n_${short}_`,
      color,
    };
  }
}
