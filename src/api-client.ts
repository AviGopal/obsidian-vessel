/**
 * Activity API Client
 *
 * General-purpose client for interacting with the metabob-activity-api.
 * Provides methods for listing and retrieving execution traces and activity templates.
 *
 * Based on the API endpoints defined in:
 * - repos/metabob-activity-api/src/routes/execution-traces.ts
 * - repos/metabob-activity-api/src/routes/activities.ts
 */

import type { ExecutionTrace } from './types/execution-trace';
import type { ActivityTemplate } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Parameters for listing execution traces
 */
export interface ListExecutionTracesParams {
  /** Maximum number of traces to return (1-500, default: 50) */
  limit?: number;
  /** Pagination offset (default: 0) */
  offset?: number;
  /** Filter by variant ID */
  variantId?: string;
  /** Filter by activity ID */
  activityId?: string;
  /** Filter by success status */
  success?: boolean;
  /** Filter executions after this ISO timestamp */
  since?: string;
  /** Filter executions before this ISO timestamp */
  until?: string;
  /** Order by field */
  orderBy?: 'executed_at' | 'duration_ms' | 'cost';
  /** Sort direction */
  direction?: 'asc' | 'desc';
}

/**
 * Response from listing execution traces
 */
export interface ListExecutionTracesResponse {
  executions: ExecutionTrace[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Parameters for listing activity templates
 */
export interface ListActivityTemplatesParams {
  /** Maximum number of templates to return (default: 50) */
  limit?: number;
  /** Pagination offset (default: 0) */
  offset?: number;
  /** Filter by category */
  category?: string;
  /** Filter by execution type */
  executionType?: string;
  /** Include only public templates */
  publicOnly?: boolean;
  /** Filter by input shape */
  inputShape?: string;
  /** Filter by output shape */
  outputShape?: string;
}

/**
 * Response from listing activity templates
 */
export interface ListActivityTemplatesResponse {
  templates: ActivityTemplate[];
  total: number;
  limit?: number;
  offset?: number;
}

/**
 * API Error response
 */
export interface APIError {
  error: string;
  message?: string;
  details?: string;
  status?: number;
}

/**
 * Node in composition graph
 */
export interface CompositionNode {
  id: string;
  activityId: string;
  activityName?: string;
  executionCount?: number;
  successRate?: number;
  avgDurationMs?: number;
}

/**
 * Edge in composition graph (activity relationship)
 */
export interface CompositionEdge {
  id: string;
  parentActivityId: string;
  childActivityId: string;
  impulseShape?: string;
  connectionCount?: number;
  successRate?: number;
}

/**
 * Full composition graph
 */
export interface CompositionGraph {
  nodes: CompositionNode[];
  edges: CompositionEdge[];
  totalNodes: number;
  totalEdges: number;
}

/**
 * Impulse success metric for a composition edge
 */
export interface ImpulseSuccessMetric {
  edgeId: string;
  impulseShape: string;
  totalFlows: number;
  successfulFlows: number;
  successRate: number;
  avgDurationMs?: number;
}

/**
 * Options for the API client
 */
export interface ActivityAPIClientOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Logger function */
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms, default: 1000) */
  baseRetryDelay?: number;
}

// =============================================================================
// Logger
// =============================================================================

const defaultLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => {
  const prefix = '[ActivityAPIClient]';
  const logData = data ? ` ${JSON.stringify(data)}` : '';
  switch (level) {
    case 'debug':
      console.debug(`${prefix} ${message}${logData}`);
      break;
    case 'info':
      console.log(`${prefix} ${message}${logData}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}${logData}`);
      break;
    case 'error':
      console.error(`${prefix} ${message}${logData}`);
      break;
  }
};

// =============================================================================
// Activity API Client
// =============================================================================

/**
 * ActivityAPIClient provides methods for interacting with the metabob-activity-api.
 *
 * Usage:
 * ```typescript
 * const client = new ActivityAPIClient(
 *   'https://activity.metabob.com',
 *   'your-api-key'
 * );
 *
 * // List recent execution traces
 * const { traces, total } = await client.listExecutionTraces({ limit: 10 });
 *
 * // Get a specific execution trace
 * const trace = await client.getExecutionTrace('exec_123');
 *
 * // List activity templates
 * const { templates } = await client.listActivityTemplates({ category: 'bugfix' });
 * ```
 */
export class ActivityAPIClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private logger: NonNullable<ActivityAPIClientOptions['logger']>;
  private maxRetries: number;
  private baseRetryDelay: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    options: ActivityAPIClientOptions = {}
  ) {
    // Remove trailing slash if present
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeout = options.timeout ?? 30000;
    this.logger = options.logger ?? defaultLogger;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelay = options.baseRetryDelay ?? 1000;
  }

  // =============================================================================
  // Execution Traces
  // =============================================================================

  /**
   * List execution traces with filtering and pagination
   *
   * @param params - Query parameters for filtering and pagination
   * @returns List of execution traces with total count
   */
  async listExecutionTraces(params: ListExecutionTracesParams = {}): Promise<ListExecutionTracesResponse> {
    const queryParams = new URLSearchParams();

    if (params.limit !== undefined) {
      queryParams.set('limit', String(Math.min(Math.max(params.limit, 1), 500)));
    }
    if (params.offset !== undefined) {
      queryParams.set('offset', String(Math.max(params.offset, 0)));
    }
    if (params.variantId) {
      queryParams.set('variant_id', params.variantId);
    }
    if (params.activityId) {
      queryParams.set('activity_id', params.activityId);
    }
    if (params.success !== undefined) {
      queryParams.set('success', String(params.success));
    }
    if (params.since) {
      queryParams.set('start_date', params.since);
    }
    if (params.until) {
      queryParams.set('end_date', params.until);
    }

    const queryString = queryParams.toString();
    const path = `/v2/activities/execution-traces${queryString ? `?${queryString}` : ''}`;

    this.logger('debug', 'Listing execution traces', { params, path });

    const response = await this.fetch<ListExecutionTracesResponse>(path);

    this.logger('info', 'Listed execution traces', {
      count: response.executions?.length ?? 0,
      total: response.total,
    });

    return response;
  }

  /**
   * Get a specific execution trace by ID
   *
   * @param executionId - The execution ID to retrieve
   * @returns The execution trace or null if not found
   */
  async getExecutionTrace(executionId: string): Promise<ExecutionTrace | null> {
    const path = `/v2/activities/execution-traces/${encodeURIComponent(executionId)}`;

    this.logger('debug', 'Getting execution trace', { executionId });

    try {
      const response = await this.fetch<{ execution: ExecutionTrace }>(path);
      return response.execution ?? null;
    } catch (error) {
      if (error instanceof ActivityAPIError && error.status === 404) {
        this.logger('debug', 'Execution trace not found', { executionId });
        return null;
      }
      throw error;
    }
  }

  // =============================================================================
  // Activity Templates
  // =============================================================================

  /**
   * List activity templates with filtering and pagination
   *
   * @param params - Query parameters for filtering and pagination
   * @returns List of activity templates with total count
   */
  async listActivityTemplates(params: ListActivityTemplatesParams = {}): Promise<ListActivityTemplatesResponse> {
    const queryParams = new URLSearchParams();

    if (params.limit !== undefined) {
      queryParams.set('limit', String(Math.min(Math.max(params.limit, 1), 100)));
    }
    if (params.offset !== undefined) {
      queryParams.set('offset', String(Math.max(params.offset, 0)));
    }
    if (params.category) {
      queryParams.set('category', params.category);
    }
    if (params.executionType) {
      queryParams.set('execution_type', params.executionType);
    }
    if (params.publicOnly) {
      queryParams.set('public', 'true');
    }
    if (params.inputShape) {
      queryParams.set('input_shape', params.inputShape);
    }
    if (params.outputShape) {
      queryParams.set('output_shape', params.outputShape);
    }

    const queryString = queryParams.toString();
    const path = `/v2/activities/templates${queryString ? `?${queryString}` : ''}`;

    this.logger('debug', 'Listing activity templates', { params, path });

    const response = await this.fetch<ListActivityTemplatesResponse>(path);

    this.logger('info', 'Listed activity templates', {
      count: response.templates?.length ?? 0,
      total: response.total,
    });

    return response;
  }

  /**
   * Get a specific activity template by ID
   *
   * @param templateId - The template ID to retrieve
   * @returns The activity template or null if not found
   */
  async getActivityTemplate(templateId: string): Promise<ActivityTemplate | null> {
    const path = `/v2/activities/templates/${encodeURIComponent(templateId)}`;

    this.logger('debug', 'Getting activity template', { templateId });

    try {
      const response = await this.fetch<{ template: ActivityTemplate }>(path);
      return response.template ?? null;
    } catch (error) {
      if (error instanceof ActivityAPIError && error.status === 404) {
        this.logger('debug', 'Activity template not found', { templateId });
        return null;
      }
      throw error;
    }
  }

  // =============================================================================
  // Health Check
  // =============================================================================

  /**
   * Check API health
   *
   * @returns true if the API is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.fetch<{ status: string }>('/health', { noRetry: true });
      return response.status === 'ok' || response.status === 'healthy';
    } catch (error) {
      this.logger('warn', 'Health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get detailed health information
   *
   * @returns Health details including status, version, and uptime
   */
  async getHealth(): Promise<{ status: string; version?: string; uptime?: number } | null> {
    try {
      const response = await this.fetch<{
        status: string;
        version?: string;
        uptime?: number;
        uptime_seconds?: number;
      }>('/health', { noRetry: true });
      return {
        status: response.status || 'unknown',
        version: response.version,
        uptime: response.uptime || response.uptime_seconds,
      };
    } catch (error) {
      this.logger('warn', 'Failed to get health details', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // =============================================================================
  // Vessel Discovery
  // =============================================================================

  /**
   * Discover vessels that can resolve a specific impulse shape
   *
   * @param shape - The impulse shape to search for
   * @returns List of vessels that can resolve the shape
   */
  async discoverVessels(shape: string): Promise<Array<{
    vesselId: string;
    vesselName: string;
    endpoint: string;
    shapes: string[];
    metadata?: Record<string, unknown>;
  }>> {
    const path = `/v2/vessels/discover?shape=${encodeURIComponent(shape)}`;

    this.logger('debug', 'Discovering vessels', { shape });

    try {
      const response = await this.fetch<{
        vessels: Array<{
          vesselId?: string;
          vessel_id?: string;
          vesselName?: string;
          vessel_name?: string;
          endpoint: string;
          shapes: string[];
          metadata?: Record<string, unknown>;
        }>;
      }>(path);

      // Normalize response (handle both camelCase and snake_case)
      const vessels = (response.vessels || []).map(v => ({
        vesselId: v.vesselId || v.vessel_id || '',
        vesselName: v.vesselName || v.vessel_name || '',
        endpoint: v.endpoint,
        shapes: v.shapes,
        metadata: v.metadata,
      }));

      this.logger('info', 'Discovered vessels', { shape, count: vessels.length });

      return vessels;
    } catch (error) {
      if (error instanceof ActivityAPIError && error.status === 404) {
        this.logger('debug', 'No vessels found for shape', { shape });
        return [];
      }
      throw error;
    }
  }

  // =============================================================================
  // Composition Graph
  // =============================================================================

  /**
   * Get composition graph data showing activity relationships
   *
   * @param params - Query parameters for filtering
   * @returns Composition graph with nodes and edges
   */
  async getCompositionGraph(params: {
    activityId?: string;
    limit?: number;
  } = {}): Promise<CompositionGraph> {
    const queryParams = new URLSearchParams();

    if (params.activityId) {
      queryParams.set('activity_id', params.activityId);
    }
    if (params.limit !== undefined) {
      queryParams.set('limit', String(params.limit));
    }

    const queryString = queryParams.toString();
    const path = `/v2/activities/composition/graph${queryString ? `?${queryString}` : ''}`;

    this.logger('debug', 'Getting composition graph', { params, path });

    try {
      const response = await this.fetch<{
        nodes: CompositionNode[];
        edges: CompositionEdge[];
        total_nodes: number;
        total_edges: number;
      }>(path);

      this.logger('info', 'Got composition graph', {
        nodes: response.nodes?.length ?? 0,
        edges: response.edges?.length ?? 0,
      });

      return {
        nodes: response.nodes || [],
        edges: response.edges || [],
        totalNodes: response.total_nodes || 0,
        totalEdges: response.total_edges || 0,
      };
    } catch (error) {
      if (error instanceof ActivityAPIError && error.status === 404) {
        this.logger('debug', 'No composition graph data found');
        return { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 };
      }
      throw error;
    }
  }

  /**
   * Get impulse success metrics for composition edges
   *
   * @param params - Query parameters
   * @returns Impulse success metrics per edge
   */
  async getImpulseSuccessMetrics(params: {
    activityId?: string;
    impulseShape?: string;
    limit?: number;
  } = {}): Promise<ImpulseSuccessMetric[]> {
    const queryParams = new URLSearchParams();

    if (params.activityId) {
      queryParams.set('activity_id', params.activityId);
    }
    if (params.impulseShape) {
      queryParams.set('impulse_shape', params.impulseShape);
    }
    if (params.limit !== undefined) {
      queryParams.set('limit', String(params.limit));
    }

    const queryString = queryParams.toString();
    const path = `/v2/activities/composition/impulse-success${queryString ? `?${queryString}` : ''}`;

    this.logger('debug', 'Getting impulse success metrics', { params, path });

    try {
      const response = await this.fetch<{ metrics: ImpulseSuccessMetric[] }>(path);

      this.logger('info', 'Got impulse success metrics', {
        count: response.metrics?.length ?? 0,
      });

      return response.metrics || [];
    } catch (error) {
      if (error instanceof ActivityAPIError && error.status === 404) {
        this.logger('debug', 'No impulse success metrics found');
        return [];
      }
      throw error;
    }
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  /**
   * Make an authenticated API request with retry support
   */
  private async fetch<T>(
    path: string,
    options: { method?: string; body?: unknown; noRetry?: boolean } = {}
  ): Promise<T> {
    const { method = 'GET', body, noRetry = false } = options;

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const maxAttempts = noRetry ? 1 : this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            let errorBody: APIError | string;
            try {
              errorBody = await response.json();
            } catch {
              errorBody = await response.text();
            }

            throw new ActivityAPIError(
              typeof errorBody === 'object' && errorBody.error
                ? errorBody.error
                : typeof errorBody === 'string'
                ? errorBody
                : `Request failed with status ${response.status}`,
              response.status,
              typeof errorBody === 'object' ? errorBody : undefined
            );
          }

          return await response.json();
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (4xx) except for 429 (rate limit)
        if (error instanceof ActivityAPIError) {
          if (error.status >= 400 && error.status < 500 && error.status !== 429) {
            throw error;
          }
        }

        // Don't retry on abort (timeout)
        if (lastError.name === 'AbortError') {
          throw new ActivityAPIError('Request timed out', 408);
        }

        if (attempt < maxAttempts - 1) {
          const delay = this.calculateBackoffDelay(attempt);
          this.logger('debug', `Retrying request in ${delay}ms`, {
            path,
            attempt: attempt + 1,
            maxAttempts,
          });
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = this.baseRetryDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * delay;
    return Math.min(delay + jitter, 30000);
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error class for Activity API errors
 */
export class ActivityAPIError extends Error {
  public readonly status: number;
  public readonly details?: APIError;

  constructor(message: string, status: number, details?: APIError) {
    super(message);
    this.name = 'ActivityAPIError';
    this.status = status;
    this.details = details;
  }
}
