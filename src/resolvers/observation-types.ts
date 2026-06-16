/**
 * Phase 1 — Obsidian observation layer shape contracts.
 *
 * These types correspond to the three new shapes advertised by this
 * vessel:
 *
 *   - obsidian:event_observed      (Layer 0, bridge_eligibility="deny")
 *   - obsidian:interaction_episode (Layer 1, bridge_eligibility="allow")
 *   - obsidian:action_effect_model (probe output, bridge_eligibility="allow")
 *
 * Spec:
 *   openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *   openspec/specs/obsidian-meta-skill-prototype/spec.md
 *
 * Privacy boundary: NO raw editor text, NO absolute paths. Events carry
 * `payload_hash` (sha256 over the serialized raw payload) and an
 * optional `sync_root_relative_path` that is asserted to NOT start with
 * "/" or contain "..".
 */

/** Discriminator for Layer-0 events. */
export type ObsidianEventKind =
  | 'editor-change'
  | 'file-open'
  | 'file-create'
  | 'file-modify'
  | 'file-delete'
  | 'file-rename'
  | 'active-leaf-change'
  | 'layout-change'
  | 'command-executed';

export type BridgeEligibility = 'allow' | 'deny';

/**
 * Layer-0 raw obsidian event impulse body.
 *
 * Required: `event_id`, `kind`, `timestamp`, `payload_hash`.
 * Optional: `sync_root_relative_path` (vault-relative, never absolute),
 *           `command_id` (only on kind === "command-executed").
 *
 * `bridge_eligibility` MUST be "deny" — raw events do not cross to
 * learning storage.
 */
export interface ObsidianEvent {
  shape: 'obsidian:event_observed';
  event_id: string;
  kind: ObsidianEventKind;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** sha256 of the serialized raw event payload (hex). */
  payload_hash: string;
  /** Vault-relative path; never absolute, never contains "..". */
  sync_root_relative_path?: string;
  /** Obsidian command id when kind === "command-executed". */
  command_id?: string;
  bridge_eligibility: 'deny';
}

/**
 * Pointer used to query the in-memory event log for recent
 * obsidian:event_observed impulses.
 */
export interface ObsidianEventQueryPointer {
  type: 'obsidian:event_observed';
  /** Optional vault-relative scope filter. */
  sync_root_scope?: string;
  /** Max events to return (default: 1000). */
  limit?: number;
  /** Return only events with `timestamp >= since` (ISO-8601). */
  since?: string;
}

/**
 * Pointer used to invoke the windowing resolver.
 */
export interface ObsidianEpisodeQueryPointer {
  type: 'obsidian:interaction_episode';
  /** Idle-gap window threshold in milliseconds (default: 30_000). */
  window_ms?: number;
  /** Optional vault-relative scope filter. */
  sync_root_scope?: string;
}

/**
 * Layer-1 episode impulse body.
 *
 * Required: `episode_id`, `event_ids` (ordered chronologically),
 *           `sorted_unique_class_signature`, `window_start`,
 *           `window_end`, `sync_root_scope`,
 *           `bridge_eligibility: "allow"`.
 *
 * The signature is the sorted, deduplicated set of tokens of the form
 * `<kind>` or `<kind>:<command_id>` (the latter only when
 * `kind === "command-executed"`).
 */
export interface ObsidianEpisode {
  shape: 'obsidian:interaction_episode';
  episode_id: string;
  event_ids: string[];
  sorted_unique_class_signature: string[];
  window_start: string;
  window_end: string;
  sync_root_scope: string;
  bridge_eligibility: 'allow';
}

/** Reversibility vocabulary for action-effect models. */
export type ReversibilityClass =
  | 'reversible'
  | 'soft_irreversible'
  | 'hard_irreversible'
  | 'unknown';

/**
 * Heuristic reversibility classification of an Obsidian command id. Lives here
 * (the dependency-free base module) so both the probe and the permission layer
 * can use it without a circular import. Intentionally conservative — when in
 * doubt, return `unknown`.
 */
export function classifyReversibility(commandId: string): ReversibilityClass {
  if (/(^|:)delete(-|$)|trash|remove/i.test(commandId)) return 'soft_irreversible';
  if (/(^|:)edit|toggle|insert|paste|cut/i.test(commandId)) return 'reversible';
  if (/disable|uninstall|reset/i.test(commandId)) return 'hard_irreversible';
  return 'unknown';
}

/**
 * Pointer used to invoke the probe resolver.
 */
export interface ProbeActionEffectsPointer {
  type: 'obsidian:action_effect_model';
  /**
   * DEPRECATED — was the host-specific probe-vault-path confinement. Now
   * ignored; safety is the portable grant model below. Kept optional for
   * backward compatibility with older callers.
   */
  probe_vault_path?: string;
  /**
   * Authority granted by the impulse state space. The probe only exercises
   * commands whose permission class is covered. Absent → the safe default
   * (`read`,`navigate`), which is non-destructive on ANY vault.
   */
  granted_classes?: Array<'read' | 'navigate' | 'mutate' | 'destructive'>;
  /** Max commands to probe in a single invocation (default: 10). */
  max_commands?: number;
  /** Per-command timeout, milliseconds (default: 30_000, max: 30_000). */
  per_command_timeout_ms?: number;
  /**
   * Extra deny-glob patterns to exclude beyond the built-in safety list
   * (`app:*`, `editor:focus`, `daily-notes:*`, ...).
   */
  extra_deny_globs?: string[];
}

/**
 * `actionEffectModel` impulse body.
 *
 * `post_signature_distribution` probabilities MUST sum to 1.0 within
 * ±1e-6. `reversibility_class` MUST be one of the four vocabulary
 * values.
 */
export interface ActionEffectModel {
  shape: 'obsidian:action_effect_model';
  command_id: string;
  observation_count: number;
  post_signature_distribution: Array<{
    post_signature: string;
    probability: number;
  }>;
  reversibility_class: ReversibilityClass;
  bridge_eligibility: 'allow';
}

/**
 * In-memory append-only event log shared across the three observation
 * resolvers. Bounded to `cap` most-recent events to keep the plugin
 * memory footprint flat. Default cap: 10_000.
 */
export class ObsidianEventLog {
  private events: ObsidianEvent[] = [];
  constructor(public readonly cap: number = 10_000) {}

  append(event: ObsidianEvent): void {
    this.events.push(event);
    if (this.events.length > this.cap) {
      // Drop oldest. Splice is O(n) — fine for the modest cap.
      this.events.splice(0, this.events.length - this.cap);
    }
  }

  /**
   * Read events in chronological order. Optional `sync_root_scope` and
   * `since` filters mirror the query pointer.
   */
  read(opts: {
    sync_root_scope?: string;
    since?: string;
    limit?: number;
  } = {}): ObsidianEvent[] {
    const sinceMs = opts.since ? Date.parse(opts.since) : Number.NEGATIVE_INFINITY;
    const limit = opts.limit ?? this.events.length;
    const filtered: ObsidianEvent[] = [];
    for (const e of this.events) {
      if (opts.sync_root_scope) {
        if (
          !e.sync_root_relative_path ||
          !e.sync_root_relative_path.startsWith(opts.sync_root_scope)
        ) {
          continue;
        }
      }
      if (Date.parse(e.timestamp) < sinceMs) continue;
      filtered.push(e);
      if (filtered.length >= limit) break;
    }
    return filtered;
  }

  size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
  }
}

/**
 * Lightweight deterministic id generator. Format:
 * `<prefix>-<unix_ms>-<counter>`. Used for event_id / episode_id when
 * the caller doesn't supply one.
 */
let _idCounter = 0;
export function makeId(prefix: string): string {
  _idCounter = (_idCounter + 1) >>> 0;
  return `${prefix}-${Date.now()}-${_idCounter}`;
}

/**
 * Built-in deny globs for `probe-obsidian-action-effects`. These cover
 * the destructive / system-state-mutating namespaces that must never be
 * dispatched against any vault in an experimentation context. The
 * caller can extend via `extra_deny_globs`.
 */
export const DEFAULT_PROBE_DENY_GLOBS: string[] = [
  'app:*',
  'editor:focus',
  'daily-notes:*',
  // Common destructive families:
  'workspace:close-window',
  'workspace:quit',
  // Plugin lifecycle (would disable/enable plugins):
  'app:open-vault',
  'app:reload',
];

/**
 * Glob-style matcher supporting `*` only (no `?`, no character
 * classes). `*` matches any non-empty run of characters.
 */
export function matchesDenyGlob(commandId: string, glob: string): boolean {
  if (!glob.includes('*')) return commandId === glob;
  const re = new RegExp(
    '^' +
      glob
        .split('*')
        .map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(commandId);
}

export function isCommandAllowedForProbe(
  commandId: string,
  extraDenyGlobs: string[] = [],
): boolean {
  const all = [...DEFAULT_PROBE_DENY_GLOBS, ...extraDenyGlobs];
  return !all.some((g) => matchesDenyGlob(commandId, g));
}

/**
 * Sanitises a vault-relative path. Returns `undefined` when the path
 * is absolute or escapes the vault (contains `..`); otherwise returns
 * the trimmed path.
 */
export function sanitiseSyncRootRelativePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('/') || path.startsWith('\\')) return undefined;
  // Reject Windows absolutes like C:\ as well.
  if (/^[A-Za-z]:[\\/]/.test(path)) return undefined;
  if (path.split('/').some((seg) => seg === '..')) return undefined;
  return path;
}
