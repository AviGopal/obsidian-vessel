/**
 * Canvas Resolver - Resolve obsidian:canvas pointers
 *
 * Reads and parses Obsidian canvas files with support for:
 * - Reading full canvas structure (nodes and edges)
 * - Filtering nodes by type
 * - Including/excluding edges
 */
import type { App, TFile } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianCanvasPointer,
  ResolverResult,
  ImpulseMetadata,
} from './types';

// Import canvas types from the types directory
import type {
  CanvasData,
  CanvasNode,
  CanvasEdge,
  CanvasTextNode,
  CanvasFileNode,
  CanvasLinkNode,
  CanvasGroupNode,
} from '../types/index';

/**
 * Normalize canvas file path to ensure .canvas extension
 */
function normalizePath(path: string): string {
  if (!path.endsWith('.canvas')) {
    return `${path}.canvas`;
  }
  return path;
}

/**
 * Get canvas file by path
 */
function getCanvasFile(app: App, path: string): TFile | null {
  // Try original path first
  let file = app.vault.getAbstractFileByPath(path);
  if (file && 'extension' in file && (file as TFile).extension === 'canvas') {
    return file as TFile;
  }

  // Try with .canvas extension
  const normalizedPath = normalizePath(path);
  if (normalizedPath !== path) {
    file = app.vault.getAbstractFileByPath(normalizedPath);
    if (file && 'extension' in file && (file as TFile).extension === 'canvas') {
      return file as TFile;
    }
  }

  return null;
}

/**
 * Parse canvas JSON content
 */
function parseCanvasContent(content: string): CanvasData {
  try {
    const data = JSON.parse(content);

    // Validate basic structure
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid canvas format: not an object');
    }

    // Ensure nodes and edges are arrays
    const nodes: CanvasNode[] = Array.isArray(data.nodes) ? data.nodes : [];
    const edges: CanvasEdge[] = Array.isArray(data.edges) ? data.edges : [];

    // Validate nodes have required fields
    for (const node of nodes) {
      if (!node.id || typeof node.x !== 'number' || typeof node.y !== 'number') {
        console.warn('Invalid node in canvas:', node);
      }
    }

    return { nodes, edges };
  } catch (e) {
    throw new Error(`Failed to parse canvas content: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Filter nodes by type
 */
function filterNodes(
  nodes: CanvasNode[],
  nodeFilter?: 'text' | 'file' | 'group' | 'link'
): CanvasNode[] {
  if (!nodeFilter) {
    return nodes;
  }
  return nodes.filter((node) => node.type === nodeFilter);
}

/**
 * Get node type distribution
 */
function getNodeTypeCounts(nodes: CanvasNode[]): Record<string, number> {
  const counts: Record<string, number> = {
    text: 0,
    file: 0,
    group: 0,
    link: 0,
  };

  for (const node of nodes) {
    if (node.type in counts) {
      counts[node.type]++;
    }
  }

  return counts;
}

/**
 * Get summary info for a node
 */
function getNodeSummary(node: CanvasNode): string {
  switch (node.type) {
    case 'text':
      const textNode = node as CanvasTextNode;
      const preview = textNode.text?.slice(0, 50) || '';
      return `text: "${preview}${textNode.text && textNode.text.length > 50 ? '...' : ''}"`;
    case 'file':
      const fileNode = node as CanvasFileNode;
      return `file: ${fileNode.file}${fileNode.subpath ? fileNode.subpath : ''}`;
    case 'group':
      const groupNode = node as CanvasGroupNode;
      return `group: ${groupNode.label || '(unnamed)'}`;
    case 'link':
      const linkNode = node as CanvasLinkNode;
      return `link: ${linkNode.url}`;
    default:
      return `${node.type}: (unknown)`;
  }
}

/**
 * Build simplified canvas output structure
 */
interface CanvasOutput {
  path: string;
  nodeCount: number;
  edgeCount: number;
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    text?: string;
    file?: string;
    url?: string;
    label?: string;
    color?: string;
  }>;
  edges?: Array<{
    id: string;
    from: string;
    to: string;
    label?: string;
  }>;
}

/**
 * Convert canvas data to output format
 */
function toOutputFormat(
  path: string,
  data: CanvasData,
  includeEdges: boolean
): CanvasOutput {
  const output: CanvasOutput = {
    path,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
    nodes: data.nodes.map((node) => {
      const base = {
        id: node.id,
        type: node.type,
        position: { x: node.x, y: node.y },
        size: { width: node.width, height: node.height },
        color: node.color,
      };

      switch (node.type) {
        case 'text':
          return { ...base, text: (node as CanvasTextNode).text };
        case 'file':
          return { ...base, file: (node as CanvasFileNode).file };
        case 'link':
          return { ...base, url: (node as CanvasLinkNode).url };
        case 'group':
          return { ...base, label: (node as CanvasGroupNode).label };
        default:
          return base;
      }
    }),
  };

  if (includeEdges) {
    output.edges = data.edges.map((edge) => ({
      id: edge.id,
      from: edge.fromNode,
      to: edge.toNode,
      label: edge.label,
    }));
  }

  return output;
}

/**
 * Resolve an obsidian:canvas pointer
 */
export async function resolveCanvas(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const canvasPointer = pointer as ObsidianCanvasPointer;

  // Validate required fields
  if (!canvasPointer.path) {
    throw new Error('obsidian:canvas pointer requires a path');
  }

  // Get the canvas file
  const file = getCanvasFile(app, canvasPointer.path);
  if (!file) {
    throw new Error(`Canvas not found: ${canvasPointer.path}`);
  }

  // Read and parse canvas content
  const rawContent = await app.vault.read(file);
  const canvasData = parseCanvasContent(rawContent);

  // Apply node filter if specified
  const filteredNodes = filterNodes(canvasData.nodes, canvasPointer.nodeFilter);
  const filteredData: CanvasData = {
    nodes: filteredNodes,
    edges: canvasData.edges,
  };

  // Include edges by default
  const includeEdges = canvasPointer.includeEdges !== false;

  // If nodes were filtered, also filter edges to only include relevant ones
  if (canvasPointer.nodeFilter) {
    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    filteredData.edges = canvasData.edges.filter(
      (e) => nodeIds.has(e.fromNode) && nodeIds.has(e.toNode)
    );
  }

  // Convert to output format
  const output = toOutputFormat(file.path, filteredData, includeEdges);

  // Build content as JSON
  const content = JSON.stringify(output, null, 2);

  // Get node type distribution for original data
  const typeCounts = getNodeTypeCounts(canvasData.nodes);

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_canvas',
    summary: buildCanvasSummary(file.path, canvasData, canvasPointer),
    rowCount: output.nodes.length,
    columns: ['id', 'type', 'position', 'size', 'content'],
    sample: output.nodes.slice(0, 3).map((n) => ({
      id: n.id,
      type: n.type,
      preview: n.text?.slice(0, 50) || n.file || n.url || n.label || '',
    })),
    availableOps: ['read', 'view', 'navigate_node', 'get_connected'],
    // Canvas-specific metadata
    path: file.path,
    totalNodes: canvasData.nodes.length,
    totalEdges: canvasData.edges.length,
    filteredNodes: filteredNodes.length,
    nodeTypes: typeCounts,
    nodeFilter: canvasPointer.nodeFilter,
    includesEdges: includeEdges,
    modified: file.stat.mtime,
  };

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for the canvas
 */
function buildCanvasSummary(
  path: string,
  data: CanvasData,
  pointer: ObsidianCanvasPointer
): string {
  const parts: string[] = [];

  // Path
  const filename = path.split('/').pop() || path;
  parts.push(`Canvas: ${filename}`);

  // Node counts by type
  const typeCounts = getNodeTypeCounts(data.nodes);
  const typeInfo: string[] = [];
  if (typeCounts.text > 0) typeInfo.push(`${typeCounts.text} text`);
  if (typeCounts.file > 0) typeInfo.push(`${typeCounts.file} files`);
  if (typeCounts.group > 0) typeInfo.push(`${typeCounts.group} groups`);
  if (typeCounts.link > 0) typeInfo.push(`${typeCounts.link} links`);
  parts.push(typeInfo.join(', ') || 'empty');

  // Edge count
  if (data.edges.length > 0) {
    parts.push(`${data.edges.length} connections`);
  }

  // Filter info
  if (pointer.nodeFilter) {
    parts.push(`filtered to: ${pointer.nodeFilter}`);
  }

  return parts.join(' | ');
}
