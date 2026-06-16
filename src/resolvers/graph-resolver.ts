/**
 * Graph Resolver - Resolve obsidian:graph_query pointers
 *
 * Performs graph traversal from a starting file with support for:
 * - Configurable traversal depth
 * - Direction filtering (incoming, outgoing, or both)
 * - Optional content summaries for nodes
 */
import type { App, TFile, CachedMetadata } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianGraphQueryPointer,
  ResolverResult,
  ImpulseMetadata,
  GraphNode,
  GraphEdge,
  GraphResult,
} from './types';

/**
 * Default values for graph query configuration
 */
const DEFAULTS = {
  depth: 1,
  direction: 'both' as const,
  includeContent: false,
};

/**
 * Normalize file path to ensure .md extension
 */
function normalizePath(path: string): string {
  if (!path.endsWith('.md')) {
    return `${path}.md`;
  }
  return path;
}

/**
 * Get file by path, with fallback to normalized path
 */
function getFileByPath(app: App, path: string): TFile | null {
  let file = app.vault.getAbstractFileByPath(path);
  if (file && 'extension' in file) {
    return file as TFile;
  }

  const normalizedPath = normalizePath(path);
  if (normalizedPath !== path) {
    file = app.vault.getAbstractFileByPath(normalizedPath);
    if (file && 'extension' in file) {
      return file as TFile;
    }
  }

  return null;
}

/**
 * Get the title from a file (first heading or filename)
 */
function getFileTitle(file: TFile, cache: CachedMetadata | null): string {
  // Try frontmatter title
  if (cache?.frontmatter?.title) {
    return String(cache.frontmatter.title);
  }

  // Try first heading
  if (cache?.headings && cache.headings.length > 0) {
    const firstHeading = cache.headings.find((h) => h.level === 1);
    if (firstHeading) {
      return firstHeading.heading;
    }
  }

  // Fall back to filename
  return file.basename;
}

/**
 * Get a content summary for a file
 */
async function getContentSummary(app: App, file: TFile, maxLength: number = 200): Promise<string> {
  try {
    const content = await app.vault.cachedRead(file);

    // Remove frontmatter
    let processedContent = content;
    if (content.startsWith('---')) {
      const endIndex = content.indexOf('---', 3);
      if (endIndex !== -1) {
        processedContent = content.slice(endIndex + 3).trim();
      }
    }

    // Get first meaningful content
    const lines = processedContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      // Skip empty lines and headings-only lines
      return trimmed.length > 0 && !trimmed.match(/^#+\s*$/);
    });

    let summary = lines.slice(0, 5).join(' ').trim();

    // Truncate if too long
    if (summary.length > maxLength) {
      summary = summary.slice(0, maxLength - 3) + '...';
    }

    return summary || '(empty)';
  } catch (e) {
    return '(unable to read)';
  }
}

/**
 * Get outgoing links from a file
 */
function getOutgoingLinks(app: App, file: TFile): string[] {
  const links: string[] = [];
  const resolvedLinks = app.metadataCache.resolvedLinks[file.path];

  if (resolvedLinks) {
    for (const targetPath of Object.keys(resolvedLinks)) {
      if (targetPath.endsWith('.md')) {
        links.push(targetPath);
      }
    }
  }

  return links;
}

/**
 * Get incoming links (backlinks) to a file
 */
function getIncomingLinks(app: App, targetPath: string): string[] {
  const links: string[] = [];
  const resolvedLinks = app.metadataCache.resolvedLinks;

  for (const sourcePath of Object.keys(resolvedLinks)) {
    if (resolvedLinks[sourcePath][targetPath]) {
      links.push(sourcePath);
    }
  }

  return links;
}

/**
 * Perform breadth-first graph traversal
 */
async function traverseGraph(
  app: App,
  centerPath: string,
  maxDepth: number,
  direction: 'incoming' | 'outgoing' | 'both',
  includeContent: boolean
): Promise<GraphResult> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();

  // Queue: [path, depth]
  const queue: Array<[string, number]> = [[centerPath, 0]];
  visited.add(centerPath);

  while (queue.length > 0) {
    const [currentPath, currentDepth] = queue.shift()!;

    // Get or create node
    const file = getFileByPath(app, currentPath);
    if (!file) {
      continue;
    }

    const cache = app.metadataCache.getFileCache(file);
    const title = getFileTitle(file, cache);

    let contentSummary: string | undefined;
    if (includeContent) {
      contentSummary = await getContentSummary(app, file);
    }

    const node: GraphNode = {
      id: currentPath,
      path: currentPath,
      title,
      depth: currentDepth,
      content: contentSummary,
    };
    nodes.set(currentPath, node);

    // Don't traverse beyond max depth
    if (currentDepth >= maxDepth) {
      continue;
    }

    // Get connected files based on direction
    const nextPaths: Array<{ path: string; type: 'link' | 'backlink' }> = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = getOutgoingLinks(app, file);
      for (const path of outgoing) {
        nextPaths.push({ path, type: 'link' });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const incoming = getIncomingLinks(app, currentPath);
      for (const path of incoming) {
        nextPaths.push({ path, type: 'backlink' });
      }
    }

    // Process connected paths
    for (const { path, type } of nextPaths) {
      // Add edge
      if (type === 'link') {
        edges.push({
          source: currentPath,
          target: path,
          type: 'link',
        });
      } else {
        edges.push({
          source: path,
          target: currentPath,
          type: 'backlink',
        });
      }

      // Queue unvisited paths
      if (!visited.has(path)) {
        visited.add(path);
        queue.push([path, currentDepth + 1]);
      }
    }
  }

  return {
    center: centerPath,
    nodes: Array.from(nodes.values()),
    edges: deduplicateEdges(edges),
    depth: maxDepth,
  };
}

/**
 * Remove duplicate edges
 */
function deduplicateEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const unique: GraphEdge[] = [];

  for (const edge of edges) {
    // Normalize edge key (regardless of type, same connection is same edge)
    const key1 = `${edge.source}|${edge.target}`;
    const key2 = `${edge.target}|${edge.source}`;

    if (!seen.has(key1) && !seen.has(key2)) {
      seen.add(key1);
      unique.push(edge);
    }
  }

  return unique;
}

/**
 * Calculate graph statistics
 */
function calculateGraphStats(result: GraphResult): {
  nodeCount: number;
  edgeCount: number;
  avgConnections: number;
  maxDepthReached: number;
  leafNodes: number;
} {
  const connectionCount = new Map<string, number>();

  for (const edge of result.edges) {
    connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
    connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
  }

  const connections = Array.from(connectionCount.values());
  const avgConnections =
    connections.length > 0
      ? connections.reduce((a, b) => a + b, 0) / connections.length
      : 0;

  const maxDepthReached = Math.max(...result.nodes.map((n) => n.depth), 0);

  // Leaf nodes have only one connection (the incoming one from their parent)
  const leafNodes = result.nodes.filter(
    (n) => n.depth === result.depth && (connectionCount.get(n.path) || 0) <= 1
  ).length;

  return {
    nodeCount: result.nodes.length,
    edgeCount: result.edges.length,
    avgConnections: Math.round(avgConnections * 10) / 10,
    maxDepthReached,
    leafNodes,
  };
}

/**
 * Resolve an obsidian:graph_query pointer
 */
export async function resolveGraphQuery(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const graphPointer = pointer as ObsidianGraphQueryPointer;

  // Validate required fields
  if (!graphPointer.centerPath) {
    throw new Error('obsidian:graph_query pointer requires a centerPath');
  }

  // Get configuration with defaults
  const depth = graphPointer.depth ?? DEFAULTS.depth;
  const direction = graphPointer.direction ?? DEFAULTS.direction;
  const includeContent = graphPointer.includeContent ?? DEFAULTS.includeContent;

  // Validate center file exists
  const centerFile = getFileByPath(app, graphPointer.centerPath);
  if (!centerFile) {
    throw new Error(`Center file not found: ${graphPointer.centerPath}`);
  }

  // Perform graph traversal
  const result = await traverseGraph(
    app,
    centerFile.path,
    depth,
    direction,
    includeContent
  );

  // Calculate statistics
  const stats = calculateGraphStats(result);

  // Build output
  const output = {
    ...result,
    stats,
  };

  // Build content as JSON
  const content = JSON.stringify(output, null, 2);

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_graph',
    summary: buildGraphSummary(result, graphPointer, stats),
    rowCount: result.nodes.length,
    columns: ['id', 'path', 'title', 'depth', 'content'],
    sample: result.nodes.slice(0, 5).map((n) => ({
      title: n.title,
      depth: n.depth,
      connections: result.edges.filter(
        (e) => e.source === n.path || e.target === n.path
      ).length,
    })),
    availableOps: ['read_node', 'expand_node', 'filter_depth', 'visualize'],
    // Graph-specific metadata
    centerPath: centerFile.path,
    centerTitle: result.nodes.find((n) => n.path === centerFile.path)?.title,
    depth,
    direction,
    includesContent: includeContent,
    nodeCount: stats.nodeCount,
    edgeCount: stats.edgeCount,
    avgConnections: stats.avgConnections,
    leafNodes: stats.leafNodes,
    maxDepthReached: stats.maxDepthReached,
  };

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for the graph
 */
function buildGraphSummary(
  result: GraphResult,
  pointer: ObsidianGraphQueryPointer,
  stats: ReturnType<typeof calculateGraphStats>
): string {
  const parts: string[] = [];

  // Center node
  const centerNode = result.nodes.find((n) => n.path === result.center);
  const centerTitle = centerNode?.title || result.center.split('/').pop();
  parts.push(`Graph from: ${centerTitle}`);

  // Configuration
  parts.push(`depth=${pointer.depth ?? DEFAULTS.depth}`);
  parts.push(`direction=${pointer.direction ?? DEFAULTS.direction}`);

  // Stats
  parts.push(`${stats.nodeCount} nodes, ${stats.edgeCount} edges`);

  // Depth distribution
  const depthCounts: Record<number, number> = {};
  for (const node of result.nodes) {
    depthCounts[node.depth] = (depthCounts[node.depth] || 0) + 1;
  }
  const depthStr = Object.entries(depthCounts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([d, c]) => `d${d}:${c}`)
    .join(' ');
  parts.push(`[${depthStr}]`);

  return parts.join(' | ');
}
