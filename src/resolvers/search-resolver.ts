/**
 * Search Resolver - Resolve obsidian:search pointers
 *
 * Searches the Obsidian vault using the built-in search functionality with support for:
 * - Full-text search across notes
 * - Folder filtering
 * - Result limiting
 * - Content snippet extraction
 */
import type { App, TFile, SearchResult as ObsidianSearchResult } from 'obsidian';

/**
 * PreparedQuery interface for Obsidian's internal search
 * Not exported from obsidian types but used internally
 */
interface PreparedQuery {
  query: string;
  tokens: string[];
  fuzzy: string[];
}
import type {
  ImpulsePointer,
  ObsidianSearchPointer,
  ResolverResult,
  ImpulseMetadata,
  SearchResult,
} from './types';

/**
 * Default values for search configuration
 */
const DEFAULTS = {
  limit: 10,
  snippetLength: 100,
  includeSnippets: false,
};

/**
 * Prepare search query using Obsidian's fuzzy search
 */
function prepareQuery(app: App, query: string): PreparedQuery {
  // Use Obsidian's built-in fuzzy search preparation
  // @ts-ignore - prepareQuery exists but may not be in types
  if (app.internalPlugins?.plugins?.['global-search']?.instance?.prepareQuery) {
    // @ts-ignore
    return app.internalPlugins.plugins['global-search'].instance.prepareQuery(query);
  }

  // Fallback: simple lowercase matching
  return {
    query: query.toLowerCase(),
    tokens: query.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
    fuzzy: [],
  } as unknown as PreparedQuery;
}

/**
 * Search files using fuzzy matching
 */
async function searchFiles(
  app: App,
  query: string,
  folder?: string
): Promise<Array<{ file: TFile; matches: { match: [number, number]; text: string }[] }>> {
  const results: Array<{
    file: TFile;
    matches: { match: [number, number]; text: string }[];
  }> = [];

  // Get all markdown files
  let files = app.vault.getMarkdownFiles();

  // Filter by folder if specified
  if (folder) {
    const normalizedFolder = folder.endsWith('/') ? folder : `${folder}/`;
    files = files.filter(
      (f) => f.path.startsWith(normalizedFolder) || f.path.startsWith(folder)
    );
  }

  // Prepare query
  const preparedQuery = prepareQuery(app, query);
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 0);

  // Search each file
  for (const file of files) {
    try {
      const content = await app.vault.cachedRead(file);
      const contentLower = content.toLowerCase();

      // Check if file matches query
      let matchCount = 0;
      const matches: { match: [number, number]; text: string }[] = [];

      // Simple token matching
      for (const token of queryTokens) {
        let searchIndex = 0;
        while (true) {
          const index = contentLower.indexOf(token, searchIndex);
          if (index === -1) break;

          matchCount++;
          matches.push({
            match: [index, index + token.length],
            text: content.slice(
              Math.max(0, index - 50),
              Math.min(content.length, index + token.length + 50)
            ),
          });
          searchIndex = index + 1;

          // Limit matches per file
          if (matches.length >= 10) break;
        }
        if (matches.length >= 10) break;
      }

      // Also check filename
      const filenameLower = file.basename.toLowerCase();
      for (const token of queryTokens) {
        if (filenameLower.includes(token)) {
          matchCount += 5; // Boost filename matches
        }
      }

      if (matchCount > 0) {
        results.push({ file, matches });
      }
    } catch (e) {
      // Skip files that can't be read
      continue;
    }
  }

  // Sort by match count (descending)
  results.sort((a, b) => b.matches.length - a.matches.length);

  return results;
}

/**
 * Extract a snippet around a match
 */
function extractSnippet(
  content: string,
  matchStart: number,
  matchEnd: number,
  snippetLength: number
): string {
  const halfLength = Math.floor(snippetLength / 2);

  // Calculate snippet bounds
  let start = Math.max(0, matchStart - halfLength);
  let end = Math.min(content.length, matchEnd + halfLength);

  // Adjust to word boundaries
  if (start > 0) {
    const wordStart = content.lastIndexOf(' ', start);
    if (wordStart !== -1 && matchStart - wordStart < halfLength + 20) {
      start = wordStart + 1;
    }
  }

  if (end < content.length) {
    const wordEnd = content.indexOf(' ', end);
    if (wordEnd !== -1 && wordEnd - matchEnd < halfLength + 20) {
      end = wordEnd;
    }
  }

  // Extract snippet
  let snippet = content.slice(start, end).trim();

  // Add ellipsis if truncated
  if (start > 0) {
    snippet = '...' + snippet;
  }
  if (end < content.length) {
    snippet = snippet + '...';
  }

  // Clean up whitespace
  snippet = snippet.replace(/\s+/g, ' ');

  return snippet;
}

/**
 * Resolve an obsidian:search pointer
 */
export async function resolveSearch(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const searchPointer = pointer as ObsidianSearchPointer;

  // Validate required fields
  if (!searchPointer.query) {
    throw new Error('obsidian:search pointer requires a query');
  }

  // Get configuration with defaults
  const limit = searchPointer.limit ?? DEFAULTS.limit;
  const includeSnippets = searchPointer.includeSnippets ?? DEFAULTS.includeSnippets;
  const snippetLength = searchPointer.snippetLength ?? DEFAULTS.snippetLength;

  // Perform search
  const searchResults = await searchFiles(
    app,
    searchPointer.query,
    searchPointer.folder
  );

  // Limit results
  const limitedResults = searchResults.slice(0, limit);

  // Build result entries
  const results: SearchResult[] = [];

  for (const { file, matches } of limitedResults) {
    const result: SearchResult = {
      path: file.path,
      matches: matches.length,
      score: matches.length, // Simple score based on match count
    };

    // Extract snippets if requested
    if (includeSnippets && matches.length > 0) {
      try {
        const content = await app.vault.cachedRead(file);
        result.snippets = matches.slice(0, 3).map((m) =>
          extractSnippet(content, m.match[0], m.match[1], snippetLength)
        );
      } catch (e) {
        // Skip snippet extraction on error
      }
    }

    results.push(result);
  }

  // Build content as JSON
  const content = JSON.stringify(results, null, 2);

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_search_results',
    summary: buildSearchSummary(searchPointer, results, searchResults.length),
    rowCount: results.length,
    columns: ['path', 'matches', 'score', 'snippets'],
    sample: results.slice(0, 3),
    availableOps: ['read_result', 'open_note', 'refine_search'],
    // Search-specific metadata
    query: searchPointer.query,
    folder: searchPointer.folder,
    totalMatches: searchResults.length,
    returnedResults: results.length,
    hasSnippets: includeSnippets,
  };

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for search results
 */
function buildSearchSummary(
  pointer: ObsidianSearchPointer,
  results: SearchResult[],
  totalMatches: number
): string {
  const parts: string[] = [];

  // Query info
  parts.push(`Search: "${pointer.query}"`);

  // Folder filter
  if (pointer.folder) {
    parts.push(`in ${pointer.folder}`);
  }

  // Result count
  if (results.length === 0) {
    parts.push('No results found');
  } else if (results.length === totalMatches) {
    parts.push(`${results.length} results`);
  } else {
    parts.push(`${results.length} of ${totalMatches} results`);
  }

  // Top results
  if (results.length > 0) {
    const topPaths = results.slice(0, 3).map((r) => r.path.split('/').pop() || r.path);
    parts.push(`Top: ${topPaths.join(', ')}`);
  }

  return parts.join(' | ');
}
