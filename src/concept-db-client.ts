/**
 * Concept-DB Client
 *
 * HTTP client for the concept-db REST surface. Concept-db exposes:
 *   GET  /concepts/search?query=&shape=&source_type=&limit=&offset=
 *   GET  /concepts/:id
 *   GET  /concepts/:id/neighbors?direction=&edge_types=&limit=
 *   GET  /concepts/:id/edges?direction=
 *   POST /concepts                            (create)
 *   POST /concepts/upsert-by-signature        (idempotent on pointer_type+shape)
 *   POST /concepts/:id/link                   (create edge)
 *
 * Auth: pass `Authorization: ApiKey <key>` if a key is configured.
 * Note: concept ids are stored as `concept:<short>` in the DB but the
 * `:id` route param accepts the bare `<short>` form (the leading
 * `concept:` prefix is stripped client-side). Methods accept either form.
 */

// =============================================================================
// Types
// =============================================================================

export interface ConceptRecord {
  /** Full id, e.g. "concept:abcdef..." */
  id: string;
  shape: string;
  source_type?: string;
  pointer?: Record<string, unknown>;
  summary?: string;
  content?: string;
  budget?: number;
  relevance?: number;
  times_loaded?: number;
  times_succeeded?: number;
  times_failed?: number;
  org_id?: string;
  public?: boolean;
  updated_at?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ConceptNeighbor {
  /** Adjacent concept id (full form, e.g. "concept:..."). */
  id: string;
  shape?: string;
  source_type?: string;
  summary?: string;
  relevance?: number;
  edge_type: string;
  edge_weight?: number;
  edge_description?: string;
  /** Whether this concept is the source (outgoing) or target (incoming) */
  direction?: 'outgoing' | 'incoming';
}

export interface ConceptEdge {
  id?: string;
  from_concept_id: string;
  to_concept_id: string;
  edge_type: string;
  weight?: number;
  description?: string;
  created_at?: string;
}

export interface SearchConceptsParams {
  query?: string;
  shape?: string;
  sourceType?: string;
  minRelevance?: number;
  limit?: number;
  offset?: number;
}

export interface SearchConceptsResponse {
  concepts: ConceptRecord[];
  count: number;
}

export interface NeighborsResponse {
  neighbors: ConceptNeighbor[];
}

export interface EdgesResponse {
  edges: ConceptEdge[];
}

export interface CreateConceptPayload {
  source_type?: string;
  shape?: string;
  content?: string;
  summary?: string;
  pointer?: Record<string, unknown>;
  budget?: number;
  relevance?: number;
  metadata?: Record<string, unknown>;
}

export interface UpsertBySignaturePayload {
  pointer_type: string;
  shape: string;
}

export interface UpsertBySignatureResponse {
  id: string;
  created: boolean;
}

export interface LinkConceptsPayload {
  to_concept_id: string;
  edge_type: string;
  weight?: number;
  description?: string;
}

export interface ConceptDbClientOptions {
  timeout?: number;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  maxRetries?: number;
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
  const prefix = '[ConceptDbClient]';
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
// Helpers
// =============================================================================

/**
 * Strip the leading `concept:` prefix from an id (if present). Concept-db's
 * REST `:id` route expects the bare short form.
 */
export function stripConceptPrefix(id: string): string {
  if (id.startsWith('concept:')) {
    return id.slice('concept:'.length);
  }
  return id;
}

/**
 * Derive the "short id" (no `concept:` prefix, no SurrealDB angle
 * brackets) for use as a wikilink target. Some concept ids arrive
 * wrapped as `concept:⟨...⟩`; we strip those too.
 */
/**
 * HTTP transport that prefers Obsidian's `requestUrl()` API (CORS-free,
 * Electron-native) when the plugin runs inside Obsidian, and falls back
 * to global `fetch()` otherwise (probe scripts, tests).
 *
 * Obsidian's fetch() inherits Chromium's CORS preflight against the
 * `app://obsidian.md` origin and is blocked by substrate vessels that
 * don't ship Access-Control-Allow-Origin headers (concept_pL2ZFsPkzZz7
 * adjacent issue). requestUrl() bypasses the CORS layer entirely.
 */
// Lazy synchronous lookup of Obsidian's requestUrl. The 'obsidian'
// module is marked external by esbuild AND resolved by Obsidian's
// plugin loader as a CommonJS module — `require('obsidian')` works
// inside Obsidian and throws in Node (caught + cached as null).
let obsidianRequestUrl: ((p: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}) => Promise<{ status: number; text: string }>) | null | undefined;

function getObsidianRequestUrl() {
  if (obsidianRequestUrl !== undefined) return obsidianRequestUrl;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ob = require('obsidian') as { requestUrl?: typeof obsidianRequestUrl };
    obsidianRequestUrl = ob?.requestUrl ?? null;
  } catch {
    obsidianRequestUrl = null;
  }
  return obsidianRequestUrl;
}

async function doHttp(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const reqUrl = getObsidianRequestUrl();
  if (reqUrl) {
    const r = await reqUrl({ url, method, headers, body, throw: false });
    return { status: r.status, text: r.text };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Wrapped neighbor row as concept-db's REST route emits it.
 * GET /concepts/:id/neighbors → { neighbors: RawNeighborRow[] }
 */
interface RawNeighborRow {
  concept?: {
    id?: string;
    shape?: string;
    source_type?: string;
    summary?: string;
    relevance?: number;
  };
  edge?: {
    type?: string;
    weight?: number;
    description?: string;
  };
  direction?: 'outgoing' | 'incoming';
}

function flattenNeighborRow(row: RawNeighborRow): ConceptNeighbor {
  return {
    id: row.concept?.id ?? '',
    shape: row.concept?.shape,
    source_type: row.concept?.source_type,
    summary: row.concept?.summary,
    relevance: row.concept?.relevance,
    edge_type: row.edge?.type ?? 'related_to',
    edge_weight: row.edge?.weight,
    edge_description: row.edge?.description,
    direction: row.direction,
  };
}

export function shortConceptId(id: string): string {
  let s = stripConceptPrefix(id);
  // strip SurrealDB angle brackets if present
  s = s.replace(/^⟨/, '').replace(/⟩$/, '');
  return s;
}

// =============================================================================
// Client
// =============================================================================

export class ConceptDbClient {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private logger: NonNullable<ConceptDbClientOptions['logger']>;
  private maxRetries: number;
  private baseRetryDelay: number;

  constructor(baseUrl: string, apiKey: string, options: ConceptDbClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeout = options.timeout ?? 30000;
    this.logger = options.logger ?? defaultLogger;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelay = options.baseRetryDelay ?? 1000;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async searchConcepts(params: SearchConceptsParams = {}): Promise<SearchConceptsResponse> {
    const q = new URLSearchParams();
    if (params.query) q.set('query', params.query);
    if (params.shape) q.set('shape', params.shape);
    if (params.sourceType) q.set('source_type', params.sourceType);
    if (params.minRelevance !== undefined) q.set('min_relevance', String(params.minRelevance));
    if (params.limit !== undefined) q.set('limit', String(params.limit));
    if (params.offset !== undefined) q.set('offset', String(params.offset));
    const qs = q.toString();
    const path = `/concepts/search${qs ? `?${qs}` : ''}`;
    this.logger('debug', 'searchConcepts', { params, path });
    const resp = await this.fetch<SearchConceptsResponse>(path);
    return {
      concepts: resp.concepts || [],
      count: resp.count ?? (resp.concepts?.length ?? 0),
    };
  }

  async getConcept(id: string): Promise<ConceptRecord | null> {
    const short = stripConceptPrefix(id);
    const path = `/concepts/${encodeURIComponent(short)}`;
    try {
      return await this.fetch<ConceptRecord>(path);
    } catch (err) {
      if (err instanceof ConceptDbError && err.status === 404) return null;
      throw err;
    }
  }

  async getNeighbors(
    id: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both',
    edgeTypes?: string[],
    limit?: number
  ): Promise<ConceptNeighbor[]> {
    const short = stripConceptPrefix(id);
    const q = new URLSearchParams();
    q.set('direction', direction);
    if (edgeTypes && edgeTypes.length) q.set('edge_types', edgeTypes.join(','));
    if (limit !== undefined) q.set('limit', String(limit));
    const path = `/concepts/${encodeURIComponent(short)}/neighbors?${q.toString()}`;
    // The REST route returns `{neighbors: [{concept, edge, direction}]}` where
    // `concept` carries the adjacent node and `edge` carries the typed edge.
    // Flatten into our ConceptNeighbor shape (id + shape + summary + edge_*).
    const resp = await this.fetch<{ neighbors?: RawNeighborRow[] }>(path);
    return (resp.neighbors ?? []).map(flattenNeighborRow);
  }

  async getEdges(id: string, direction: 'outgoing' | 'incoming' | 'both' = 'both'): Promise<ConceptEdge[]> {
    const short = stripConceptPrefix(id);
    const path = `/concepts/${encodeURIComponent(short)}/edges?direction=${direction}`;
    const resp = await this.fetch<EdgesResponse>(path);
    return resp.edges || [];
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async createConcept(payload: CreateConceptPayload): Promise<ConceptRecord> {
    return this.fetch<ConceptRecord>('/concepts', { method: 'POST', body: payload });
  }

  async upsertBySignature(payload: UpsertBySignaturePayload): Promise<UpsertBySignatureResponse> {
    return this.fetch<UpsertBySignatureResponse>('/concepts/upsert-by-signature', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Update a concept's mutable fields. concept-db exposes PATCH /concepts/:id.
   */
  async updateConcept(id: string, patch: Partial<CreateConceptPayload>): Promise<ConceptRecord> {
    const short = stripConceptPrefix(id);
    return this.fetch<ConceptRecord>(`/concepts/${encodeURIComponent(short)}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  async linkConcepts(
    fromId: string,
    toId: string,
    edgeType: string,
    weight?: number,
    description?: string
  ): Promise<ConceptEdge> {
    const short = stripConceptPrefix(fromId);
    const body: LinkConceptsPayload = {
      to_concept_id: toId,
      edge_type: edgeType,
      weight,
      description,
    };
    return this.fetch<ConceptEdge>(`/concepts/${encodeURIComponent(short)}/link`, {
      method: 'POST',
      body,
    });
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      await this.fetch<unknown>('/health', { noRetry: true });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async fetch<T>(
    path: string,
    options: { method?: string; body?: unknown; noRetry?: boolean } = {}
  ): Promise<T> {
    const { method = 'GET', body, noRetry = false } = options;
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['Authorization'] = `ApiKey ${this.apiKey}`;
    if (body) headers['Content-Type'] = 'application/json';

    const maxAttempts = noRetry ? 1 : this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { status, text } = await doHttp(
          url,
          method,
          headers,
          body !== undefined ? JSON.stringify(body) : undefined,
          this.timeout,
        );
        if (status < 200 || status >= 300) {
          let errorBody: unknown;
          try {
            errorBody = JSON.parse(text);
          } catch {
            errorBody = text;
          }
          const message =
            typeof errorBody === 'object' && errorBody && 'error' in errorBody
              ? String((errorBody as { error: unknown }).error)
              : typeof errorBody === 'string' && errorBody.length > 0
              ? errorBody
              : `Request failed with status ${status}`;
          throw new ConceptDbError(message, status);
        }
        return JSON.parse(text) as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ConceptDbError) {
          if (err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
        }
        if (lastError.name === 'AbortError') {
          throw new ConceptDbError('Request timed out', 408);
        }
        if (attempt < maxAttempts - 1) {
          const delay = Math.min(this.baseRetryDelay * Math.pow(2, attempt), 30000);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError || new Error('Request failed after retries');
  }
}

export class ConceptDbError extends Error {
  public readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ConceptDbError';
    this.status = status;
  }
}
