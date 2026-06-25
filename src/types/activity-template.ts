/**
 * Activity Template Types
 *
 * TypeScript interfaces for activity templates used by the Obsidian vessel.
 */

/**
 * Template variable definition
 */
export interface TemplateVariable {
  name: string;
  description?: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  default?: unknown;
}

/**
 * Task definition within an activity template
 */
export interface TaskDefinition {
  id: string;
  description: string;
  prompt?: {
    template: string;
    variables?: TemplateVariable[];
  };
  validation?: {
    requiredFiles?: string[];
    requiredPatterns?: string[];
    forbiddenPatterns?: string[];
    exitCode?: number;
  };
  retry?: {
    maxAttempts?: number;
    strategy?: 'immediate' | 'exponential' | 'exponential_backoff' | 'linear';
    delayMs?: number;
  };
  order?: number;
}

/**
 * Activity template interface
 */
export interface ActivityTemplate {
  id: string;
  activity_id?: string;  // Legacy field name (alias for id)
  name: string;
  description?: string;
  category?: 'feature' | 'bugfix' | 'refactor' | 'tool' | 'infrastructure' | 'documentation' | 'meta';
  execution_type: 'template' | 'tool' | 'composition' | 'vessel_function' | 'llm' | 'deterministic' | 'hybrid';
  input_shapes?: string[];
  output_shapes?: string[];
  tasks?: TaskDefinition[];
  metadata?: Record<string, unknown>;
  org_id?: string;
  public?: boolean;
  version?: string;
  created_at: string;
  updated_at?: string;
  // Metrics fields from backend
  success_rate?: number;
  execution_count?: number;
  avg_duration_ms?: number;
  avg_cost_usd?: number;
  // Nested learning-state block (Thompson posteriors) as returned by activity-api.
  metrics?: {
    total_executions?: number;
    successful_executions?: number;
    failed_executions?: number;
    success_rate?: number;
    thompson_alpha?: number;
    thompson_beta?: number;
  };
}

/**
 * Extended activity template with API response fields (alias)
 * Has snake_case variants for fields that come from the backend
 */
export interface ActivityTemplateExtended {
  id: string;
  activity_id?: string;  // Legacy field name
  name: string;
  description?: string;
  category?: 'feature' | 'bugfix' | 'refactor' | 'tool' | 'infrastructure' | 'documentation' | 'meta';
  execution_type: 'llm' | 'deterministic' | 'hybrid' | 'template' | 'tool' | 'composition' | 'vessel_function';
  input_shapes?: string[];
  output_shapes?: string[];
  tasks?: ActivityTaskExtended[];
  metadata?: Record<string, unknown>;
  org_id?: string;
  public?: boolean;
  version?: string;
  created_at: string;
  updated_at?: string;
  // Metrics fields from backend
  success_rate?: number;
  execution_count?: number;
  avg_duration_ms?: number;
  avg_cost_usd?: number;
  thompson_alpha?: number;
  thompson_beta?: number;
}

/**
 * Extended task definition with full prompt information
 */
export interface ActivityTaskExtended {
  id: string;
  description: string;
  prompt?: {
    template: string;
    variables?: Array<{
      name: string;
      description?: string;
      type?: 'string' | 'number' | 'boolean' | 'array' | 'object';
      required?: boolean;
      default?: unknown;
    }>;
  };
  validation?: {
    requiredFiles?: string[];
    required_files?: string[];  // snake_case variant
    requiredPatterns?: string[];
    required_patterns?: string[];  // snake_case variant
    forbiddenPatterns?: string[];
    forbidden_patterns?: string[];  // snake_case variant
    exitCode?: number;
  };
  retry?: {
    maxAttempts?: number;
    max_attempts?: number;  // snake_case variant
    strategy?: 'immediate' | 'exponential' | 'exponential_backoff' | 'linear';
    delayMs?: number;
    delay_ms?: number;  // snake_case variant
  };
  order?: number;
}

/**
 * Template metrics from Thompson Sampling
 */
export interface TemplateMetrics {
  activity_id: string;
  variant_id?: string;
  execution_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  last_executed_at?: string;
  thompson_alpha: number;
  thompson_beta: number;
  sampled_probability?: number;
}

/**
 * Template recommendation from Thompson Sampling
 */
export interface TemplateRecommendation {
  template: ActivityTemplateExtended;
  score: number;
  confidence: number;
  reason?: string;
  alternatives?: Array<{
    template_id: string;
    score: number;
  }>;
}
