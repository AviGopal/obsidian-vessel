/**
 * Formatters Index
 *
 * Re-exports all formatter modules for convenient importing.
 *
 * This module provides formatters for converting activity system data
 * to Obsidian-friendly markdown formats with Dataview compatibility.
 */

// =============================================================================
// Frontmatter
// =============================================================================

export {
  generateFrontmatter,
  parseFrontmatter,
  updateFrontmatter,
  buildExecutionFrontmatter,
  buildTemplateFrontmatter,
  type ExecutionFrontmatter,
  type TemplateFrontmatter,
  type ParsedFrontmatter,
} from './frontmatter';

// =============================================================================
// Execution Formatter
// =============================================================================

export {
  ExecutionFormatter,
  formatExecutionOneLiner,
  formatExecutionForDataview,
} from './execution-formatter';

// =============================================================================
// Template Formatter
// =============================================================================

export {
  TemplateFormatter,
  formatTemplateOneLiner,
  formatTemplateForDataview,
  formatTemplateCard,
} from './template-formatter';

// =============================================================================
// Metrics Formatter
// =============================================================================

export {
  MetricsFormatter,
  formatDuration,
  formatCost,
  formatTokens,
  formatTimestamp,
  formatRelativeTime,
  formatPercentage,
  formatSuccessRate,
} from './metrics-formatter';
