/**
 * Type exports for the Obsidian vessel plugin.
 *
 * Re-exports all types from submodules for convenient importing.
 */

// =============================================================================
// Execution Trace Types
// =============================================================================
export type {
  ExecutionTrace,
  TaskExecution,
  ToolCall,
  StateSnapshot,
  ComponentChange,
  ExecutionTraceWithMetadata,
  ExecutionSummary,
} from './execution-trace';

// =============================================================================
// Impulse and Pointer Types
// =============================================================================
export type {
  ImpulsePointer,
  ObsidianNotePointer,
  ObsidianSearchPointer,
  ObsidianCanvasPointer,
  ObsidianBacklinksPointer,
  ObsidianFrontmatterPointer,
  ObsidianDailyNotePointer,
  ObsidianGraphQueryPointer,
  ObsidianPointer,
  ImpulseMetadata,
  ResolverResult,
  Impulse,
} from './impulse';

// Impulse type guards
export {
  isObsidianNotePointer,
  isObsidianSearchPointer,
  isObsidianCanvasPointer,
  isObsidianBacklinksPointer,
  isObsidianFrontmatterPointer,
  isObsidianDailyNotePointer,
  isObsidianGraphQueryPointer,
  isObsidianPointer,
} from './impulse';

// =============================================================================
// Canvas Types
// =============================================================================
export type {
  CanvasData,
  CanvasNode,
  CanvasEdge,
  CanvasTextNode,
  CanvasFileNode,
  CanvasLinkNode,
  CanvasGroupNode,
  SpecificCanvasNode,
  CanvasColorName,
  CanvasLayoutConfig,
  ActivityCanvasNode,
} from './canvas';

// Canvas utilities and constants
export {
  CANVAS_COLORS,
  DEFAULT_CANVAS_LAYOUT,
  CanvasBuilder,
  isTextNode,
  isFileNode,
  isLinkNode,
  isGroupNode,
} from './canvas';

// =============================================================================
// Activity Template Types (from activity-template.ts)
// =============================================================================
export type {
  TemplateVariable,
  TaskDefinition,
  ActivityTemplate,
  ActivityTemplateExtended,
  ActivityTaskExtended,
  TemplateMetrics,
  TemplateRecommendation,
} from './activity-template';
