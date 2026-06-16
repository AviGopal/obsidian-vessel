/**
 * Note Resolver - Resolve obsidian:note pointers
 *
 * Reads note content from the Obsidian vault with support for:
 * - Reading full note content
 * - Extracting specific heading sections
 * - Including/excluding frontmatter
 * - Partial reading with offset/limit
 */
import type { App, TFile, CachedMetadata } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianNotePointer,
  ResolverResult,
  ImpulseMetadata,
  NoteContent,
} from './types';

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
  // Try original path first
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof app.vault.constructor.prototype.constructor) {
    return file as TFile;
  }

  // Use Obsidian's method to get file
  const abstractFile = app.vault.getAbstractFileByPath(path);
  if (abstractFile && 'extension' in abstractFile) {
    return abstractFile as TFile;
  }

  // Try with .md extension
  const normalizedPath = normalizePath(path);
  if (normalizedPath !== path) {
    const normalizedFile = app.vault.getAbstractFileByPath(normalizedPath);
    if (normalizedFile && 'extension' in normalizedFile) {
      return normalizedFile as TFile;
    }
  }

  return null;
}

/**
 * Extract frontmatter from file cache
 */
function extractFrontmatter(
  cache: CachedMetadata | null
): Record<string, unknown> | undefined {
  if (!cache?.frontmatter) {
    return undefined;
  }

  // Remove position metadata, keep only actual frontmatter values
  const { position, ...frontmatter } = cache.frontmatter;
  return frontmatter;
}

/**
 * Extract headings from file cache
 */
function extractHeadings(cache: CachedMetadata | null): string[] {
  if (!cache?.headings) {
    return [];
  }
  return cache.headings.map((h) => h.heading);
}

/**
 * Extract links from file cache
 */
function extractLinks(cache: CachedMetadata | null): string[] {
  if (!cache?.links) {
    return [];
  }
  return cache.links.map((l) => l.link);
}

/**
 * Extract tags from file cache
 */
function extractTags(cache: CachedMetadata | null): string[] {
  const tags: string[] = [];

  // Tags in content
  if (cache?.tags) {
    tags.push(...cache.tags.map((t) => t.tag));
  }

  // Tags in frontmatter
  if (cache?.frontmatter?.tags) {
    const fmTags = cache.frontmatter.tags;
    if (Array.isArray(fmTags)) {
      tags.push(...fmTags.map((t) => (t.startsWith('#') ? t : `#${t}`)));
    } else if (typeof fmTags === 'string') {
      tags.push(fmTags.startsWith('#') ? fmTags : `#${fmTags}`);
    }
  }

  return [...new Set(tags)]; // Deduplicate
}

/**
 * Extract a specific heading section from content
 */
function extractHeadingSection(
  content: string,
  heading: string,
  cache: CachedMetadata | null
): string | null {
  if (!cache?.headings) {
    return null;
  }

  // Find the heading
  const headingIndex = cache.headings.findIndex(
    (h) => h.heading.toLowerCase() === heading.toLowerCase()
  );

  if (headingIndex === -1) {
    return null;
  }

  const targetHeading = cache.headings[headingIndex];
  const targetLevel = targetHeading.level;

  // Find the start position (beginning of heading line)
  const lines = content.split('\n');
  let startLine = -1;
  let currentPos = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineEnd = currentPos + lines[i].length;
    if (
      targetHeading.position.start.offset >= currentPos &&
      targetHeading.position.start.offset <= lineEnd
    ) {
      startLine = i;
      break;
    }
    currentPos = lineEnd + 1; // +1 for newline
  }

  if (startLine === -1) {
    return null;
  }

  // Find the next heading at the same or higher level
  let endLine = lines.length;

  for (let i = headingIndex + 1; i < cache.headings.length; i++) {
    const nextHeading = cache.headings[i];
    if (nextHeading.level <= targetLevel) {
      // Find the line number of this heading
      currentPos = 0;
      for (let j = 0; j < lines.length; j++) {
        const lineEnd = currentPos + lines[j].length;
        if (
          nextHeading.position.start.offset >= currentPos &&
          nextHeading.position.start.offset <= lineEnd
        ) {
          endLine = j;
          break;
        }
        currentPos = lineEnd + 1;
      }
      break;
    }
  }

  // Extract the section
  return lines.slice(startLine, endLine).join('\n').trim();
}

/**
 * Apply offset and limit to content
 */
function applyOffsetLimit(
  content: string,
  offset?: number,
  limit?: number
): string {
  const lines = content.split('\n');

  const startLine = offset ?? 0;
  const endLine = limit ? startLine + limit : lines.length;

  return lines.slice(startLine, endLine).join('\n');
}

/**
 * Remove frontmatter from content if it exists
 */
function removeFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return content;
  }

  // Return content after frontmatter, trimming leading whitespace
  return content.slice(endIndex + 3).trimStart();
}

/**
 * Resolve an obsidian:note pointer
 */
export async function resolveNote(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const notePointer = pointer as ObsidianNotePointer;

  // Validate required fields
  if (!notePointer.path) {
    throw new Error('obsidian:note pointer requires a path');
  }

  // Get the file
  const file = getFileByPath(app, notePointer.path);
  if (!file) {
    throw new Error(`Note not found: ${notePointer.path}`);
  }

  // Read content
  let content = await app.vault.read(file);

  // Get cached metadata
  const cache = app.metadataCache.getFileCache(file);

  // Extract metadata first (before modifying content)
  const frontmatter = extractFrontmatter(cache);
  const headings = extractHeadings(cache);
  const links = extractLinks(cache);
  const tags = extractTags(cache);

  // Handle frontmatter inclusion
  if (!notePointer.includeFrontmatter) {
    content = removeFrontmatter(content);
  }

  // Extract specific heading section if requested
  if (notePointer.heading) {
    // Need to use original content (with frontmatter) for position calculations
    const originalContent = await app.vault.read(file);
    const section = extractHeadingSection(originalContent, notePointer.heading, cache);

    if (section === null) {
      throw new Error(`Heading not found: ${notePointer.heading}`);
    }

    content = section;
  }

  // Apply offset and limit
  if (notePointer.offset !== undefined || notePointer.limit !== undefined) {
    content = applyOffsetLimit(content, notePointer.offset, notePointer.limit);
  }

  // Build note content object for summary
  const noteContent: NoteContent = {
    path: file.path,
    content,
    frontmatter,
    headings,
    links,
    tags,
    created: file.stat.ctime,
    modified: file.stat.mtime,
  };

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_note',
    summary: buildNoteSummary(noteContent, notePointer),
    rowCount: content.split('\n').length,
    availableOps: ['read', 'edit', 'link', 'search'],
    // Include note-specific metadata
    path: file.path,
    headings,
    links: links.slice(0, 10), // Limit to first 10 links
    tags,
    frontmatterKeys: frontmatter ? Object.keys(frontmatter) : [],
    created: file.stat.ctime,
    modified: file.stat.mtime,
    size: file.stat.size,
  };

  if (frontmatter) {
    metadata.frontmatter = frontmatter;
  }

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for the note
 */
function buildNoteSummary(note: NoteContent, pointer: ObsidianNotePointer): string {
  const parts: string[] = [];

  // Basic info
  parts.push(`Note: ${note.path}`);

  if (pointer.heading) {
    parts.push(`Section: ${pointer.heading}`);
  }

  // Content stats
  const lineCount = note.content.split('\n').length;
  const wordCount = note.content.split(/\s+/).filter((w) => w.length > 0).length;
  parts.push(`${lineCount} lines, ~${wordCount} words`);

  // Headings
  if (note.headings && note.headings.length > 0) {
    parts.push(`Headings: ${note.headings.slice(0, 5).join(', ')}${note.headings.length > 5 ? '...' : ''}`);
  }

  // Links
  if (note.links && note.links.length > 0) {
    parts.push(`${note.links.length} outgoing links`);
  }

  // Tags
  if (note.tags && note.tags.length > 0) {
    parts.push(`Tags: ${note.tags.join(', ')}`);
  }

  return parts.join(' | ');
}
