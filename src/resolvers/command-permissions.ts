/**
 * Capability-based authorization for Obsidian command execution.
 *
 * This replaces the host-specific `basePath == probe_vault_path` confinement
 * (which hardcoded a path on one machine and could not "operate anywhere") with
 * a PORTABLE permission model: every command is classified into an authority
 * class derived purely from the command id + the vessel's existing safety
 * primitives, and execution is authorized by a GRANT carried in the impulse
 * (the impulse state space) — never by which vault/host is open.
 *
 * Authority classes (least → most privileged):
 *   - `read`        no side effect (query-only / no-op commands).
 *   - `navigate`    changes UI / workspace / active file, NOT note CONTENT
 *                   (focus, open, fold, pin, reveal, switch). Effect is fully
 *                   observable from the structural signature, so it is safe to
 *                   exercise on ANY vault.
 *   - `mutate`      modifies note content or vault structure (edit, insert,
 *                   paste, toggle-format, new/rename). Damages real notes if run
 *                   blindly, and its effect is only observable when content is
 *                   hashed — so it requires BOTH an explicit grant AND
 *                   content-aware observation.
 *   - `destructive` deny-globbed or heuristically irreversible (delete, trash,
 *                   disable, uninstall, reset, app:*, quit, reload). Never
 *                   autonomous; requires an explicit elevated grant.
 *
 * Default grant (when the impulse carries none): `['read','navigate']` — the
 * subset that is safe and observable on any vault. The substrate elevates by
 * placing `granted_classes` in the impulse, not by pointing at a special vault.
 */

import { classifyReversibility, isCommandAllowedForProbe } from './observation-types';

export type PermissionClass = 'read' | 'navigate' | 'mutate' | 'destructive';

/** The classes safe to exercise on any vault without an explicit grant. */
export const DEFAULT_GRANTED_CLASSES: PermissionClass[] = ['read', 'navigate'];

// Content-mutating command families: their effect lands inside note text /
// vault structure, so they are only safe with content-aware observation.
const MUTATE_RE =
  /(^|:)(edit|insert|paste|cut|toggle-(bold|italic|highlight|strikethrough|code|blockquote|comment|checklist|bullet|numbered)|format|set-heading|swap-line|move-line|new-(file|note|from-template|canvas)|create|rename|merge|split|fold-less|template|inline)/i;

// Navigation / UI-only families: change workspace or active leaf, not content.
const NAVIGATE_RE =
  /(^|:)(focus|open|go-?to|next|prev|previous|reveal|fold($|-)|unfold|toggle-(pin|left-sidebar|right-sidebar|stacked|reading|preview|pin)|scroll|navigate|switch|cursor|jump|outline|backlink|graph|search|view-|show-|select-|zoom)/i;

/**
 * Classify a command's authority requirement. Pure function of the id — no host
 * state, so the same answer holds on any machine / any vault.
 */
export function classifyPermission(commandId: string): PermissionClass {
  // Deny-globbed families (app:*, quit, reload, …) are never autonomous.
  if (!isCommandAllowedForProbe(commandId)) return 'destructive';

  // Heuristically irreversible → destructive.
  const reversibility = classifyReversibility(commandId);
  if (reversibility === 'soft_irreversible' || reversibility === 'hard_irreversible') {
    return 'destructive';
  }

  if (MUTATE_RE.test(commandId)) return 'mutate';
  if (NAVIGATE_RE.test(commandId)) return 'navigate';

  // Unknown commands are treated as `mutate` — conservative default so an
  // unrecognised command is NOT executed under the default read/navigate grant.
  return 'mutate';
}

/**
 * Whether content-aware observation is REQUIRED to safely exercise this command
 * (i.e. its effect is invisible to the structural-only signature). True for
 * `mutate`; navigation/read effects are visible structurally.
 */
export function requiresContentObservation(cls: PermissionClass): boolean {
  return cls === 'mutate';
}

/**
 * Authorize a command against the granted classes from the impulse state space.
 * `destructive` always additionally requires it be explicitly named in the
 * grant — it is never covered implicitly.
 */
export function isAuthorized(commandId: string, grantedClasses: PermissionClass[]): boolean {
  const cls = classifyPermission(commandId);
  return grantedClasses.includes(cls);
}

/**
 * Normalize a grant from an impulse pointer. Absent / malformed → the safe
 * default (`read`,`navigate`). This is how the impulse state space carries
 * authority into the resolver, replacing the host-path gate.
 */
export function resolveGrant(granted: unknown): PermissionClass[] {
  if (!Array.isArray(granted)) return [...DEFAULT_GRANTED_CLASSES];
  const valid = granted.filter(
    (g): g is PermissionClass =>
      g === 'read' || g === 'navigate' || g === 'mutate' || g === 'destructive',
  );
  return valid.length > 0 ? valid : [...DEFAULT_GRANTED_CLASSES];
}
