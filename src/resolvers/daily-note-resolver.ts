/**
 * Daily Note Resolver - Resolve obsidian:daily_note pointers
 *
 * Finds and reads daily notes with support for:
 * - Date parsing (ISO format or relative dates like 'today', 'yesterday')
 * - Daily notes plugin path patterns
 * - Section extraction by heading
 */
import type { App, TFile, CachedMetadata } from 'obsidian';
import type {
  ImpulsePointer,
  ObsidianDailyNotePointer,
  ResolverResult,
  ImpulseMetadata,
} from './types';

/**
 * Parse a date string into a Date object
 * Supports:
 * - ISO format: 2024-03-15
 * - Relative: today, yesterday, tomorrow
 * - Relative with offset: -1d, -3d, +1d, -1w, -2w
 */
function parseDate(dateStr: string): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0); // Start of day

  const lower = dateStr.toLowerCase().trim();

  // Handle relative dates
  switch (lower) {
    case 'today':
      return now;
    case 'yesterday':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case 'tomorrow':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  // Handle relative offsets: -1d, +3d, -1w, etc.
  const offsetMatch = lower.match(/^([+-]?\d+)([dwm])$/);
  if (offsetMatch) {
    const amount = parseInt(offsetMatch[1], 10);
    const unit = offsetMatch[2];

    let msPerUnit: number;
    switch (unit) {
      case 'd':
        msPerUnit = 24 * 60 * 60 * 1000; // days
        break;
      case 'w':
        msPerUnit = 7 * 24 * 60 * 60 * 1000; // weeks
        break;
      case 'm':
        // For months, we handle differently
        const monthDate = new Date(now);
        monthDate.setMonth(monthDate.getMonth() + amount);
        return monthDate;
      default:
        msPerUnit = 24 * 60 * 60 * 1000;
    }

    return new Date(now.getTime() + amount * msPerUnit);
  }

  // Try ISO date format
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  // Try other common formats
  const date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    date.setHours(0, 0, 0, 0);
    return date;
  }

  throw new Error(`Invalid date format: ${dateStr}`);
}

/**
 * Format a date into a path-safe string
 * Default format: YYYY-MM-DD
 */
function formatDate(date: Date, format: string = 'YYYY-MM-DD'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return format
    .replace('YYYY', String(year))
    .replace('YY', String(year).slice(-2))
    .replace('MM', month)
    .replace('M', String(date.getMonth() + 1))
    .replace('DD', day)
    .replace('D', String(date.getDate()));
}

/**
 * Get common daily note path patterns
 */
function getDailyNotePatterns(date: Date): string[] {
  const dateStr = formatDate(date, 'YYYY-MM-DD');
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');

  // Common patterns used by daily notes plugins
  return [
    // Root level
    `${dateStr}.md`,
    // Daily Notes folder
    `Daily Notes/${dateStr}.md`,
    `daily/${dateStr}.md`,
    `daily-notes/${dateStr}.md`,
    // Periodic notes with year/month structure
    `periodic/${year}/${month}/${dateStr}.md`,
    `journal/${year}/${month}/${dateStr}.md`,
    `journals/${year}/${month}/${dateStr}.md`,
    // Year folders
    `${year}/${dateStr}.md`,
    `daily/${year}/${dateStr}.md`,
    // Inbox style
    `inbox/${dateStr}.md`,
  ];
}

/**
 * Try to find the daily note file
 */
function findDailyNote(app: App, date: Date): TFile | null {
  const patterns = getDailyNotePatterns(date);

  // First, try to get configuration from daily notes plugin
  // @ts-ignore - accessing plugin internals
  const dailyNotesPlugin = app.internalPlugins?.plugins?.['daily-notes'];
  if (dailyNotesPlugin?.enabled && dailyNotesPlugin?.instance?.options) {
    const options = dailyNotesPlugin.instance.options;
    if (options.folder || options.format) {
      const folder = options.folder || '';
      const format = options.format || 'YYYY-MM-DD';
      const filename = formatDate(date, format);
      const customPath = folder ? `${folder}/${filename}.md` : `${filename}.md`;
      patterns.unshift(customPath);
    }
  }

  // Try each pattern
  for (const pattern of patterns) {
    const file = app.vault.getAbstractFileByPath(pattern);
    if (file && 'extension' in file && (file as TFile).extension === 'md') {
      return file as TFile;
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

  const { position, ...frontmatter } = cache.frontmatter;
  return frontmatter;
}

/**
 * Extract a section by heading from content
 */
function extractSection(
  content: string,
  sectionHeading: string,
  cache: CachedMetadata | null
): string | null {
  if (!cache?.headings) {
    return null;
  }

  // Find the heading
  const headingIndex = cache.headings.findIndex(
    (h) => h.heading.toLowerCase() === sectionHeading.toLowerCase()
  );

  if (headingIndex === -1) {
    return null;
  }

  const targetHeading = cache.headings[headingIndex];
  const targetLevel = targetHeading.level;

  // Find the start position
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
    currentPos = lineEnd + 1;
  }

  if (startLine === -1) {
    return null;
  }

  // Find the next heading at the same or higher level
  let endLine = lines.length;

  for (let i = headingIndex + 1; i < cache.headings.length; i++) {
    const nextHeading = cache.headings[i];
    if (nextHeading.level <= targetLevel) {
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

  return lines.slice(startLine, endLine).join('\n').trim();
}

/**
 * Remove frontmatter from content
 */
function removeFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return content;
  }

  return content.slice(endIndex + 3).trimStart();
}

/**
 * Extract headings from cache
 */
function extractHeadings(cache: CachedMetadata | null): string[] {
  if (!cache?.headings) {
    return [];
  }
  return cache.headings.map((h) => h.heading);
}

/**
 * Resolve an obsidian:daily_note pointer
 */
export async function resolveDailyNote(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const dnPointer = pointer as ObsidianDailyNotePointer;

  // Validate required fields
  if (!dnPointer.date) {
    throw new Error('obsidian:daily_note pointer requires a date');
  }

  // Parse the date
  let date: Date;
  try {
    date = parseDate(dnPointer.date);
  } catch (e) {
    throw new Error(
      `Invalid date: ${dnPointer.date}. Use ISO format (YYYY-MM-DD) or relative dates (today, yesterday, -1d, etc.)`
    );
  }

  // Find the daily note
  const file = findDailyNote(app, date);
  if (!file) {
    const dateStr = formatDate(date, 'YYYY-MM-DD');
    throw new Error(
      `Daily note not found for ${dateStr}. Tried common paths: ${getDailyNotePatterns(date).slice(0, 3).join(', ')}...`
    );
  }

  // Read content
  let content = await app.vault.read(file);

  // Get cached metadata
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = extractFrontmatter(cache);
  const headings = extractHeadings(cache);

  // Handle frontmatter inclusion
  if (!dnPointer.includeFrontmatter) {
    content = removeFrontmatter(content);
  }

  // Extract specific section if requested
  if (dnPointer.section) {
    const originalContent = await app.vault.read(file);
    const section = extractSection(originalContent, dnPointer.section, cache);

    if (section === null) {
      throw new Error(`Section not found: ${dnPointer.section}`);
    }

    content = section;
  }

  // Build output
  const dateStr = formatDate(date, 'YYYY-MM-DD');
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    date.getDay()
  ];

  // Build metadata
  const metadata: ImpulseMetadata = {
    shape: 'obsidian_daily_note',
    summary: buildDailyNoteSummary(file.path, date, dnPointer, content),
    rowCount: content.split('\n').length,
    availableOps: ['read', 'edit', 'append', 'navigate'],
    // Daily note-specific metadata
    path: file.path,
    date: dateStr,
    dayOfWeek,
    section: dnPointer.section,
    headings,
    frontmatter,
    created: file.stat.ctime,
    modified: file.stat.mtime,
    size: file.stat.size,
  };

  return {
    content,
    metadata,
  };
}

/**
 * Build a human-readable summary for the daily note
 */
function buildDailyNoteSummary(
  path: string,
  date: Date,
  pointer: ObsidianDailyNotePointer,
  content: string
): string {
  const parts: string[] = [];

  // Date info
  const dateStr = formatDate(date, 'YYYY-MM-DD');
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  parts.push(`Daily: ${dateStr} (${dayOfWeek})`);

  // Section if extracted
  if (pointer.section) {
    parts.push(`Section: ${pointer.section}`);
  }

  // Content stats
  const lineCount = content.split('\n').length;
  const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  parts.push(`${lineCount} lines, ~${wordCount} words`);

  // File path
  const filename = path.split('/').pop() || path;
  parts.push(`File: ${filename}`);

  return parts.join(' | ');
}
