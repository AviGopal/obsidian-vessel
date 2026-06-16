/**
 * Core types for Obsidian Vessel Plugin
 *
 * Re-exports from the types directory for backwards compatibility.
 * All actual type definitions are in ./types/
 */

// Re-export everything from the types directory
export * from './types/index';

// Also export some legacy type aliases for backwards compatibility
export type {
  PromptTemplate,
  PromptVariable,
  TaskValidation,
  RetryConfig,
  SyncResult,
  SyncOptions,
  ActivityMetrics,
  ToolMetrics,
} from './types-legacy';
