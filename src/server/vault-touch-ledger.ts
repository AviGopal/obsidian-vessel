/**
 * Vault-touch ledger (substrate activity observability).
 *
 * Every resolver dispatch through the plugin's single chokepoint (handleResolve
 * in routes.ts) emits one VaultTouch record here: which shape was resolved,
 * which vault paths were read/written, read-vs-write, timestamp, and the
 * dispatch/execution provenance when the resolve payload carries one.
 *
 * The ledger is an in-memory ring buffer ONLY — records are surfaced via the
 * `obsidian:vault_touches` read shape, the panel's "substrate activity"
 * section, and a status-bar pulse. Nothing is ever written into the vault
 * (vault-note ledgers cause churn and echo-suppression conflicts).
 */

export interface VaultTouch {
  /** Impulse shape that was resolved (e.g. 'obsidian:note', 'obsidian:write_note'). */
  shape: string;
  /** Vault paths read or written, best-effort extracted from pointer + result metadata. */
  paths: string[];
  /** Whether the resolve mutated the vault / app state. */
  mode: 'read' | 'write';
  /** ISO-8601 timestamp of the resolve. */
  timestamp: string;
  /** Whether the resolver reported success. */
  success: boolean;
  /** Provenance: dispatch id carried by the resolve payload, when present. */
  dispatch_id?: string;
  /** Provenance: execution id carried by the resolve payload, when present. */
  execution_id?: string;
}

/** Shapes whose resolution mutates the vault or the app. */
const WRITE_SHAPES = new Set<string>([
  'obsidian:write_note',
  'obsidian:concept_writeback',
  'obsidian:execute_command',
  'obsidian:open_note',
  'obsidian:reload_plugin',
  'obsidian:dispatch_goal',
  'obsidian:concept_sync',
  'obsidian:concept_rebuild',
]);

export function touchModeForShape(shape: string): 'read' | 'write' {
  return WRITE_SHAPES.has(shape) ? 'write' : 'read';
}

/**
 * Best-effort vault-path extraction. Resolvers report paths inconsistently
 * (note -> metadata.path; write_note -> content JSON; search -> metadata.sample
 * rows), so this scans pointer, metadata, and content for path-shaped fields
 * rather than relying on a single convention.
 */
export function extractTouchPaths(
  pointer: Record<string, unknown> | undefined,
  result: { content?: unknown; metadata?: unknown } | undefined
): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0 && v.length < 512) out.add(v);
  };
  add(pointer?.['path']);
  const md = result?.metadata as Record<string, unknown> | undefined;
  if (md && typeof md === 'object') {
    add(md['path']);
    const sample = md['sample'];
    if (Array.isArray(sample)) {
      for (const row of sample.slice(0, 20)) add((row as Record<string, unknown> | null)?.['path']);
    }
  }
  // content may be a JSON string or object carrying a path (e.g. write_note).
  let content: unknown = result?.content;
  if (typeof content === 'string' && content.startsWith('{') && content.length < 65536) {
    try { content = JSON.parse(content); } catch { content = undefined; }
  }
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    add((content as Record<string, unknown>)['path']);
  }
  if (Array.isArray(content)) {
    for (const row of content.slice(0, 20)) add((row as Record<string, unknown> | null)?.['path']);
  }
  return [...out];
}

export type VaultTouchListener = (touch: VaultTouch) => void;

/** In-memory ring buffer of VaultTouch records with subscribe support. */
export class VaultTouchLedger {
  private buf: VaultTouch[] = [];
  private readonly cap: number;
  private listeners = new Set<VaultTouchListener>();

  constructor(cap = 500) {
    this.cap = cap;
  }

  record(touch: VaultTouch): void {
    this.buf.push(touch);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
    for (const l of this.listeners) {
      try {
        l(touch);
      } catch {
        /* listeners must never throw into the resolve path */
      }
    }
  }

  read(opts: { limit?: number; since?: string; mode?: 'read' | 'write' } = {}): VaultTouch[] {
    let rows = this.buf;
    if (opts.since) {
      const t = Date.parse(opts.since);
      if (!isNaN(t)) rows = rows.filter((r) => Date.parse(r.timestamp) >= t);
    }
    if (opts.mode) rows = rows.filter((r) => r.mode === opts.mode);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, this.cap));
    return rows.slice(-limit);
  }

  size(): number {
    return this.buf.length;
  }

  subscribe(l: VaultTouchListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  clear(): void {
    this.buf = [];
  }
}
