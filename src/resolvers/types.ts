/**
 * Types for Obsidian Vessel Impulse Resolvers
 */
import type { App, TFile } from 'obsidian';

// =============================================================================
// IMPULSE METADATA
// =============================================================================

/**
 * Impulse metadata - structured information about pointer content
 */
export interface ImpulseMetadata {
  /** Content shape identifier */
  shape?: string;
  /** Number of items/rows in the content */
  rowCount?: number;
  /** Field names for tabular data */
  columns?: string[];
  /** First few items for LLM context */
  sample?: unknown[];
  /** Human-readable description of the content */
  summary?: string;
  /** Operations that can be applied to this impulse */
  availableOps?: string[];
  /** Execution/activity that produced this impulse */
  producedBy?: string;
  /** Extensible for domain-specific metadata */
  [key: string]: unknown;
}

/**
 * Resolver result type - resolvers return content with optional metadata
 */
export type ResolverResult = string | { content: string; metadata?: ImpulseMetadata };

// =============================================================================
// OBSIDIAN-SPECIFIC IMPULSE POINTERS
// =============================================================================

/**
 * Pointer to an Obsidian note
 */
export interface ObsidianNotePointer {
  type: 'obsidian:note';
  /** Path to the note (relative to vault, .md extension optional) */
  path: string;
  /** Extract specific heading section (optional) */
  heading?: string;
  /** Include frontmatter in content (default: false) */
  includeFrontmatter?: boolean;
  /** Line offset for partial reading */
  offset?: number;
  /** Line limit for partial reading */
  limit?: number;
}

/**
 * Pointer to search Obsidian vault
 */
export interface ObsidianSearchPointer {
  type: 'obsidian:search';
  /** Search query string */
  query: string;
  /** Folder to search in (optional, searches entire vault if not specified) */
  folder?: string;
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Include content snippets in results (default: false) */
  includeSnippets?: boolean;
  /** Snippet length around matches (default: 100 chars) */
  snippetLength?: number;
}

/**
 * Pointer to an Obsidian canvas file
 */
export interface ObsidianCanvasPointer {
  type: 'obsidian:canvas';
  /** Path to the canvas file */
  path: string;
  /** Filter nodes by type (optional) */
  nodeFilter?: 'text' | 'file' | 'group' | 'link';
  /** Include edge metadata (default: true) */
  includeEdges?: boolean;
}

/**
 * Pointer to get backlinks for a file
 */
export interface ObsidianBacklinksPointer {
  type: 'obsidian:backlinks';
  /** Path to the file to get backlinks for */
  path: string;
  /** Include context lines around links (default: false) */
  includeContext?: boolean;
  /** Number of context lines to include (default: 2) */
  contextLines?: number;
  /** Maximum number of backlinks (default: 50) */
  limit?: number;
}

/**
 * Pointer to frontmatter data
 */
export interface ObsidianFrontmatterPointer {
  type: 'obsidian:frontmatter';
  /** Path to specific file (optional) */
  path?: string;
  /** Filter by frontmatter keys/values */
  filters?: Record<string, string | string[] | number | boolean>;
  /** Group results by a frontmatter key */
  groupBy?: string;
  /** Limit results when searching (default: 100) */
  limit?: number;
}

/**
 * Pointer to a daily note
 */
export interface ObsidianDailyNotePointer {
  type: 'obsidian:daily_note';
  /** Date in ISO format (YYYY-MM-DD) or relative ('today', 'yesterday', '-3d', etc.) */
  date: string;
  /** Extract specific section by heading */
  section?: string;
  /** Include frontmatter (default: false) */
  includeFrontmatter?: boolean;
}

/**
 * Pointer to graph query (link exploration)
 */
export interface ObsidianGraphQueryPointer {
  type: 'obsidian:graph_query';
  /** Starting file path for graph traversal */
  centerPath: string;
  /** Maximum link depth (default: 1) */
  depth?: number;
  /** Direction of links to follow */
  direction?: 'incoming' | 'outgoing' | 'both';
  /** Include node content summaries (default: false) */
  includeContent?: boolean;
}

/**
 * Union of all Obsidian impulse pointer types
 */
export interface ObsidianConceptViewPointer {
  type: 'obsidian:concept_view';
  /** Concept id (short form or full `concept:<short>` form). */
  concept_id: string;
  /** Include neighbors in the rendered output (default: true). */
  include_neighbors?: boolean;
}

export interface ObsidianConceptWritebackPointer {
  type: 'obsidian:concept_writeback';
  /** Concept id to materialize/refresh in the vault. */
  concept_id: string;
  /**
   * If true and the concept does not yet exist in concept-db, mint it
   * from this payload. Otherwise the resolver only refreshes the
   * vault note from the existing concept.
   */
  create_if_missing?: boolean;
  shape?: string;
  source_type?: string;
  summary?: string;
  content?: string;
}

export type ImpulsePointer =
  | ObsidianNotePointer
  | ObsidianSearchPointer
  | ObsidianCanvasPointer
  | ObsidianBacklinksPointer
  | ObsidianFrontmatterPointer
  | ObsidianDailyNotePointer
  | ObsidianGraphQueryPointer
  | ObsidianConceptViewPointer
  | ObsidianConceptWritebackPointer;

// =============================================================================
// RESOLVER RESULT TYPES
// =============================================================================

/**
 * Note content with metadata
 */
export interface NoteContent {
  path: string;
  content: string;
  frontmatter?: Record<string, unknown>;
  headings?: string[];
  links?: string[];
  tags?: string[];
  created?: number;
  modified?: number;
}

/**
 * Search result entry
 */
export interface SearchResult {
  path: string;
  matches: number;
  snippets?: string[];
  score?: number;
}

/**
 * Backlink entry
 */
export interface BacklinkEntry {
  /** Path of the file containing the link */
  sourcePath: string;
  /** Line number of the link */
  line?: number;
  /** Context text around the link */
  context?: string;
  /** Position in the file */
  position?: { start: number; end: number };
}

/**
 * Frontmatter entry for a file
 */
export interface FrontmatterEntry {
  path: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Graph node for visualization
 */
export interface GraphNode {
  id: string;
  path: string;
  title: string;
  depth: number;
  content?: string;
}

/**
 * Graph edge for visualization
 */
export interface GraphEdge {
  source: string;
  target: string;
  type: 'link' | 'backlink';
}

/**
 * Graph query result
 */
export interface GraphResult {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  depth: number;
}

// =============================================================================
// RESOLVER FUNCTION TYPE
// =============================================================================

/**
 * Resolver function signature
 */
export type ResolverFunction = (pointer: ImpulsePointer, app: App) => Promise<ResolverResult>;

// =============================================================================
// HELPER TYPES
// =============================================================================

/**
 * Obsidian file with resolved content
 */
export interface ResolvedFile {
  file: TFile;
  content: string;
  frontmatter?: Record<string, unknown>;
}
