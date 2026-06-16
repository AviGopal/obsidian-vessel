/**
 * Legacy types that are still used but not part of the main types system.
 * These should eventually be migrated or deprecated.
 */

// =============================================================================
// Template Types (legacy format)
// =============================================================================

export interface PromptTemplate {
  template: string;
  variables: PromptVariable[];
}

export interface PromptVariable {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface TaskValidation {
  requiredFiles?: string[];
  requiredPatterns?: string[];
  forbiddenPatterns?: string[];
  exitCode?: number;
}

export interface RetryConfig {
  maxAttempts: number;
  strategy: 'immediate' | 'exponential' | 'linear';
  delayMs?: number;
}

// =============================================================================
// Metrics Types
// =============================================================================

export interface ActivityMetrics {
  activity_id: string;
  variant_id?: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  last_executed_at?: string;
  thompson_alpha?: number;
  thompson_beta?: number;
}

export interface ToolMetrics {
  tool_name: string;
  activity_id?: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  avg_duration_ms: number;
  error_rate?: number;
  typical_errors?: string[];
}

// =============================================================================
// Sync Types
// =============================================================================

export interface SyncResult {
  executions_synced: number;
  templates_synced: number;
  errors: string[];
  last_sync_at: string;
}

export interface SyncOptions {
  since?: string;
  limit?: number;
  include_templates?: boolean;
  include_executions?: boolean;
  force_full_sync?: boolean;
}
