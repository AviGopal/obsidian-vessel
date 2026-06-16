/**
 * Impulse pointer types for the Obsidian vessel.
 *
 * Impulses are lazy-loaded pointers to content with metadata.
 * The Obsidian vessel introduces several Obsidian-specific pointer types
 * that can be resolved to provide context for activity execution.
 */

/**
 * Base impulse pointer interface.
 * All pointer types must have a `type` field for discrimination.
 */
export interface ImpulsePointer {
  type: string;
  [key: string]: unknown;
}

/**
 * Pointer to an Obsidian note by path.
 * Can optionally target a specific heading or section.
 */
export interface ObsidianNotePointer extends ImpulsePointer {
  type: 'obsidian:note';
  /** Path to the note relative to vault root */
  path: string;
  /** Optional heading to extract (e.g., "## Implementation") */
  heading?: string;
  /** Optional section identifier */
  section?: string;
  /** Include YAML frontmatter in resolved content */
  includeMetadata?: boolean;
}

/**
 * Pointer to Obsidian search results.
 * Resolves to a list of matching notes/content.
 */
export interface ObsidianSearchPointer extends ImpulsePointer {
  type: 'obsidian:search';
  /** Search query string */
  query: string;
  /** Maximum number of results */
  limit?: number;
  /** Include note content in results, not just paths */
  includeContent?: boolean;
  /** Restrict search to a specific folder */
  folder?: string;
}

/**
 * Pointer to an Obsidian canvas file.
 * Can optionally filter to specific nodes.
 */
export interface ObsidianCanvasPointer extends ImpulsePointer {
  type: 'obsidian:canvas';
  /** Path to the canvas file */
  path: string;
  /** Optional filter expression for nodes (e.g., "type:text", "color:red") */
  nodeFilter?: string;
}

/**
 * Pointer to backlinks of a specific note.
 * Useful for understanding how a note relates to others.
 */
export interface ObsidianBacklinksPointer extends ImpulsePointer {
  type: 'obsidian:backlinks';
  /** Path to the target note */
  targetPath: string;
  /** Include surrounding context for each backlink */
  includeContext?: boolean;
  /** Number of context lines to include on each side */
  contextLines?: number;
}

/**
 * Pointer to frontmatter data across notes.
 * Can filter and aggregate frontmatter values.
 */
export interface ObsidianFrontmatterPointer extends ImpulsePointer {
  type: 'obsidian:frontmatter';
  /** Optional path to a specific note */
  path?: string;
  /** Filter criteria for frontmatter fields */
  filters?: Record<string, unknown>;
  /** Group results by a frontmatter field */
  groupBy?: string;
}

/**
 * Pointer to a daily note.
 * Supports relative date references.
 */
export interface ObsidianDailyNotePointer extends ImpulsePointer {
  type: 'obsidian:daily_note';
  /** ISO date string or relative: 'today', 'yesterday', '-3d', etc. */
  date?: string;
  /** Optional section within the daily note */
  section?: string;
}

/**
 * Pointer to graph query results.
 * Explores the link graph from a center note.
 */
export interface ObsidianGraphQueryPointer extends ImpulsePointer {
  type: 'obsidian:graph_query';
  /** Path to the center note */
  centerPath: string;
  /** How many hops to traverse (default: 1) */
  depth?: number;
  /** Direction of links to follow */
  direction?: 'incoming' | 'outgoing' | 'both';
}

/**
 * Union type of all Obsidian-specific pointer types.
 */
export type ObsidianPointer =
  | ObsidianNotePointer
  | ObsidianSearchPointer
  | ObsidianCanvasPointer
  | ObsidianBacklinksPointer
  | ObsidianFrontmatterPointer
  | ObsidianDailyNotePointer
  | ObsidianGraphQueryPointer;

/**
 * Metadata about resolved impulse content.
 * Helps reasoners understand the shape and capabilities of the data.
 */
export interface ImpulseMetadata {
  /** Shape descriptor (e.g., "markdown", "structured:frontmatter", "graph:nodes") */
  shape: string;
  /** Human-readable summary of the content */
  summary: string;
  /** Number of items/rows if applicable */
  rowCount?: number;
  /** Available operations on this data */
  availableOps: string[];
  /** Activity/resolver that produced this data */
  producedBy?: string;
  /** Frontmatter from the source note */
  frontmatter?: Record<string, unknown>;
  /** Headings found in the content */
  headings?: string[];
  /** Links found in the content */
  links?: string[];
}

/**
 * Result of resolving an impulse pointer.
 */
export interface ResolverResult {
  /** Resolved content string */
  content: string;
  /** Metadata about the resolved content */
  metadata?: ImpulseMetadata;
}

/**
 * Full impulse object with pointer, budget, and state.
 */
export interface Impulse {
  /** Unique identifier */
  id: string;
  /** Pointer definition */
  pointer: ImpulsePointer;
  /** Token budget for this impulse */
  budget: number;
  /** Priority level */
  priority: 'low' | 'medium' | 'high' | 'critical';
  /** Whether content has been loaded */
  loaded: boolean;
  /** Resolved content (null if not loaded) */
  content: string | null;
  /** Resolved metadata (null if not loaded) */
  metadata: ImpulseMetadata | null;
}

/**
 * Type guard for Obsidian note pointers.
 */
export function isObsidianNotePointer(pointer: ImpulsePointer): pointer is ObsidianNotePointer {
  return pointer.type === 'obsidian:note';
}

/**
 * Type guard for Obsidian search pointers.
 */
export function isObsidianSearchPointer(pointer: ImpulsePointer): pointer is ObsidianSearchPointer {
  return pointer.type === 'obsidian:search';
}

/**
 * Type guard for Obsidian canvas pointers.
 */
export function isObsidianCanvasPointer(pointer: ImpulsePointer): pointer is ObsidianCanvasPointer {
  return pointer.type === 'obsidian:canvas';
}

/**
 * Type guard for Obsidian backlinks pointers.
 */
export function isObsidianBacklinksPointer(pointer: ImpulsePointer): pointer is ObsidianBacklinksPointer {
  return pointer.type === 'obsidian:backlinks';
}

/**
 * Type guard for Obsidian frontmatter pointers.
 */
export function isObsidianFrontmatterPointer(pointer: ImpulsePointer): pointer is ObsidianFrontmatterPointer {
  return pointer.type === 'obsidian:frontmatter';
}

/**
 * Type guard for Obsidian daily note pointers.
 */
export function isObsidianDailyNotePointer(pointer: ImpulsePointer): pointer is ObsidianDailyNotePointer {
  return pointer.type === 'obsidian:daily_note';
}

/**
 * Type guard for Obsidian graph query pointers.
 */
export function isObsidianGraphQueryPointer(pointer: ImpulsePointer): pointer is ObsidianGraphQueryPointer {
  return pointer.type === 'obsidian:graph_query';
}

/**
 * Check if a pointer is any Obsidian-specific type.
 */
export function isObsidianPointer(pointer: ImpulsePointer): pointer is ObsidianPointer {
  return pointer.type.startsWith('obsidian:');
}
