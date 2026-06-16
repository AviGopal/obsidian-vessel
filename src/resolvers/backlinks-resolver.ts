/**
 * Backlinks Resolver - Resolve obsidian:backlinks pointers
 *
 * Gets backlinks (incoming links) to a file using Obsidian's metadata cache with support for:
 * - Finding all files that link to a target file
 * - Including context lines around links
 * - Limiting the number of results
 */
import type { App, TFile, CachedMetadata, Pos } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianBacklinksPointer,
  ResolverResult,
  ImpulseMetadata,
  BacklinkEntry,
} from './types';

/**
 * Default values for backlinks configuration
 */
const DEFAULTS = {
  limit: 50,
  contextLines: 2,
  includeContext: false,
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
  // Try original path first
  let file = app.vault.getAbstractFileByPath(path);
  if (file && 'extension' in file) {
    return file as TFile;
  }

  // Try with .md extension
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
 * Get the line number for a position in content
 */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * Extract context lines around a position
 */
function extractContext(
  content: string,
  offset: number,
  contextLines: number
): string {
  const lines = content.split('\n');
  const lineIndex = getLineNumber(content, offset) - 1; // Convert to 0-based

  // Calculate start and end line indices
  const startLine = Math.max(0, lineIndex - contextLines);
  const endLine = Math.min(lines.length - 1, lineIndex + contextLines);

  // Extract lines
  const contextArray = lines.slice(startLine, endLine + 1);

  // Join with line numbers
  return contextArray
    .map((line, idx) => {
      const actualLineNum = startLine + idx + 1;
      const marker = actualLineNum === lineIndex + 1 ? '>' : ' ';
      return `${marker} ${actualLineNum}: ${line}`;
    })
    .join('\n');
}

/**
 * Get backlinks for a file using the metadata cache
 */
async function getBacklinksForFile(
  app: App,
  targetFile: TFile,
  includeContext: boolean,
  contextLines: number,
  limit: number
): Promise<BacklinkEntry[]> {
  const backlinks: BacklinkEntry[] = [];
  const targetPath = targetFile.path;
  const targetBasename = targetFile.basename;

  // Resolve backlinks using the metadata cache's resolved links
  // This includes both [[wiki links]] and markdown [links](path.md)
  const resolvedLinks = app.metadataCache.resolvedLinks;

  for (const sourcePath of Object.keys(resolvedLinks)) {
    // Check if this file links to our target
    const links = resolvedLinks[sourcePath];
    if (links && links[targetPath]) {
      // This file links to our target
      const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
      if (!sourceFile || !('extension' in sourceFile)) {
        continue;
      }

      // Get the cached metadata for the source file
      const cache = app.metadataCache.getFileCache(sourceFile as TFile);
      if (!cache) {
        // Add basic backlink without position info
        backlinks.push({
          sourcePath,
        });
        continue;
      }

      // Find the specific link positions
      const linkPositions: Pos[] = [];

      // Check wiki-style links
      if (cache.links) {
        for (const link of cache.links) {
          // Check if this link points to our target
          // Links can be bare name, relative path, or full path
          if (
            link.link === targetBasename ||
            link.link === targetPath ||
            link.link === targetPath.replace('.md', '') ||
            link.link.endsWith('/' + targetBasename) ||
            link.link.endsWith('/' + targetFile.name)
          ) {
            linkPositions.push(link.position);
          }
        }
      }

      // Check embed links
      if (cache.embeds) {
        for (const embed of cache.embeds) {
          if (
            embed.link === targetBasename ||
            embed.link === targetPath ||
            embed.link === targetPath.replace('.md', '') ||
            embed.link.endsWith('/' + targetBasename) ||
            embed.link.endsWith('/' + targetFile.name)
          ) {
            linkPositions.push(embed.position);
          }
        }
      }

      // If we found specific positions, add entries for each
      if (linkPositions.length > 0) {
        let content: string | null = null;
        if (includeContext) {
          try {
            content = await app.vault.cachedRead(sourceFile as TFile);
          } catch (e) {
            // Skip context on read error
          }
        }

        for (const pos of linkPositions) {
          const entry: BacklinkEntry = {
            sourcePath,
            line: pos.start.line + 1, // Convert to 1-based
            position: {
              start: pos.start.offset,
              end: pos.end.offset,
            },
          };

          if (content && includeContext) {
            entry.context = extractContext(content, pos.start.offset, contextLines);
          }

          backlinks.push(entry);

          if (backlinks.length >= limit) {
            return backlinks;
          }
        }
      } else {
        // No specific positions found, add basic entry
        backlinks.push({
          sourcePath,
        });
      }

      if (backlinks.length >= limit) {
        break;
      }
    }
  }

  return backlinks;
}

/**
 * Resolve an obsidian:backlinks pointer
 */
export async function resolveBacklinks(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const backlinksPointer = pointer as ObsidianBacklinksPointer;

  // Validate required fields
  if (!backlinksPointer.path) {
    throw new Error('obsidian:backlinks pointer requires a path');
  }

  // Get configuration with defaults
  const limit = backlinksPointer.limit ?? DEFAULTS.limit;
  const includeContext = backlinksPointer.includeContext ?? DEFAULTS.includeContext;
  const contextLines = backlinksPointer.contextLines ?? DEFAULTS.contextLines;

  // Get the target file
  const targetFile = getFileByPath(app, backlinksPointer.path);
  if (!targetFile) {
    throw new Error(`File not found: ${backlinksPointer.path}`);
  }

  // Get backlinks
  const backlinks = await getBacklinksForFile(
    app,
    targetFile,
    includeContext,
    contextLines,
    limit
  );

  // Group backlinks by source file
  const groupedBacklinks: Record<string, BacklinkEntry[]> = {};
  for (const backlink of backlinks) {
    if (!groupedBacklinks[backlink.sourcePath]) {
      groupedBacklinks[backlink.sourcePath] = [];
    }
    groupedBacklinks[backlink.sourcePath].push(backlink);
  }

  // Build output structure
  const output = {
    targetPath: targetFile.path,
    totalBacklinks: backlinks.length,
    uniqueFiles: Object.keys(groupedBacklinks).length,
    backlinks: backlinks,
    byFile: groupedBacklinks,
  };

  // Build content as JSON
  const content = JSON.stringify(output, null, 2);

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_backlinks',
    summary: buildBacklinksSummary(targetFile.path, backlinks, groupedBacklinks),
    rowCount: backlinks.length,
    columns: ['sourcePath', 'line', 'context'],
    sample: backlinks.slice(0, 3).map((b) => ({
      source: b.sourcePath.split('/').pop(),
      line: b.line,
    })),
    availableOps: ['read_source', 'navigate_to', 'follow_link'],
    // Backlinks-specific metadata
    targetPath: targetFile.path,
    totalBacklinks: backlinks.length,
    uniqueSourceFiles: Object.keys(groupedBacklinks).length,
    hasContext: includeContext,
    limitApplied: backlinks.length === limit,
    sourceFiles: Object.keys(groupedBacklinks).slice(0, 10),
  };

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for backlinks
 */
function buildBacklinksSummary(
  targetPath: string,
  backlinks: BacklinkEntry[],
  grouped: Record<string, BacklinkEntry[]>
): string {
  const parts: string[] = [];

  // Target file
  const filename = targetPath.split('/').pop() || targetPath;
  parts.push(`Backlinks to: ${filename}`);

  // Counts
  const fileCount = Object.keys(grouped).length;
  const linkCount = backlinks.length;

  if (linkCount === 0) {
    parts.push('No backlinks found');
  } else {
    parts.push(`${linkCount} links from ${fileCount} files`);
  }

  // Top linking files
  if (fileCount > 0) {
    const topFiles = Object.entries(grouped)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3)
      .map(([path, links]) => {
        const name = path.split('/').pop() || path;
        return `${name} (${links.length})`;
      });
    parts.push(`Top: ${topFiles.join(', ')}`);
  }

  return parts.join(' | ');
}
