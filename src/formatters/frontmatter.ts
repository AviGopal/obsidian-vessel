/**
 * Frontmatter Generation and Parsing
 *
 * Handles YAML frontmatter for Obsidian notes with Dataview compatibility.
 */

// =============================================================================
// Types
// =============================================================================

export interface ExecutionFrontmatter {
  execution_id: string;
  activity_id: string;
  variant_id?: string;
  success: boolean;
  duration_ms: number;
  cost: number;
  executed_at: string;
  vessel_id?: string;
  tags: string[];
  // Dataview compatible
  type: 'execution-trace';
}

export interface TemplateFrontmatter {
  activity_id: string;
  name: string;
  category?: string;
  execution_type: string;
  input_shapes: string[];
  output_shapes: string[];
  created_at: string;
  // Dataview compatible
  type: 'activity-template';
}

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

// =============================================================================
// YAML Generation
// =============================================================================

/**
 * Escape special YAML characters in strings
 */
function escapeYamlString(value: string): string {
  // Check if string needs quoting
  const needsQuotes =
    value.includes(':') ||
    value.includes('#') ||
    value.includes("'") ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('|') ||
    value.includes('>') ||
    value.includes('[') ||
    value.includes(']') ||
    value.includes('{') ||
    value.includes('}') ||
    value.includes('&') ||
    value.includes('*') ||
    value.includes('!') ||
    value.includes('?') ||
    value.includes('@') ||
    value.includes('`') ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    value === 'yes' ||
    value === 'no' ||
    /^\d/.test(value);

  if (!needsQuotes) {
    return value;
  }

  // Use double quotes and escape internal double quotes
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Format a Date object to ISO string
 */
function formatDate(date: Date | string): string {
  if (typeof date === 'string') {
    return date;
  }
  return date.toISOString();
}

/**
 * Convert a value to YAML format at a given indent level
 */
function valueToYaml(value: unknown, indent: number = 0): string {
  const prefix = '  '.repeat(indent);

  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'null';
    if (!Number.isFinite(value)) return 'null';
    return String(value);
  }

  if (typeof value === 'string') {
    return escapeYamlString(value);
  }

  if (value instanceof Date) {
    return escapeYamlString(formatDate(value));
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]';
    }

    // Check if all items are primitives (for inline array)
    const allPrimitive = value.every(
      (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );

    if (allPrimitive && value.length <= 5) {
      // Inline format for short primitive arrays
      const items = value.map((v) => valueToYaml(v, 0));
      return `[${items.join(', ')}]`;
    }

    // Multi-line format for longer or complex arrays
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // Object items need special handling
        const objLines = objectToYamlLines(item as Record<string, unknown>, indent + 1);
        if (objLines.length > 0) {
          lines.push(`${prefix}- ${objLines[0]?.replace(/^\s+/, '')}`);
          lines.push(...objLines.slice(1));
        }
      } else {
        lines.push(`${prefix}- ${valueToYaml(item, 0)}`);
      }
    }
    return '\n' + lines.join('\n');
  }

  if (typeof value === 'object') {
    const objLines = objectToYamlLines(value as Record<string, unknown>, indent);
    return '\n' + objLines.join('\n');
  }

  return String(value);
}

/**
 * Convert an object to YAML lines
 */
function objectToYamlLines(obj: Record<string, unknown>, indent: number = 0): string[] {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    const safeKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : escapeYamlString(key);
    const yamlValue = valueToYaml(value, indent + 1);

    if (yamlValue.startsWith('\n')) {
      // Multi-line value
      lines.push(`${prefix}${safeKey}:${yamlValue}`);
    } else {
      lines.push(`${prefix}${safeKey}: ${yamlValue}`);
    }
  }

  return lines;
}

/**
 * Generate YAML frontmatter from an object
 *
 * @param data - Object to convert to frontmatter
 * @returns Formatted string with --- delimiters
 */
export function generateFrontmatter(data: Record<string, unknown>): string {
  const lines = objectToYamlLines(data, 0);
  return `---\n${lines.join('\n')}\n---`;
}

// =============================================================================
// YAML Parsing
// =============================================================================

/**
 * Simple YAML value parser (handles basic types)
 */
function parseYamlValue(value: string): unknown {
  const trimmed = value.trim();

  // Empty or null
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') {
    return null;
  }

  // Boolean
  if (trimmed === 'true' || trimmed === 'yes') {
    return true;
  }
  if (trimmed === 'false' || trimmed === 'no') {
    return false;
  }

  // Number
  if (/^-?\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Inline array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    // Simple split by comma (doesn't handle nested structures)
    return inner.split(',').map((item) => parseYamlValue(item.trim()));
  }

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const inner = trimmed.slice(1, -1);
    // Handle escape sequences for double-quoted strings
    if (trimmed.startsWith('"')) {
      return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return inner;
  }

  // Plain string
  return trimmed;
}

/**
 * Parse YAML frontmatter into key-value pairs
 * This is a simplified parser for frontmatter - not a full YAML parser
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentIndent = 0;

  for (const line of lines) {
    // Skip empty lines
    if (line.trim() === '') continue;

    // Calculate indent
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2);
      if (currentArray !== null) {
        currentArray.push(parseYamlValue(value));
      }
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      // Save previous array if exists
      if (currentKey && currentArray !== null) {
        result[currentKey] = currentArray;
        currentArray = null;
      }

      if (value === '' || value === '|' || value === '>') {
        // Start of multi-line value or array
        currentKey = key;
        currentIndent = indent;
        // Check if next line starts with -
        currentArray = [];
      } else {
        result[key] = parseYamlValue(value);
        currentKey = null;
      }
    }
  }

  // Save final array if exists
  if (currentKey && currentArray !== null && currentArray.length > 0) {
    result[currentKey] = currentArray;
  }

  return result;
}

/**
 * Extract frontmatter from markdown content
 *
 * @param content - Full markdown content with frontmatter
 * @returns Parsed frontmatter object and remaining body
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trim();

  // Check for frontmatter delimiter
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  // Find closing delimiter
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlContent = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  try {
    const frontmatter = parseYamlFrontmatter(yamlContent);
    return { frontmatter, body };
  } catch {
    // If parsing fails, return empty frontmatter
    return { frontmatter: {}, body: content };
  }
}

/**
 * Update frontmatter in existing content
 *
 * @param content - Original markdown content
 * @param updates - Fields to add or update
 * @returns Updated content with merged frontmatter
 */
export function updateFrontmatter(
  content: string,
  updates: Record<string, unknown>
): string {
  const { frontmatter, body } = parseFrontmatter(content);

  // Merge updates into existing frontmatter
  const merged = { ...frontmatter, ...updates };

  // Remove undefined values
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }

  // Generate new content
  const newFrontmatter = generateFrontmatter(merged);
  return `${newFrontmatter}\n\n${body}`;
}

// =============================================================================
// Frontmatter Builders
// =============================================================================

/**
 * Build execution frontmatter from execution trace data
 */
export function buildExecutionFrontmatter(data: {
  execution_id: string;
  activity_id: string;
  variant_id?: string;
  success: boolean;
  duration_ms: number;
  cost: number;
  executed_at: string;
  vessel_id?: string;
  extraTags?: string[];
}): ExecutionFrontmatter {
  const tags = ['execution', data.success ? 'success' : 'failed'];
  if (data.extraTags) {
    tags.push(...data.extraTags);
  }

  return {
    execution_id: data.execution_id,
    activity_id: data.activity_id,
    variant_id: data.variant_id,
    success: data.success,
    duration_ms: data.duration_ms,
    cost: data.cost,
    executed_at: data.executed_at,
    vessel_id: data.vessel_id,
    tags,
    type: 'execution-trace',
  };
}

/**
 * Build template frontmatter from activity template data
 */
export function buildTemplateFrontmatter(data: {
  activity_id: string;
  name: string;
  category?: string;
  execution_type: string;
  input_shapes?: string[];
  output_shapes?: string[];
  created_at: string;
}): TemplateFrontmatter {
  return {
    activity_id: data.activity_id,
    name: data.name,
    category: data.category,
    execution_type: data.execution_type,
    input_shapes: data.input_shapes ?? [],
    output_shapes: data.output_shapes ?? [],
    created_at: data.created_at,
    type: 'activity-template',
  };
}
