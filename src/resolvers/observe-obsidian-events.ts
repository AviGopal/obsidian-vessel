/**
 * Resolver — `obsidian:event_observed` (Phase 1, Layer 0).
 *
 * Subscribes to the Obsidian workspace + vault event surface and
 * converts each raw event into an `obsidianEvent` impulse appended to
 * the shared in-memory event log. Queries via `resolve(pointer)` read
 * back the most-recent events for downstream activities (the windowing
 * resolver and the action-effect probe).
 *
 * Privacy:
 *   - NEVER includes raw editor text. The `payload_hash` field carries
 *     a sha256 of the serialized raw payload; the body itself is dropped.
 *   - NEVER includes absolute filesystem paths. Paths are vault-relative
 *     (Obsidian's `TFile.path` is already vault-relative) and pass
 *     `sanitiseSyncRootRelativePath` before being attached.
 *
 * Spec:
 *   openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *     specs/obsidian-observation-layer/spec.md
 *     §"obsidianEvent impulse shape contract"
 *     §"observe-obsidian-events activity contract"
 */

import type { App, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';
import {
  ObsidianEvent,
  ObsidianEventKind,
  ObsidianEventLog,
  ObsidianEventQueryPointer,
  makeId,
  sanitiseSyncRootRelativePath,
} from './observation-types';
import { sha256Hex } from './observation-hash';

let lastPulseWriteMs = 0;
let pulseSessionId: string | null = null;

function writeLiveEditPulse(activePath: string | null): void {
  // Throttle: at most one write per 2000 ms. The pulse is a liveness marker
  // OTHER planes consume so they know the operator is actively editing —
  // it carries only the vault-RELATIVE active file path (never editor text),
  // and is written OUTSIDE the vault (absolute /workspace path) precisely so
  // it does NOT generate a vault file-modify event and echo back into the
  // observation channel (the fm-50 writeback-echo-loop failure).
  const now = Date.now();
  if (now - lastPulseWriteMs < 2000) return;
  lastPulseWriteMs = now;
  if (pulseSessionId === null) {
    pulseSessionId = 'obs-' + Date.now().toString(36);
  }
  try {
    // Lazy require so a top-level node:fs import cannot break plugin bundling.
    require('fs').writeFileSync(
      '/workspace/obsidian-live-edit-pulse.json',
      JSON.stringify({
        marker: 'obsidian_live_edit_pulse',
        note_path: activePath,
        session_id: pulseSessionId,
        last_activity_ts: new Date().toISOString(),
        pid: process.pid,
      }),
    );
  } catch {
    // Best-effort: the pulse must never break observation. On sandboxed
    // platforms the write simply fails silently.
  }
}


interface Ctx {
  app: App | null;
  log: ObsidianEventLog | null;
  /** Unsubscribe callbacks installed by `startObserveObsidianEvents`. */
  cleanups: Array<() => void>;
  /**
   * Vault-relative path prefixes whose file events are the SUBSTRATE's own writes
   * (concept-sync note materialization, vessel/activity-family sync, substrate
   * reflection notes) — NOT operator actions. File events under these are skipped
   * at source so they never flood the 10k log and evict real operator events.
   * This is the durable root fix for the observation-channel pollution the
   * behavior scan detected (substrate-side render filtering was the stopgap).
   */
  substrateWritePrefixes: string[];
}

const ctx: Ctx = { app: null, log: null, cleanups: [], substrateWritePrefixes: [] };

/**
 * Configure which vault path prefixes are substrate-originated writes (skipped
 * from the observed-event log). main.ts wires this from settings (concept-sync
 * root + substrate folders). Trailing slash recommended for folder-prefix match.
 */
export function setSubstrateWritePrefixes(prefixes: string[]): void {
  ctx.substrateWritePrefixes = prefixes.filter((p) => typeof p === 'string' && p.length > 0);
}

function isSubstrateWritePath(path: string | undefined): boolean {
  if (!path) return false;
  return ctx.substrateWritePrefixes.some((pfx) => path === pfx || path.startsWith(pfx));
}

const solicitationRegistry = new Map<string, { solicitationId: string; registeredAt: number }>();
const SOLICITATION_SUPPRESS_MS = 10_000;
const SOLICITATION_CAP = 500;

export function registerSolicitation(path: string, solicitationId: string): void {
  if (!path || !solicitationId) return;
  if (solicitationRegistry.size >= SOLICITATION_CAP) {
    const oldest = solicitationRegistry.keys().next().value;
    if (oldest !== undefined) solicitationRegistry.delete(oldest);
  }
  solicitationRegistry.set(path, { solicitationId, registeredAt: Date.now() });
}

export function solicitationFor(path: string | undefined): string | null {
  if (!path) return null;
  for (const [p, rec] of solicitationRegistry) {
    if (path === p || path.startsWith(p)) return rec.solicitationId;
  }
  return null;
}

function shouldDropVaultEvent(path: string | undefined): boolean {
  if (!path) return false;
  const reg = [...solicitationRegistry.entries()].find(([p]) => path === p || path.startsWith(p));
  if (reg) return Date.now() - reg[1].registeredAt < SOLICITATION_SUPPRESS_MS;
  return isSubstrateWritePath(path);
}

/**
 * Wire the resolver. main.ts calls this with the shared event log so
 * both the workspace subscriptions and the query path read/write the
 * same buffer.
 */
export function setObserveObsidianEventsContext(
  app: App | null,
  log: ObsidianEventLog | null,
): void {
  ctx.app = app;
  ctx.log = log;
}

/**
 * Convert one Obsidian event into a sanitised `obsidianEvent` impulse.
 * Exported for the unit tests.
 */
export function buildObsidianEvent(args: {
  kind: ObsidianEventKind;
  rawPayload: unknown;
  path?: string;
  commandId?: string;
  /** Override the timestamp; default is `new Date().toISOString()`. */
  timestamp?: string;
}): ObsidianEvent {
  const serialised = JSON.stringify(args.rawPayload ?? null);
  const payload_hash = sha256Hex(serialised);
  const sync_root_relative_path = sanitiseSyncRootRelativePath(args.path);
  const event: ObsidianEvent = {
    shape: 'obsidian:event_observed',
    event_id: makeId('evt'),
    kind: args.kind,
    timestamp: args.timestamp ?? new Date().toISOString(),
    payload_hash,
    bridge_eligibility: 'deny',
  };
  if (sync_root_relative_path) event.sync_root_relative_path = sync_root_relative_path;
  const sol = solicitationFor(args.path);
  if (sol) event.solicitation_id = sol;
  if (args.kind === 'command-executed' && args.commandId) {
    event.command_id = args.commandId;
  }
  return event;
}

/**
 * Subscribe to workspace + vault events and append to the log. Returns
 * a cleanup function. Idempotent: calling start again first tears down
 * existing subscriptions.
 */
export function startObserveObsidianEvents(): () => void {
  stopObserveObsidianEvents();
  const { app, log } = ctx;
  if (!app || !log) {
    throw new Error('observe-obsidian-events: context not initialized');
  }

  const push = (e: ObsidianEvent) => log.append(e);

  // Workspace events ---------------------------------------------------------
  const onActiveLeaf = (leaf: WorkspaceLeaf | null) => {
    const view = leaf?.view as { file?: TFile } | undefined;
    const path = view?.file?.path;
    push(buildObsidianEvent({ kind: 'active-leaf-change', rawPayload: { path }, path }));
  };
  const onEditor = () => {
    // Raw editor body is intentionally NOT inspected; we only hash the
    // event marker so the probe can later disambiguate clusters by
    // count, not content.
    push(buildObsidianEvent({ kind: 'editor-change', rawPayload: { t: 'editor-change' } }));
    const activeFile = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
    writeLiveEditPulse(activeFile ? activeFile.path : null);
  };
  const onLayout = () => {
    push(buildObsidianEvent({ kind: 'layout-change', rawPayload: { t: 'layout-change' } }));
  };

  const workspaceLeaf = app.workspace.on('active-leaf-change', onActiveLeaf);
  const workspaceEditor = app.workspace.on('editor-change' as 'editor-change', onEditor);
  const workspaceLayout = app.workspace.on('layout-change', onLayout);

  // Vault events -------------------------------------------------------------
  // Skip the substrate's OWN writes (paths under substrateWritePrefixes) so the
  // operator-interaction signal is never evicted from the log by the concept-sync
  // file-create flood. Workspace events (leaf/editor/layout) are always operator.
  const onCreate = (file: TAbstractFile) => {
    if (shouldDropVaultEvent(file.path)) return;
    push(buildObsidianEvent({ kind: 'file-create', rawPayload: { path: file.path }, path: file.path }));
  };
  const onModify = (file: TAbstractFile) => {
    if (shouldDropVaultEvent(file.path)) return;
    push(buildObsidianEvent({ kind: 'file-modify', rawPayload: { path: file.path }, path: file.path }));
  };
  const onDelete = (file: TAbstractFile) => {
    if (shouldDropVaultEvent(file.path)) return;
    push(buildObsidianEvent({ kind: 'file-delete', rawPayload: { path: file.path }, path: file.path }));
  };
  const onRename = (file: TAbstractFile, oldPath: string) => {
    if (isSubstrateWritePath(file.path) && isSubstrateWritePath(oldPath)) return;
    push(
      buildObsidianEvent({
        kind: 'file-rename',
        rawPayload: { oldPath, newPath: file.path },
        path: file.path,
      }),
    );
  };

  const vaultCreate = app.vault.on('create', onCreate);
  const vaultModify = app.vault.on('modify', onModify);
  const vaultDelete = app.vault.on('delete', onDelete);
  const vaultRename = app.vault.on('rename', onRename);

  const cleanups: Array<() => void> = [
    () => app.workspace.offref(workspaceLeaf),
    () => app.workspace.offref(workspaceEditor),
    () => app.workspace.offref(workspaceLayout),
    () => app.vault.offref(vaultCreate),
    () => app.vault.offref(vaultModify),
    () => app.vault.offref(vaultDelete),
    () => app.vault.offref(vaultRename),
  ];
  ctx.cleanups = cleanups;
  return () => stopObserveObsidianEvents();
}

export function stopObserveObsidianEvents(): void {
  while (ctx.cleanups.length) {
    const fn = ctx.cleanups.pop();
    try {
      fn?.();
    } catch (err) {
      console.error('[observe-obsidian-events] cleanup error:', err);
    }
  }
}

/**
 * Query path. Returns the most-recent events (filtered by
 * `sync_root_scope` / `since`) as a JSON-stringified payload, with
 * structured metadata listing per-event ids and kinds.
 */
async function resolveObsidianEvents(
  pointer: ImpulsePointer,
  _app: App,
): Promise<ResolverResult> {
  const p = pointer as unknown as ObsidianEventQueryPointer;
  if (!ctx.log) {
    throw new Error('observe-obsidian-events: event log not initialized');
  }
  const events = ctx.log.read({
    sync_root_scope: p.sync_root_scope,
    since: p.since,
    limit: p.limit ?? 1000,
  });
  return {
    content: JSON.stringify({ events }, null, 2),
    metadata: {
      shape: 'obsidian:event_observed',
      summary: `${events.length} obsidianEvent impulse(s)`,
      rowCount: events.length,
      availableOps: ['window', 'probe'],
    },
  };
}

registerResolver('obsidian:event_observed', resolveObsidianEvents);

/** Test seam: emit a synthetic event into the log (used by Phase 2/3). */
export function emitObsidianEventForTesting(event: ObsidianEvent): void {
  ctx.log?.append(event);
}
