/**
 * Frontmatter Resolver - Resolve obsidian:frontmatter pointers
 *
 * Gets frontmatter metadata from files with support for:
 * - Getting frontmatter for a specific file
 * - Searching vault for files matching frontmatter filters
 * - Grouping results by a frontmatter key
 */
import type { App, TFile, CachedMetadata } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianFrontmatterPointer,
  ResolverResult,
  ImpulseMetadata,
  FrontmatterEntry,
} from './types';

/**
 * Default values for frontmatter configuration
 */
const DEFAULTS = {
  limit: 100,
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
 * Extract frontmatter from file cache, removing position metadata
 */
function extractFrontmatter(
  cache: CachedMetadata | null
): Record<string, unknown> | null {
  if (!cache?.frontmatter) {
    return null;
  }

  // Remove position metadata, keep only actual frontmatter values
  const { position, ...frontmatter } = cache.frontmatter;
  return frontmatter;
}

/**
 * Check if a value matches a filter value
 */
function matchesFilterValue(
  actual: unknown,
  filter: string | string[] | number | boolean
): boolean {
  // Handle array filters (OR logic)
  if (Array.isArray(filter)) {
    return filter.some((f) => matchesFilterValue(actual, f));
  }

  // Handle actual value being an array (any element matches)
  if (Array.isArray(actual)) {
    return actual.some((a) => matchesFilterValue(a, filter));
  }

  // Direct comparison
  if (actual === filter) {
    return true;
  }

  // String comparison (case-insensitive)
  if (typeof actual === 'string' && typeof filter === 'string') {
    return actual.toLowerCase() === filter.toLowerCase();
  }

  // Number comparison
  if (typeof actual === 'number' && typeof filter === 'number') {
    return actual === filter;
  }

  // String to number
  if (typeof actual === 'number' && typeof filter === 'string') {
    return String(actual) === filter;
  }

  if (typeof actual === 'string' && typeof filter === 'number') {
    return actual === String(filter);
  }

  // Boolean comparison
  if (typeof actual === 'boolean' && typeof filter === 'boolean') {
    return actual === filter;
  }

  return false;
}

/**
 * Check if frontmatter matches all filters
 */
function matchesFilters(
  frontmatter: Record<string, unknown>,
  filters: Record<string, string | string[] | number | boolean>
): boolean {
  for (const [key, filterValue] of Object.entries(filters)) {
    const actualValue = frontmatter[key];

    // Key doesn't exist
    if (actualValue === undefined) {
      return false;
    }

    if (!matchesFilterValue(actualValue, filterValue)) {
      return false;
    }
  }

  return true;
}

/**
 * Get frontmatter for a specific file
 */
function getFrontmatterForFile(app: App, file: TFile): Record<string, unknown> | null {
  const cache = app.metadataCache.getFileCache(file);
  return extractFrontmatter(cache);
}

/**
 * Search vault for files with matching frontmatter
 */
function searchByFrontmatter(
  app: App,
  filters: Record<string, string | string[] | number | boolean>,
  limit: number
): FrontmatterEntry[] {
  const results: FrontmatterEntry[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    if (results.length >= limit) {
      break;
    }

    const frontmatter = getFrontmatterForFile(app, file);
    if (!frontmatter) {
      continue;
    }

    if (matchesFilters(frontmatter, filters)) {
      results.push({
        path: file.path,
        frontmatter,
      });
    }
  }

  return results;
}

/**
 * Get all files with frontmatter (no filtering)
 */
function getAllFrontmatter(app: App, limit: number): FrontmatterEntry[] {
  const results: FrontmatterEntry[] = [];
  const files = app.vault.getMarkdownFiles();

  for (const file of files) {
    if (results.length >= limit) {
      break;
    }

    const frontmatter = getFrontmatterForFile(app, file);
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      results.push({
        path: file.path,
        frontmatter,
      });
    }
  }

  return results;
}

/**
 * Group results by a frontmatter key
 */
function groupByKey(
  entries: FrontmatterEntry[],
  groupBy: string
): Record<string, FrontmatterEntry[]> {
  const groups: Record<string, FrontmatterEntry[]> = {};

  for (const entry of entries) {
    const value = entry.frontmatter[groupBy];

    // Handle array values (file appears in multiple groups)
    const keys = Array.isArray(value)
      ? value.map(String)
      : value !== undefined
        ? [String(value)]
        : ['(none)'];

    for (const key of keys) {
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(entry);
    }
  }

  return groups;
}

/**
 * Get unique frontmatter keys across all entries
 */
function getUniqueKeys(entries: FrontmatterEntry[]): string[] {
  const keys = new Set<string>();

  for (const entry of entries) {
    for (const key of Object.keys(entry.frontmatter)) {
      keys.add(key);
    }
  }

  return Array.from(keys).sort();
}

/**
 * Get value distribution for a key
 */
function getValueDistribution(
  entries: FrontmatterEntry[],
  key: string
): Record<string, number> {
  const distribution: Record<string, number> = {};

  for (const entry of entries) {
    const value = entry.frontmatter[key];
    if (value === undefined) continue;

    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const strValue = String(v);
      distribution[strValue] = (distribution[strValue] || 0) + 1;
    }
  }

  return distribution;
}

/**
 * Resolve an obsidian:frontmatter pointer
 */
export async function resolveFrontmatter(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const fmPointer = pointer as ObsidianFrontmatterPointer;

  // Get configuration with defaults
  const limit = fmPointer.limit ?? DEFAULTS.limit;

  // Case 1: Specific file requested
  if (fmPointer.path) {
    const file = getFileByPath(app, fmPointer.path);
    if (!file) {
      throw new Error(`File not found: ${fmPointer.path}`);
    }

    const frontmatter = getFrontmatterForFile(app, file);
    if (!frontmatter) {
      return {
        content: JSON.stringify({ path: file.path, frontmatter: {} }, null, 2),
        metadata: {
          shape: 'obsidian_frontmatter',
          summary: `Frontmatter for ${file.path}: (empty)`,
          rowCount: 0,
          availableOps: ['read', 'edit'],
          path: file.path,
          hasData: false,
        },
      };
    }

    const content = JSON.stringify(
      { path: file.path, frontmatter },
      null,
      2
    );

    const keys = Object.keys(frontmatter);
    const metadata: ImpulseMetadata = {
      shape: 'obsidian_frontmatter',
      summary: `Frontmatter for ${file.path}: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`,
      rowCount: keys.length,
      columns: keys,
      sample: [{ key: keys[0], value: frontmatter[keys[0]] }],
      availableOps: ['read', 'edit', 'search_similar'],
      path: file.path,
      keys,
      hasData: true,
    };

    return { content, metadata };
  }

  // Case 2: Search by filters or get all
  let entries: FrontmatterEntry[];

  if (fmPointer.filters && Object.keys(fmPointer.filters).length > 0) {
    entries = searchByFrontmatter(app, fmPointer.filters, limit);
  } else {
    entries = getAllFrontmatter(app, limit);
  }

  // Apply grouping if requested
  let output: unknown;
  let groupedData: Record<string, FrontmatterEntry[]> | null = null;

  if (fmPointer.groupBy) {
    groupedData = groupByKey(entries, fmPointer.groupBy);
    output = {
      groupBy: fmPointer.groupBy,
      totalFiles: entries.length,
      groups: Object.entries(groupedData).map(([key, files]) => ({
        key,
        count: files.length,
        files: files.map((f) => f.path),
      })),
      allEntries: entries,
    };
  } else {
    output = {
      totalFiles: entries.length,
      entries,
    };
  }

  // Build content as JSON
  const content = JSON.stringify(output, null, 2);

  // Get unique keys and value distribution
  const uniqueKeys = getUniqueKeys(entries);

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_frontmatter_search',
    summary: buildFrontmatterSummary(fmPointer, entries, groupedData),
    rowCount: entries.length,
    columns: uniqueKeys.slice(0, 10),
    sample: entries.slice(0, 3).map((e) => ({
      path: e.path.split('/').pop(),
      keys: Object.keys(e.frontmatter).slice(0, 3),
    })),
    availableOps: ['read_file', 'filter_further', 'group_by'],
    // Frontmatter search-specific metadata
    filters: fmPointer.filters,
    groupBy: fmPointer.groupBy,
    totalFiles: entries.length,
    uniqueKeys,
    groupCount: groupedData ? Object.keys(groupedData).length : undefined,
    limitApplied: entries.length === limit,
  };

  return { content, metadata };
}

/**
 * Build a human-readable summary for frontmatter results
 */
function buildFrontmatterSummary(
  pointer: ObsidianFrontmatterPointer,
  entries: FrontmatterEntry[],
  grouped: Record<string, FrontmatterEntry[]> | null
): string {
  const parts: string[] = [];

  // Operation type
  if (pointer.path) {
    parts.push(`Frontmatter: ${pointer.path}`);
  } else if (pointer.filters && Object.keys(pointer.filters).length > 0) {
    const filterStr = Object.entries(pointer.filters)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
      .join(', ');
    parts.push(`Filter: ${filterStr}`);
  } else {
    parts.push('All frontmatter');
  }

  // Result count
  parts.push(`${entries.length} files`);

  // Group info
  if (grouped) {
    const groupCount = Object.keys(grouped).length;
    parts.push(`${groupCount} groups by ${pointer.groupBy}`);
  }

  // Key overview
  const uniqueKeys = getUniqueKeys(entries);
  if (uniqueKeys.length > 0) {
    parts.push(`Keys: ${uniqueKeys.slice(0, 4).join(', ')}${uniqueKeys.length > 4 ? '...' : ''}`);
  }

  return parts.join(' | ');
}
