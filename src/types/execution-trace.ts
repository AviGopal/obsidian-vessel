/**
 * Execution trace types matching the activity-api schema.
 * These represent the outcome of activity executions that get synced to Obsidian.
 */

/**
 * Component change in an execution
 */
export interface ComponentChange {
  file_path: string;
  component_name: string;
  component_type: string;
  change_type: 'added' | 'modified' | 'deleted';
  reason?: string;
}

/**
 * Tool call within a task
 */
export interface ToolCall {
  tool_name?: string;
  tool?: string;  // Legacy field name
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
  success?: boolean;
  duration_ms?: number;
}

/**
 * Task execution within an activity execution
 */
export interface TaskExecution {
  task_id: string;
  description: string;
  success?: boolean;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  duration_ms?: number;
  tool_calls?: ToolCall[];
  error_message?: string;
  retry_count?: number;
  completed_at?: string;
}

/**
 * State snapshot capturing input/output state of an execution
 */
export interface StateSnapshot {
  input_state?: {
    filesAvailable?: string[];
    environment?: Record<string, string>;
    impulses?: string[];
    variables?: Record<string, unknown>;
  };
  output_state?: {
    filesModified?: string[];
    filesCreated?: string[];
    filesDeleted?: string[];
    exitCode?: number;
    stderr?: string;
  };
  stateTransition?: {
    before?: Record<string, string>;
    after?: Record<string, string>;
    workingDirectory?: string;
  };
  // Flat format (snake_case)
  files_modified?: string[];
  files_created?: string[];
  files_deleted?: string[];
  // Flat format (camelCase)
  filesModified?: string[];
  filesCreated?: string[];
  filesDeleted?: string[];
  workingDirectory?: string;
}

/**
 * Execution trace from the Activity API
 */
export interface ExecutionTrace {
  execution_id: string;
  activity_id: string;
  variant_id?: string;
  template_id?: string;
  template_name?: string;
  success: boolean;
  error_message?: string;
  error_type?: string;
  failed_task_id?: string;
  duration_ms: number;
  cost: number;
  cost_usd?: number;  // Alias for cost
  tokens_in?: number;
  tokens_out?: number;
  tokens_input?: number;  // Backend field name
  tokens_output?: number;  // Backend field name
  tokens_cache?: number;
  executed_at: string;
  created_at?: string;
  vessel_id?: string;
  org_id?: string | null;
  project_id?: string | null;
  tasks?: TaskExecution[];
  tasks_completed?: number;
  tasks_total?: number;
  state_snapshot?: StateSnapshot;
  component_changes?: ComponentChange[];
  impulses_used?: string[];
  // Edge learning fields
  improvisation?: boolean;
  input_impulse_shapes?: string[];
  output_impulse_shapes?: string[];
  // Additional display/context fields
  model?: string;
  goal_context?: string;
  input_impulses?: string[];
  output_impulses?: string[];
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Extended execution trace with additional metadata for Obsidian rendering.
 */
export interface ExecutionTraceWithMetadata extends ExecutionTrace {
  activity_name?: string;
  activity_category?: string;
  template_success_rate?: number;
  related_executions?: string[];
}

/**
 * Summary statistics for a collection of executions.
 */
export interface ExecutionSummary {
  total_executions: number;
  successful: number;
  failed: number;
  average_duration_ms: number;
  total_cost: number;
  by_activity: Record<string, {
    count: number;
    success_rate: number;
    avg_duration_ms: number;
  }>;
}
