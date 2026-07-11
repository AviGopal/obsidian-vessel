/**
 * Goal Dispatch View
 *
 * An Obsidian ItemView that provides a sidebar panel for dispatching
 * goals to goal-host-vessel and watching execution events in real time.
 *
 * Space model (0.4.0):
 *   ┌─────────────────────────────────────┐
 *   │ [omnibox — 1 line, expands on focus]│
 *   │ solicitation cards (pinned)         │
 *   │ fleet rows (in-flight, collapsed)   │
 *   │ completed: one-line count (expand)  │
 *   ├─────────────────────────────────────┤
 *   │ ONE scroll container:               │
 *   │   event feed lines                  │
 *   │   vault-touch feed (collapsed)      │
 *   └─────────────────────────────────────┘
 *
 * - Dispatches via GoalHostClient (POST /run-goal)
 * - Streams events from activity-api WS, filtered by executionId
 * - Writes vault notes via GoalNoteManager
 * - Reconnects WS on 3s backoff
 * - Component grammar: sub-card / sub-chip / sub-feed-line (see styles.css)
 */

import { ItemView, WorkspaceLeaf, TFile, Notice, Menu, MarkdownView, MarkdownRenderer, requestUrl } from 'obsidian';
import type ObsidianVesselPlugin from '../main';
import { GoalHostClient, type VaultContext } from '../goals/goal-host-client';
import { GoalNoteManager } from '../goals/goal-note-manager';
import type { PendingSolicitation } from '../solicitations/solicitation-manager';
import type { UiFeedbackKind } from '../feedback/ui-feedback-store';

export const VIEW_TYPE_GOAL_DISPATCH = 'obsidian-goal-dispatch';

// ---------------------------------------------------------------------------
// Execution context tracking
// ---------------------------------------------------------------------------

interface TaskCtx {
  index: number;
  description: string;
  startedAt: number;
}

interface ExecCtx {
  variantId?: string;
  tasks: Map<string, TaskCtx>;
}

/** Shorten a variant/resolver/vessel id to a readable slug (last 2 segments). */
function shortId(id: string): string {
  const parts = id.split(/[-_:]/);
  return parts.slice(-2).join('-');
}

/** Human label for resolver tier. */
function tierLabel(tier: string | undefined): string {
  if (tier === 'deterministic') return 'fast';
  if (tier === 'pattern') return 'cached';
  if (tier === 'llm') return 'llm';
  return tier ?? '';
}

/** Format milliseconds as a compact duration string (sub-second precision). */
function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Compact relative elapsed: "42s", "7m", "3h", "2d". No ISO anywhere. */
function fmtRel(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Truncate a string for inline preview. */
function preview(val: unknown, max = 70): string {
  const s = typeof val === 'string' ? val : JSON.stringify(val);
  if (!s || s === 'null' || s === '{}') return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------------------------------------------------------------------------
// Decision-tree shapes (goalWalkState.steps — defensive; goal-host lands these
// under this contract, and this renderer degrades to walkLog/poolEvents without
// it so it works whether or not goal-host's `steps` has landed yet).
// ---------------------------------------------------------------------------

type WalkSource =
  | 'thompson'
  | 'satisfier'
  | 'bridge'
  | 'recovery'
  | 'improvise'
  | string;

interface WalkSelected {
  templateId?: string;
  source?: WalkSource;
  sampledScore?: number;
  alpha?: number;
  beta?: number;
}

interface WalkCandidate {
  templateId?: string;
  alpha?: number;
  beta?: number;
  sampledScore?: number;
  rejectedBecause?: string;
}

interface WalkExcluded {
  templateId?: string;
  reason?: string;
}

interface WalkStep {
  index?: number;
  at?: number;
  selected?: WalkSelected;
  candidates?: WalkCandidate[];
  excluded?: WalkExcluded[];
  status?: string;
  newShapes?: string[];
  rationale?: string;
  shadow?: boolean;
  poolBefore?: string[];
  poolAfter?: string[];
}

interface WalkLearning {
  alphaBetaDelta?: Record<string, unknown> | number | string;
  oracleLabelWritten?: boolean;
  gapsFiled?: string[];
}

/** Short human label for a walk selection source. */
/**
 * Why did this gap close? Prefer the most causal signal available:
 * a landed commit from the decision→outcome join, then lifecycle
 * auto-close reasons, then operator closure evidence, then the
 * closure summary itself.
 */
function gapClosureCause(g: Record<string, unknown>, meta: Record<string, unknown>): { badge: string; detail: string } {
  const decisions = Array.isArray(meta.approach_decisions)
    ? (meta.approach_decisions as Array<Record<string, unknown>>)
    : [];
  for (let i = decisions.length - 1; i >= 0; i--) {
    const o = decisions[i]?.outcome as Record<string, unknown> | undefined;
    if (o?.landed) {
      const commit = typeof o.commit === 'string' && o.commit ? String(o.commit).slice(0, 7) : '';
      return { badge: commit ? `landed @ ${commit}` : 'fix landed', detail: `authoring attempt landed${commit ? ` in commit ${commit}` : ''}${o.verdict ? ` (${String(o.verdict)})` : ''}` };
    }
  }
  const reason = typeof meta.closed_reason === 'string' ? meta.closed_reason : '';
  if (reason) {
    const by = typeof meta.closed_by === 'string' ? ` by ${meta.closed_by}` : '';
    return { badge: reason.replace(/_/g, ' '), detail: `auto-closed${by}: ${reason.replace(/_/g, ' ')}` };
  }
  const ev = (g as Record<string, unknown>).closure_evidence ?? meta.closure_evidence;
  if (ev && typeof ev === 'object') {
    const e = ev as Record<string, unknown>;
    const commit = typeof e.commit === 'string' ? e.commit : '';
    return { badge: 'verified closed', detail: commit ? `closed with evidence: ${commit}` : 'closed with recorded evidence' };
  }
  const summary = typeof g.summary === 'string' ? g.summary : '';
  const m = summary.match(/^\[([^\]]*)\]/);
  return { badge: m ? m[1]!.slice(0, 24) : 'closed', detail: summary.slice(0, 200) };
}

function sourceLabel(source: string | undefined): string {
  switch (source) {
    case 'thompson': return 'thompson';
    case 'satisfier': return 'satisfier';
    case 'bridge': return 'bridge';
    case 'recovery': return 'recovery';
    case 'improvise': return 'improvise';
    // Gap sources (substrateGap.source) — the "why it's being worked on" signal.
    case 'substrate_detected': return 'detected';
    case 'goal_host_auto_draft': return 'auto-draft';
    case 'operator_narration': return 'operator';
    case 'operator_verified': return 'op-verified';
    case 'gap_decompose': return 'decomposed';
    default: return source ?? 'step';
  }
}

/** Compact α/β or sampled-score annotation for a template chip. */
function scoreAnnot(s: { alpha?: number; beta?: number; sampledScore?: number }): string {
  if (typeof s.sampledScore === 'number') return `θ${s.sampledScore.toFixed(2)}`;
  if (typeof s.alpha === 'number' || typeof s.beta === 'number') {
    return `α${(s.alpha ?? 0).toFixed(1)}/β${(s.beta ?? 0).toFixed(1)}`;
  }
  return '';
}

/**
 * Extract the one-line reach rationale from a walkState body. Prefers the
 * REACHED prose from currentStep ("… REACHED via N-step chain — <prose>.. "),
 * falling back to the last walkLog line, then goalReachReason.
 */
function extractReachRationale(body: Record<string, unknown>): string {
  const cur = typeof body.currentStep === 'string' ? body.currentStep : '';
  const walk = Array.isArray(body.walkLog) ? (body.walkLog as unknown[]).map(String) : [];
  const src = cur || (walk.length ? walk[walk.length - 1] : '');
  if (src) {
    const m = src.match(/—\s*(.+?)\.?\s*(?:completion_shapes=|$)/);
    if (m && m[1]) return m[1].trim().replace(/\.\.$/, '.');
    return src.replace(/^\[goal-host-vessel\]\s*/, '').replace(/^walk\([^)]*\):\s*/, '');
  }
  if (typeof body.goalReachReason === 'string') return body.goalReachReason as string;
  return '';
}

/**
 * Sub-activity templates that are pure infrastructure — IAS Executor's
 * binding-layer, validator-dispatch, shape-provider escalation, and
 * substrate-internal observer ticks. They fire dozens of nested
 * activity.started/task.* events per real user task. The user-facing
 * dispatch view collapses them into a single suppressed counter so the
 * panel shows only the activity's real tasks + cross-vessel resolutions
 * + the minted concept. To inspect them, look at the trace in workbench.
 *
 * Matched by substring against `templateId` / `templateName`. Keep this
 * list narrow — if a new infrastructure template floods the panel, add
 * it here rather than building a general suppression policy.
 */
const HIDDEN_TEMPLATE_FRAGMENTS = [
  'slot-binding',
  'Slot Binding',
  'validator-dispatch',
  'Validator Dispatch',
  'create-shape-provider-goal',
  'Create Shape-Provider Goal',
  'mitosis-pending-observer-tick',
];

function isHiddenTemplate(name: string | undefined): boolean {
  if (!name) return false;
  return HIDDEN_TEMPLATE_FRAGMENTS.some((f) => name.includes(f));
}

export class GoalDispatchView extends ItemView {
  private plugin: ObsidianVesselPlugin;

  // DOM elements
  private omniboxWrapEl: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private dispatchBtn: HTMLButtonElement | null = null;
  private scrollEl: HTMLElement | null = null;   // THE one scroll container
  private outputEl: HTMLElement | null = null;   // feed-lines region inside scrollEl

  // State
  private ws: WebSocket | null = null;
  private wsReconnectTimer: number | null = null;
  private activeExecutionId: string | null = null;
  private activeDispatchId: string | null = null;
  private goalFile: TFile | null = null;
  private goalNoteManager: GoalNoteManager;
  private dispatching = false;
  private elapsedTimer: number | null = null;
  private dispatchStartedAt: number | null = null;

  // Execution context: tracks activity name + task descriptions per execId
  private execCtxs = new Map<string, ExecCtx>();

  // Event buffer: accumulate WS messages while waiting for the real executionId
  // from the poll. Keyed by execId so we can replay just the right one.
  private eventBuffer = new Map<string, Array<Record<string, unknown>>>();
  private buffering = false;

  // Concepts minted during the active dispatch — appended to the goal note on completion.
  private mintedConcepts: Array<{ id: string; summary?: string }> = [];

  // Suppressed infrastructure events for the active dispatch. Per HIDDEN_TEMPLATE_FRAGMENTS:
  // when an activity.started fires for one of those templates we register its execId here
  // and silently drop every subsequent event on that execId, incrementing the counter so
  // the user can see how many were collapsed without their content flooding the panel.
  private hiddenExecIds = new Set<string>();
  private suppressedCount = 0;
  private suppressedSummaryLine: HTMLElement | null = null;

  // Fleet board (WS6): in-flight dispatches pinned above the feed; completed
  // dispatches collapse to a one-line count (expandable).
  private fleetEl: HTMLElement | null = null;
  private completedEl: HTMLElement | null = null;
  private completedDispatches: Array<Record<string, unknown>> = [];
  private completedExpanded = false;
  private fleetTimer: number | null = null;
  // Dispatch rows the user has expanded — persisted across the 7s fleet
  // re-render so a running walk's live "why" trail stays open and refreshes.
  private expandedDispatches = new Set<string>();
  // Solicitation cards (WS5) + substrate-activity feed (WS3).
  private solicitationsEl: HTMLElement | null = null;
  private unsubscribeSolicitations: (() => void) | null = null;
  private touchesEl: HTMLElement | null = null;
  private touchesExpanded = false;
  private unsubscribeTouches: (() => void) | null = null;
  // Work board: what the system is working on beyond in-flight goals —
  // self-improvement gaps (substrateGap) and longer-lived project threads
  // (memoryNote type=project), both from development-vessel. Collapsed by
  // default; polled on a slow cadence (they change far less than dispatches).
  private gapsEl: HTMLElement | null = null;
  private projectsEl: HTMLElement | null = null;
  private pulseEl: HTMLElement | null = null;
  private gapsExpanded = false;
  // per-gap causal-thread expansion (gap id -> expanded)
  private gapDetailExpanded: Set<string> = new Set();
  private projectsExpanded = false;
  private workBoardTimer: number | null = null;
  // shape -> resolved host-reachable resolve URL, via discovery (the one fixed
  // point). Cached briefly so the 30s work-board poll doesn't re-hit discovery
  // every tick. Connections flow through discovery shapes, never hardcoded
  // vessel endpoints (discovery derives host-reachable public_endpoints).
  private shapeRouteCache = new Map<string, { url: string; at: number }>();

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianVesselPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.goalNoteManager = new GoalNoteManager(plugin.app);
  }

  getViewType(): string {
    return VIEW_TYPE_GOAL_DISPATCH;
  }

  getDisplayText(): string {
    return 'Goal Dispatch';
  }

  getIcon(): string {
    return 'bot';
  }

  async onOpen(): Promise<void> {
    this.buildUI();
    // Apply any Substrate/theme-tokens.md overrides to this panel root.
    void this.plugin.refreshThemeTokens();
    if (this.plugin.settings.enableGoalDispatch) {
      this.connectWS();
    }
    this.startFleetBoard();
    this.startWorkBoard();
    this.startSolicitationCards();
    this.startTouchFeed();
  }

  async onClose(): Promise<void> {
    this.disconnectWS();
    this.stopFleetBoard();
    this.stopWorkBoard();
    this.unsubscribeSolicitations?.();
    this.unsubscribeSolicitations = null;
    this.unsubscribeTouches?.();
    this.unsubscribeTouches = null;
  }

  // ---------------------------------------------------------------------------
  // UI construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('obsidian-goal-dispatch-view');

    // ── Omnibox: single-line input, expands to multiline on focus ──
    const omnibox = contentEl.createDiv('sub-omnibox');
    this.omniboxWrapEl = omnibox;
    this.textarea = omnibox.createEl('textarea', {
      cls: 'sub-omnibox-input',
      attr: { placeholder: 'Goal… (⌘↵ to dispatch)', rows: '1' },
    });
    this.textarea.addEventListener('keydown', (ev: KeyboardEvent) => {
      // Ctrl/Cmd+Enter to dispatch
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.dispatchFromUI();
      }
    });
    this.textarea.addEventListener('focus', () => {
      omnibox.addClass('is-expanded');
      this.textarea?.setAttribute('rows', '4');
    });
    this.textarea.addEventListener('blur', () => {
      // Collapse back to a single line only when empty; keep drafted text visible.
      if (!this.textarea?.value.trim()) {
        omnibox.removeClass('is-expanded');
        this.textarea?.setAttribute('rows', '1');
      }
    });

    const actions = omnibox.createDiv('sub-omnibox-actions');
    this.dispatchBtn = actions.createEl('button', {
      text: 'Dispatch',
      cls: 'mod-cta sub-omnibox-dispatch',
    });
    this.dispatchBtn.addEventListener('click', () => this.dispatchFromUI());
    const clearBtn = actions.createEl('button', {
      text: 'Clear',
      cls: 'sub-omnibox-clear',
    });
    clearBtn.addEventListener('click', () => this.clearOutput());
    actions.createSpan({ cls: 'sub-omnibox-hint', text: '⌘↵' });

    // ── Priority stack (pinned above the scroll container) ──
    // 1. Solicitation cards (WS5) — the substrate asking the human.
    this.pulseEl = contentEl.createDiv('sub-section sub-pulse');
        this.solicitationsEl = contentEl.createDiv('sub-section sub-solicitations');
    // 2. Fleet rows (WS6) — in-flight dispatches, collapsed one-liners.
    this.fleetEl = contentEl.createDiv('sub-section sub-fleet');
    // 3. Completed goals — one-line count, expandable.
    this.completedEl = contentEl.createDiv('sub-section sub-completed');
    // 4. Gaps — the substrate's self-improvement backlog (what it's working
    //    on fixing in itself), collapsed to a count.
    this.gapsEl = contentEl.createDiv('sub-section sub-gaps');
    // 5. Projects — longer-lived work threads, collapsed to a count.
    this.projectsEl = contentEl.createDiv('sub-section sub-projects');

    // ── ONE scroll container: event feed + collapsed vault-touch feed ──
    this.scrollEl = contentEl.createDiv('sub-scroll');
    this.outputEl = this.scrollEl.createDiv('sub-feed');
    // 4. Vault-touch feed (WS3) — last, collapsed by default.
    this.touchesEl = this.scrollEl.createDiv('sub-touches');

    // uiFeedback capture affordance: right-click any sub-card / sub-chip /
    // sub-feed-line → complaint menu. The component's class list gives the
    // region automatically — the human never types a class name.
    contentEl.addEventListener('contextmenu', (ev: MouseEvent) => {
      const target = (ev.target as HTMLElement | null)?.closest?.(
        '.sub-card, .sub-chip, .sub-feed-line',
      ) as HTMLElement | null;
      if (!target) return;
      ev.preventDefault();
      ev.stopPropagation();
      const region = Array.from(target.classList)
        .filter((c) => c.startsWith('sub-'))
        .join(' ') || 'sub-unknown';
      const menu = new Menu();
      const kinds: Array<[UiFeedbackKind, string]> = [
        ['hard_to_see', 'Hard to see'],
        ['hard_to_understand', 'Hard to understand'],
        ['cramped', 'Cramped'],
        ['wasted_space', 'Wasted space'],
      ];
      for (const [kind, label] of kinds) {
        menu.addItem((item) =>
          item.setTitle(`UI feedback: ${label}`).setIcon('frown').onClick(async () => {
            const prose = window.prompt(`${label} — optional detail (Cancel = none):`) ?? undefined;
            await this.plugin.captureUiFeedback({
              surface: 'panel',
              region,
              kind,
              prose: prose?.trim() || undefined,
            });
            new Notice(`UI feedback recorded: ${kind} on ${region}`);
          }),
        );
      }
      menu.showAtMouseEvent(ev);
    });

    this.appendMessage('Ready. Type a goal above (⌘↵ dispatches).', 'ready');
  }

  // ---------------------------------------------------------------------------
  // Vault context collection
  // ---------------------------------------------------------------------------

  /**
   * Snapshot the current Obsidian workspace state into a VaultContext.
   *
   * The snapshot is passed as `variables` to /run-goal so activities can
   * reference live vault content via template interpolation:
   *   - {{active_note_path}}   → path of the focused note
   *   - {{selection}}          → selected text (if any)
   *   - {{open_note_paths}}    → JSON array of open tabs
   *   - {{vault_path}}         → filesystem root of the vault
   *   - {{obsidian_vessel_endpoint}} → resolver call-back URL
   *
   * Activities that have tasks with resolver `obsidian:note` will
   * automatically receive these variables in their impulse pointer.
   * The `available_shapes` list is forwarded as `expected_output_shapes`
   * to bias Thompson sampling toward vault-aware activities.
   */
  private collectVaultContext(): VaultContext {
    const app = this.plugin.app;
    const ctx: VaultContext = {};

    // Active note
    const activeFile = app.workspace.getActiveFile();
    if (activeFile) {
      ctx.active_note_path = activeFile.path;

      // Cursor section: heading breadcrumb from the active MarkdownView
      const mdView = app.workspace.getActiveViewOfType(MarkdownView);
      if (mdView) {
        const editor = mdView.editor;
        const cursor = editor.getCursor();
        const cache = app.metadataCache.getFileCache(activeFile);
        if (cache?.headings?.length) {
          // Walk headings in order; last one whose line <= cursor line is active
          const activeHeadings: string[] = [];
          let lastLevel = 0;
          for (const h of cache.headings) {
            if (h.position.start.line > cursor.line) break;
            if (h.level <= lastLevel || activeHeadings.length === 0) {
              // pop deeper headings when we encounter a same-or-higher level
              while (activeHeadings.length > 0 && h.level <= lastLevel) {
                activeHeadings.pop();
                lastLevel = h.level - 1;
              }
            }
            activeHeadings.push(h.heading);
            lastLevel = h.level;
          }
          if (activeHeadings.length) ctx.active_note_section = activeHeadings.join(' › ');
        }

        // Selection
        const sel = editor.getSelection();
        if (sel?.trim()) ctx.selection = sel.trim();
      }
    }

    // All open markdown leaves → distinct paths
    const openPaths = new Set<string>();
    app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        openPaths.add(view.file.path);
      }
    });
    if (openPaths.size > 0) ctx.open_note_paths = Array.from(openPaths);

    // Vault filesystem root
    const adapter = app.vault.adapter as { basePath?: string };
    if (adapter.basePath) ctx.vault_path = adapter.basePath;

    // Obsidian-vessel HTTP endpoint so activities can call back for resolution
    const port = this.plugin.settings.serverPort;
    if (port && this.plugin.settings.serverEnabled) {
      ctx.obsidian_vessel_endpoint = `http://127.0.0.1:${port}`;
    }

    // Shapes this context makes available for impulse resolution
    ctx.available_shapes = [...this.plugin.settings.shapes];

    return ctx;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Read goal from the omnibox and dispatch.
   */
  private async dispatchFromUI(): Promise<void> {
    const goal = this.textarea?.value.trim() ?? '';
    if (!goal) {
      new Notice('Enter a goal first.');
      return;
    }
    await this.dispatchGoal(goal);
  }

  /**
   * Dispatch a goal. Can be called externally (e.g. from GoalInputModal command).
   */
  async dispatchGoal(goal: string): Promise<void> {
    if (this.dispatching) {
      new Notice('A goal is already dispatching. Please wait.');
      return;
    }

    if (!this.plugin.settings.enableGoalDispatch) {
      new Notice('Goal dispatch is disabled in settings.');
      return;
    }

    const { goalHostEndpoint, apiKey } = this.plugin.settings;

    if (!apiKey) {
      new Notice('Obsidian: API key not configured. Set it in plugin settings.');
      return;
    }

    this.dispatching = true;
    this.setDispatchBtnState(true);
    this.clearOutput();
    this.execCtxs.clear();
    this.mintedConcepts = [];
    this.hiddenExecIds.clear();
    this.suppressedCount = 0;
    this.suppressedSummaryLine = null;
    this.dispatchStartedAt = Date.now();
    this.appendMessage(`⟶ Goal: "${goal}"`);

    // Collect and display the vault context that will accompany the goal
    const ctx = this.collectVaultContext();
    this.appendVaultContextSummary(ctx);
    try {
      const client = new GoalHostClient(goalHostEndpoint, apiKey);

      // Start buffering WS events NOW — the execution may complete and fire
      // its events BEFORE the poll returns the executionId (auto-draft LLM
      // calls can take 30+ seconds while the actual execution runs in <100ms).
      this.eventBuffer.clear();
      this.buffering = true;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.connectWS();
      }

      // Step 1: dispatch → 202 with dispatchId
      const result = await client.dispatchGoal(goal, ctx);
      const dispatchId = result.executionId; // holds dispatchId from 202 body
      this.activeDispatchId = dispatchId;

      // Show elapsed time while the auto-draft LLM selects/authors an activity.
      // This can take 30-120s; without feedback the UI looks frozen.
      const selectStart = Date.now();
      this.elapsedTimer = window.setInterval(() => {
        const secs = Math.floor((Date.now() - selectStart) / 1000);
        this.updateSelectingMessage(secs);
      }, 5000);
      this.updateSelectingMessage(0);

      // Step 2: poll until the real execution_id is known, then replay buffer.
      // Throws with a descriptive message on persistent failure.
      const { executionId, variantId: dispatchVariantId } = await client.pollExecutionId(dispatchId);
      if (this.elapsedTimer !== null) { window.clearInterval(this.elapsedTimer); this.elapsedTimer = null; }

      // Step 3: replay buffered events for this execution_id, then switch to live
      // (elapsedTimer is cleared above on success; catch block clears on failure)
      this.buffering = false;
      this.activeExecutionId = executionId;

      // Seed execCtx from poll response so we have the variant name before
      // execution_started events arrive (or in case they were already buffered).
      if (dispatchVariantId) {
        const ctx2 = this.getExecCtx(executionId);
        ctx2.variantId = ctx2.variantId ?? dispatchVariantId;
        this.appendMessage(`◈ Activity: ${dispatchVariantId}`);
      }
      this.appendMessage('─'.repeat(36), 'divider');

      const buffered = this.eventBuffer.get(executionId) ?? [];
      if (buffered.length > 0) {
        for (const msg of buffered) this.processWSEvent(msg);
      }
      this.eventBuffer.clear();

      // Fire impulse relevance feedback for the obsidian shapes in context.
      const variantId = this.execCtxs.get(executionId)?.variantId ?? dispatchVariantId;
      if (variantId && ctx?.available_shapes?.length) {
        const completedEvent = buffered.find(m =>
          m.type === 'execution_completed' || m.type === 'activity.completed',
        );
        const completedData = (completedEvent?.data ?? completedEvent ?? {}) as Record<string, unknown>;
        const succeeded = completedData.success !== false;
        // Fire and forget — don't await, don't block the UI
        void client.recordImpulseRelevance(
          this.plugin.settings.activityApiUrl,
          executionId,
          variantId,
          ctx.available_shapes,
          succeeded,
        );
      }

      this.goalFile = await this.goalNoteManager.createGoalNote(executionId, goal);
      if (this.goalFile) {
        // Live walk-progress into the note while the dispatch runs; writes the
        // honest reach verdict (not just exit status) on completion.
        void this.goalNoteManager.trackProgress(this.goalFile, dispatchId, client);
      }
    } catch (error) {
      if (this.elapsedTimer !== null) { window.clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
      const msg = error instanceof Error ? error.message : String(error);
      this.appendMessage(`Error dispatching goal: ${msg}`, 'error');
      new Notice(`Goal dispatch failed: ${msg}`);
      this.buffering = false;
      this.dispatching = false;
      this.setDispatchBtnState(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Output helpers
  // ---------------------------------------------------------------------------

  /** Relative timestamp for feed lines: elapsed since the active dispatch. */
  private feedTs(): string {
    if (this.dispatchStartedAt === null) return '·';
    return `+${fmtRel(Date.now() - this.dispatchStartedAt)}`;
  }

  /** Auto-scroll the single scroll container to the bottom. */
  private scrollToBottom(): void {
    if (this.scrollEl) this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  /**
   * Append a timestamped message line to the event feed.
   * Also callable from external code (e.g. after WS reconnect).
   *
   * type maps to CSS class sub-t-{type} for color-coding:
   *   ready | success | failure | error | task | tool | impulse | divider
   */
  appendMessage(text: string, type?: string): void {
    if (!this.outputEl) return;
    const cls = ['sub-feed-line', type ? `sub-t-${type}` : ''].filter(Boolean).join(' ');
    const line = this.outputEl.createDiv(cls);
    line.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
    line.createSpan({ cls: 'sub-feed-msg', text });
    this.scrollToBottom();
  }

  /**
   * Emit a concise impulse state space summary so an outside observer can see
   * exactly what vault context was attached to the goal.
   */
  private appendVaultContextSummary(ctx: VaultContext): void {
    const parts: string[] = [];

    if (ctx.active_note_path) {
      const name = ctx.active_note_path.split('/').pop() ?? ctx.active_note_path;
      const section = ctx.active_note_section ? ` › ${ctx.active_note_section}` : '';
      parts.push(`active: ${name}${section}`);
    } else {
      parts.push('active: none');
    }

    if (ctx.selection) {
      const snippet = ctx.selection.length > 40
        ? ctx.selection.slice(0, 40) + '…'
        : ctx.selection;
      parts.push(`selection: "${snippet}"`);
    }

    const openCount = ctx.open_note_paths?.length ?? 0;
    if (openCount > 1) {
      parts.push(`open: ${openCount} notes`);
    }

    if (ctx.available_shapes?.length) {
      parts.push(`shapes: ${ctx.available_shapes.length}`);
    }

    this.appendMessage(`◎ Context  ${parts.join('  ·  ')}`, 'impulse');
  }

  /** Update (or create) the 'selecting' status line in place rather than appending. */
  private updateSelectingMessage(elapsedSecs: number): void {
    if (!this.outputEl) return;
    const existing = this.outputEl.querySelector('.sub-t-selecting');
    const text = elapsedSecs === 0
      ? 'Activity selecting…'
      : `Activity selecting…  ${elapsedSecs}s`;
    if (existing) {
      existing.querySelector('.sub-feed-msg')!.textContent = text;
    } else {
      const line = this.outputEl.createDiv('sub-feed-line sub-t-ready sub-t-selecting');
      line.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
      line.createSpan({ cls: 'sub-feed-msg', text });
    }
    this.scrollToBottom();
  }


  // ---------------------------------------------------------------------------
  // Fleet board (WS6) + solicitation cards (WS5) + substrate activity (WS3)
  // ---------------------------------------------------------------------------

  /**
   * POST JSON via Obsidian's requestUrl (NOT fetch) — the Electron renderer
   * blocks cross-origin fetch with CORS, so every panel network call must go
   * through requestUrl like the rest of the plugin (see GoalHostClient). Returns
   * parsed JSON or null on any non-2xx / transport error.
   */
  private async postJson(url: string, body: unknown): Promise<Record<string, unknown> | null> {
    try {
      const r = await requestUrl({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.plugin.settings.apiKey ? { Authorization: `ApiKey ${this.plugin.settings.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        throw: false,
      });
      if (r.status < 200 || r.status >= 300) return null;
      return r.json as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async goalHostResolve(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const base = this.plugin.settings.goalHostEndpoint.replace(/\/+$/, '');
    return this.postJson(`${base}/resolve`, body);
  }

  private startFleetBoard(): void {
    const tick = async (): Promise<void> => {
      if (!this.fleetEl) return;
      const j = await this.goalHostResolve({ type: 'activeDispatches' });
      if (!j) return;
      const dispatches = ((j.body as Record<string, unknown> | undefined)?.dispatches ?? []) as Array<Record<string, unknown>>;
      if (
        this.activeDispatchId &&
        dispatches.some(
          (d: Record<string, unknown>) =>
            d.id === this.activeDispatchId &&
            (d.status === 'completed' || d.status === 'failed')
        )
      ) {
        if (this.elapsedTimer !== null) { window.clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
        this.dispatching = false;
        this.setDispatchBtnState(false);
        this.activeDispatchId = null;
      }
      this.renderFleet(dispatches);
    };
    void tick();
    this.fleetTimer = window.setInterval(() => void tick(), 7000);
  }

  private stopFleetBoard(): void {
    if (this.fleetTimer !== null) {
      window.clearInterval(this.fleetTimer);
      this.fleetTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Work board (goals + GAPS + PROJECTS): what the system is working on beyond
  // in-flight dispatches. Gaps = the substrate's self-improvement backlog
  // (substrateGap); projects = longer-lived threads (memoryNote type=project).
  // Both live on development-vessel and change slowly, so poll on a 30s cadence.
  // ---------------------------------------------------------------------------

  /**
   * Resolve which host-reachable URL serves a shape, by asking discovery (the
   * ONE fixed point). Prefers the vessel's `public_endpoint` (discovery derives
   * a host-reachable one for in-container vessels) and appends the vessel's
   * advertised resolve path. No hardcoded per-shape endpoints — if a vessel
   * moves, discovery reflects it and the panel follows. Cached ~60s.
   */
  private async resolveShapeRoute(shape: string): Promise<string | null> {
    const cached = this.shapeRouteCache.get(shape);
    if (cached && Date.now() - cached.at < 60000) return cached.url;
    const disco = (this.plugin.settings.discoveryVesselEndpoint || '').replace(/\/+$/, '');
    if (!disco) return null;
    try {
      const j = await this.postJson(`${disco}/resolve`, { pointer: { type: 'vesselCapability', shape } });
      if (!j) return null;
      const vessels = ((j.content as Record<string, unknown> | undefined)?.vessels ?? []) as Array<Record<string, unknown>>;
      const v = vessels[0];
      if (!v) return null;
      const candidates = [String(v.public_endpoint || ''), String(v.endpoint || '')].map((s) => s.replace(/\/+$/, '')).filter((s, i, a) => s && a.indexOf(s) === i);
        let base = candidates[0] ?? '';
        for (const cand of candidates) {
        try {
          const probe = await requestUrl({ url: cand + '/health', method: 'GET', throw: false });
          if (probe.status >= 200 && probe.status < 300) { base = cand; break; }
        } catch { /* try next candidate */ }
      }
      if (!base) return null;
      // resolve_endpoint may be a path ("/v2/impulses/resolve") or an absolute
      // (in-container) URL — take just its path and hang it off the reachable base.
      const rawResolve = String(v.resolve_endpoint || '/resolve');
      let path = rawResolve;
      if (/^https?:\/\//.test(rawResolve)) {
        try { const u = new URL(rawResolve); path = u.pathname + u.search; } catch { path = '/resolve'; }
      }
      const url = base + (path.startsWith('/') ? path : `/${path}`);
      this.shapeRouteCache.set(shape, { url, at: Date.now() });
      return url;
    } catch {
      return null;
    }
  }

  /** Resolve a shape through discovery (never a hardcoded endpoint). */
  private async devVesselResolve(
    shape: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const url = await this.resolveShapeRoute(shape);
    if (!url) return null;
    return this.postJson(url, { impulse: { type: shape, ...extra } });
  }

  private startWorkBoard(): void {
    const tick = (): void => {
      void this.renderGaps();
      void this.renderProjects();
      void this.renderPulse();
    };
    tick();
    this.workBoardTimer = window.setInterval(tick, 30000);
  }

  private stopWorkBoard(): void {
    if (this.workBoardTimer !== null) {
      window.clearInterval(this.workBoardTimer);
      this.workBoardTimer = null;
    }
  }

  /**
   * Gaps section: the substrate's self-improvement backlog. Each gap's SOURCE
   * badge is the "why it's being worked on" signal — substrate_detected (a
   * detector found it), goal_host_auto_draft (the walk chose to draft a fix),
   * operator_narration (a human filed it), gap_decompose (split from a bigger
   * gap). Collapsed to an open/closed count; expands to the recent open gaps.
   */
  private async renderGaps(): Promise<void> {
    const el = this.gapsEl;
    if (!el) return;
    const j = await this.devVesselResolve('substrateGap', { limit: 200 });
    const gaps = ((j?.body as Record<string, unknown> | undefined)?.gaps ?? []) as Array<Record<string, unknown>>;
    el.empty();
    if (gaps.length === 0) return;
    const open = gaps.filter((g) => g.status === 'open');
    const closed = gaps.filter((g) => g.status === 'closed');
    const header = el.createDiv({
      cls: 'sub-section-header is-toggle',
      text: `${this.gapsExpanded ? '▾' : '▸'} Gaps — ${open.length} open · ${closed.length} closed`,
    });
    header.addEventListener('click', () => {
      this.gapsExpanded = !this.gapsExpanded;
      void this.renderGaps();
    });
    if (!this.gapsExpanded) return;
    const ts = (g: Record<string, unknown>): number => {
      const v = g.updated_at ?? g.detected_at ?? g.created_at;
      const n = typeof v === 'string' ? Date.parse(v) : 0;
      return Number.isFinite(n) ? n : 0;
    };
    const recent = [...open].sort((a, b) => ts(b) - ts(a)).slice(0, 15);
    for (const g of recent) {
      const row = el.createDiv('sub-card sub-gap-row');
      const src = String(g.source ?? 'unknown');
      const label = String(g.category ?? g.id ?? '(gap)');
      row.createSpan({ cls: 'sub-gap-cat', text: label.length > 42 ? label.slice(0, 42) + '…' : label, attr: { title: String(g.id ?? label) } });
      row.createSpan({ cls: `sub-badge sub-badge--${src.replace(/[^a-z]/gi, '')}`, text: sourceLabel(src), attr: { title: `source: ${src}` } });
      const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
      const fails = Number(meta.failed_attempts ?? 0);
      if (fails > 0) {
        row.createSpan({ cls: 'sub-badge sub-badge--fails', text: `✗${fails}`, attr: { title: `${fails} authoring attempt(s) did not land` } });
      }
      const t = ts(g);
      if (t) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - t) });
      const summary = typeof g.summary === 'string' ? g.summary : '';
      if (summary) {
        const clean = summary.replace(/^\[[^\]]*\]\s*/, '');
        row.createDiv({ cls: 'sub-gap-summary', text: clean.length > 110 ? clean.slice(0, 110) + '…' : clean, attr: { title: summary } });
      }
      this.renderGapThread(row, g, meta);
    }
    if (open.length > recent.length) {
      el.createDiv({ cls: 'sub-fleet-note', text: `+${open.length - recent.length} more open (newest 15 shown)` });
    }
    // Recently closed — the "behavior changed because of X" half of the loop.
    // Each closed gap states its closure cause (landed commit, auto-close
    // reason, or operator evidence) instead of silently vanishing.
    const closedRecent = [...closed].sort((a, b) => ts(b) - ts(a)).slice(0, 6);
    if (closedRecent.length > 0) {
      el.createDiv({ cls: 'sub-section-header', text: 'Recently closed — why' });
      for (const g of closedRecent) {
        const row = el.createDiv('sub-card sub-gap-row is-closed');
        const label = String(g.category ?? g.id ?? '(gap)');
        row.createSpan({ cls: 'sub-gap-cat', text: label.length > 42 ? label.slice(0, 42) + '…' : label, attr: { title: String(g.id ?? label) } });
        const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
        const cause = gapClosureCause(g, meta);
        row.createSpan({ cls: 'sub-badge sub-badge--closed', text: cause.badge, attr: { title: cause.detail } });
        const t = ts(g);
        if (t) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - t) });
        if (cause.detail) {
          row.createDiv({ cls: 'sub-gap-summary', text: cause.detail.length > 110 ? cause.detail.slice(0, 110) + '…' : cause.detail, attr: { title: cause.detail } });
        }
        this.renderGapThread(row, g, meta);
      }
    }
  }

  /**
   * Causal thread for one gap: the recorded approach decisions and their
   * joined outcomes (predicted land probability → landed/failed → commit).
   * This is the gap → fix-attempt → behavior-change link, rendered from the
   * decision→outcome join gap_to_feature writes into classification_metadata.
   * Rows with a thread get a "▸ N attempts" toggle; rows without stay plain.
   */
  private renderGapThread(row: HTMLElement, g: Record<string, unknown>, meta: Record<string, unknown>): void {
    const decisions = Array.isArray(meta.approach_decisions)
      ? (meta.approach_decisions as Array<Record<string, unknown>>)
      : [];
    if (decisions.length === 0) return;
    const id = String(g.id ?? '');
    const expanded = this.gapDetailExpanded.has(id);
    const toggle = row.createDiv({
      cls: 'sub-fleet-note is-toggle',
      text: `${expanded ? '▾' : '▸'} ${decisions.length} fix attempt${decisions.length === 1 ? '' : 's'}`,
    });
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (expanded) this.gapDetailExpanded.delete(id); else this.gapDetailExpanded.add(id);
      void this.renderGaps();
    });
    if (!expanded) return;
    const list = row.createDiv('sub-gap-thread');
    for (const d of decisions.slice(-5)) {
      const line = list.createDiv('sub-fleet-note');
      const at = typeof d.at === 'string' ? d.at.slice(0, 16).replace('T', ' ') : '';
      const p = typeof d.predicted_p === 'number' ? `predicted ${(Number(d.predicted_p) * 100).toFixed(0)}%` : 'no prediction';
      const outcome = (d.outcome ?? null) as Record<string, unknown> | null;
      let result = '⋯ outcome pending';
      if (outcome) {
        const commit = typeof outcome.commit === 'string' && outcome.commit ? ` @ ${String(outcome.commit).slice(0, 7)}` : '';
        result = outcome.landed
          ? `✓ landed${outcome.verdict ? ` ${String(outcome.verdict)}` : ''}${commit}`
          : `✗ did not land${d.predicted_land ? ' (mispredicted)' : ''}`;
      }
      const site = typeof d.edit_site === 'string' && d.edit_site ? ` · ${String(d.edit_site).split('/').pop()}` : '';
      line.setText(`${at} · ${p} → ${result}${site}`);
      line.setAttr('title', JSON.stringify(d, null, 1).slice(0, 600));
    }
  }

  /**
   * Projects section: longer-lived work threads, from memoryNote type=project.
   * Read-only list of the most recent threads (title + age) — the "what has the
   * system been building toward" context behind the immediate goals.
   */
  /**
   * Pulse strip: the system's outcome metrics at a glance, composed ONLY from
   * data the panel already reads (dispatch ledger + gap store). Outcome over
   * activity: reach on recent dispatches, gap flow (open / closed last 24h),
   * and the oldest open gap's age. Rendered as sub-chips - no new primitives.
   */
  private async renderPulse(): Promise<void> {
    const el = this.pulseEl;
    if (!el) return;
    const [dj, gj, rhythmRes] = await Promise.all([
      this.goalHostResolve({ type: 'activeDispatches' }),
      this.devVesselResolve('substrateGap', { limit: 200 }),
      this.devVesselResolve('poolImpulse', { shape: 'timeShapedRhythm', limit: 12 }),
    ]);
    const dispatches = ((dj?.body as Record<string, unknown> | undefined)?.dispatches ?? []) as Array<Record<string, unknown>>;
    const gaps = ((gj?.body as Record<string, unknown> | undefined)?.gaps ?? []) as Array<Record<string, unknown>>;
    el.empty();
    const row = el.createDiv({ cls: 'sub-pulse-row' });
    const settled = dispatches.filter((d) => d['status'] === 'completed' || d['status'] === 'failed').slice(-10);
    if (settled.length) {
      const reachedCount = settled.filter((d) => d['reached'] === true || d['reached'] === 'yes').length;
      const chip = row.createSpan({ cls: 'sub-chip', text: `reach ${reachedCount}/${settled.length}` });
      chip.setAttr('title', 'Goal-reach verdicts on the last settled dispatches - the honest outcome signal, not exit status.');
    }
    if (gaps.length) {
      const open = gaps.filter((g) => g['status'] === 'open');
      const dayAgo = Date.now() - 86_400_000;
      const closed24 = gaps.filter((g) => g['status'] === 'closed' && Date.parse(String(g['updated_at'] ?? '')) > dayAgo).length;
      const chip = row.createSpan({ cls: 'sub-chip', text: `gaps ${open.length} open · ${closed24} closed/24h` });
      chip.setAttr('title', 'Gap flow: how much self-improvement backlog is open and how fast it is draining.');
      const oldest = open.map((g) => Date.parse(String(g['created_at'] ?? g['detected_at'] ?? ''))).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)[0];
      if (oldest !== undefined) {
        const hours = Math.round((Date.now() - oldest) / 3_600_000);
        const age = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
        const ageChip = row.createSpan({ cls: 'sub-chip', text: `oldest ${age}` });
        ageChip.setAttr('title', 'Age of the oldest open gap - the durability/latency edge of the close loop.');
      }
    }
    const rhythms: Array<{ id: string; body: { family: string; axis: string; staleness: number; budget: number; alpha: number; beta: number } }> =
      ((rhythmRes?.body as Record<string, unknown> | undefined)?.['impulses'] ?? []) as Array<{ id: string; body: { family: string; axis: string; staleness: number; budget: number; alpha: number; beta: number } }>;
    if (rhythms.length > 0) {
      const sorted = [...rhythms].sort((a, b) => b.body.staleness - a.body.staleness);
      const rhythmRow = el.createDiv({ cls: 'sub-pulse-row sub-pulse-rhythms' });
      const METER = '▁▂▃▄▅▆▇█';
      for (const rhythm of sorted) {
        const { family, axis, staleness, budget, alpha, beta } = rhythm.body;
        const meterChar = METER[Math.min(7, Math.floor(staleness * 8))];
        const chip = rhythmRow.createSpan({ cls: 'sub-chip' });
        chip.textContent = `${family} ${meterChar}`;
        chip.style.opacity = String(0.55 + 0.45 * staleness);
        chip.title = `rhythm ${family} · axis ${axis} · staleness ${Math.round(staleness * 100)}% · budget ${budget} · α${alpha}/β${beta} — due-ness the conductor folds into boredom selection`;
      }
    }
  }

  private async renderProjects(): Promise<void> {
    const el = this.projectsEl;
    if (!el) return;
    const j = await this.devVesselResolve('memoryNote', { note_type: 'project', limit: 40 });
    const notes = ((j?.body as Record<string, unknown> | undefined)?.notes ?? []) as Array<Record<string, unknown>>;
    el.empty();
    if (notes.length === 0) return;
    const ts = (n: Record<string, unknown>): number => {
      const v = n.updated_at ?? n.created_at ?? n.detected_at;
      const num = typeof v === 'string' ? Date.parse(v) : (typeof v === 'number' ? v : 0);
      return Number.isFinite(num) ? num : 0;
    };
    const recent = [...notes].sort((a, b) => ts(b) - ts(a)).slice(0, 8);
    const header = el.createDiv({
      cls: 'sub-section-header is-toggle',
      text: `${this.projectsExpanded ? '▾' : '▸'} Projects — ${notes.length}`,
    });
    header.addEventListener('click', () => {
      this.projectsExpanded = !this.projectsExpanded;
      void this.renderProjects();
    });
    if (!this.projectsExpanded) return;
    for (const n of recent) {
      const row = el.createDiv('sub-card sub-project-row');
      const title = String(n.title ?? n.id ?? '(project)');
      row.createSpan({ cls: 'sub-project-title', text: title, attr: { title } });
      const t = ts(n);
      if (t) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - t) });
    }
  }

  /**
   * Render one collapsed fleet row: status dot + goal snippet (full goal in
   * tooltip) + relative elapsed. Pool chips / missing targets / current step
   * render only on expansion (click).
   */
  private renderFleetRow(parent: HTMLElement, d: Record<string, unknown>, running: boolean): void {
    const row = parent.createDiv('sub-card sub-card--fleet');
    const dot = running ? '●' : d.reached === true ? '✓' : d.reached === false ? '✗' : '○';
    const statusCls = running ? 'is-running' : d.reached === true ? 'is-reached' : 'is-not-reached';
    const started = typeof d.startedAt === 'number' ? d.startedAt : 0;
    const elapsed = started ? fmtRel(Date.now() - started) : '';
    const goal = typeof d.goal === 'string' ? d.goal : '(no goal)';
    const goalSnippet = goal.length > 60 ? goal.slice(0, 60) + '…' : goal;
    row.createSpan({ cls: `sub-fleet-status ${statusCls}`, text: dot });
    row.createSpan({ cls: 'sub-fleet-goal', text: goalSnippet, attr: { title: goal } });
    row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });
    // Reached-led: when steps failed but the goal was still reached, say so
    // inline rather than letting the ✗-adjacent status imply failure.
    if (!running && d.reached === true && d.status === 'failed') {
      row.createSpan({ cls: 'sub-chip sub-chip--ok sub-fleet-note', text: 'goal reached', attr: { title: 'steps exited non-zero but the goal was reached' } });
    }
    row.addEventListener('click', () => void this.expandFleetRow(row, d));
    if (this.expandedDispatches.has(String(d.dispatchId ?? ''))) void this.renderFleetDetail(row, d);
    if (running) {
      const ctxBtn = row.createEl('button', { cls: 'sub-fleet-btn', text: '+ctx' });
      ctxBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        void this.injectContext(String(d.dispatchId ?? ''));
      });
    }
  }

  private renderFleet(dispatches: Array<Record<string, unknown>>): void {
    const el = this.fleetEl;
    if (!el) return;
    el.empty();
    const running = dispatches.filter((d) => d.status === 'running');
    this.completedDispatches = dispatches.filter((d) => d.status !== 'running');
    el.createDiv({ cls: 'sub-section-header', text: `Fleet — ${running.length} in flight` });
    if (running.length === 0) {
      el.createDiv({ cls: 'sub-fleet-empty', text: 'No dispatches in flight.' });
    }
    for (const d of running) this.renderFleetRow(el, d, true);
    this.renderCompleted();
  }

  /** Completed goals: a one-line count, expandable to collapsed rows. */
  private renderCompleted(): void {
    const el = this.completedEl;
    if (!el) return;
    el.empty();
    const done = this.completedDispatches;
    if (done.length === 0) return;
    const reached = done.filter((d) => d.reached === true).length;
    const header = el.createDiv({
      cls: 'sub-section-header is-toggle',
      text: `${this.completedExpanded ? '▾' : '▸'} ${done.length} completed (${reached} reached)`,
    });
    header.addEventListener('click', () => {
      this.completedExpanded = !this.completedExpanded;
      this.renderCompleted();
    });
    if (this.completedExpanded) {
      for (const d of done.slice(0, 10)) this.renderFleetRow(el, d, false);
    }
  }

  private async expandFleetRow(row: HTMLElement, d: Record<string, unknown>): Promise<void> {
    const id = String(d.dispatchId ?? '');
    const existing = row.querySelector('.sub-fleet-detail');
    if (existing) {
      existing.remove();
      this.expandedDispatches.delete(id);
      return;
    }
    this.expandedDispatches.add(id);
    await this.renderFleetDetail(row, d);
  }

  /**
   * Build (or rebuild) the expanded detail for a fleet row.
   *
   * Leads with the reached verdict + rationale (status demoted to secondary).
   * When goalWalkState carries a `steps` array it renders a full decision tree
   * — per step: selected template (source badge + α/β/score), alternatives,
   * exclusions, status/rationale, shadow/recovery styling, and the shape-pool
   * delta between steps. When `steps` is absent it degrades to the existing
   * pool chips + poolEvents timeline + walkLog "why" trail. Also renders the
   * terminal `learning` consequence line and any authored `answerBody`.
   *
   * Idempotent — the fleet board re-renders every 7s, so a persisted expansion
   * re-fetches fresh walkState and a running walk's tree updates in place.
   */
  private async renderFleetDetail(row: HTMLElement, d: Record<string, unknown>): Promise<void> {
    row.querySelector('.sub-fleet-detail')?.remove();
    const detail = row.createDiv('sub-fleet-detail');
    const j = await this.goalHostResolve({ type: 'goalWalkState', dispatchId: String(d.dispatchId ?? '') });
    const body = ((j?.body ?? {}) as Record<string, unknown>);

    // 1. Reached-led headline (status demoted; failed-but-reached explained).
    this.renderReachHeadline(detail, body, d);

    // 2. Authored answer (question-goals): show it prominently up top.
    const answerBody = typeof body.answerBody === 'string' ? body.answerBody.trim() : '';
    if (answerBody) this.renderInlineAnswer(detail, answerBody);

    // 3. Decision tree when steps are present; otherwise degrade gracefully.
    const steps = Array.isArray(body.steps) ? (body.steps as WalkStep[]) : [];
    if (steps.length > 0) {
      this.renderDecisionTree(detail, steps);
    } else {
      this.renderWalkFallback(detail, body);
    }

    // 4. Learning consequence line (terminal only, when present).
    const learning = (body.learning ?? null) as WalkLearning | null;
    if (learning && typeof learning === 'object') this.renderLearningLine(detail, learning);

    // 5. Attach to live WS feed.
    const execId = typeof d.executionId === 'string' && !d.executionId.startsWith('interrupted:') ? d.executionId : null;
    if (execId) {
      const attachBtn = detail.createEl('button', { cls: 'sub-fleet-btn', text: 'attach' });
      attachBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.activeDispatchId = String(d.dispatchId ?? '');
        this.activeExecutionId = execId;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connectWS();
        this.appendMessage(`⇢ attached to dispatch ${String(d.dispatchId ?? '').slice(0, 8)} (execution ${execId.slice(0, 12)}…)`);
      });
    }
  }

  /**
   * Reached-led headline: verdict pill + one-line rationale. `status` is shown
   * only as a small secondary chip; when status=failed but reached=true a single
   * explanatory line replaces the misleading "failed" lead.
   */
  private renderReachHeadline(parent: HTMLElement, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const status = String(body.status ?? d.status ?? '');
    const running = status === 'running';
    const reached = (body.reached ?? d.reached) as boolean | null | undefined;
    const head = parent.createDiv('sub-reach-head');
    const label = running ? 'running' : reached === true ? 'reached: yes' : reached === false ? 'reached: no' : 'reached: unknown';
    const cls = running ? 'is-running' : reached === true ? 'is-reached' : reached === false ? 'is-not-reached' : '';
    head.createSpan({ cls: `sub-reach-verdict ${cls}`, text: label });
    if (!running && status && !(reached === true && status !== 'failed')) {
      head.createSpan({ cls: 'sub-chip sub-reach-status', text: status });
    }
    const rationale = extractReachRationale(body);
    if (rationale) {
      parent.createDiv({ cls: 'sub-reach-rationale', text: rationale, attr: { title: rationale } });
    }
    // Explain the failed-but-reached case in one plain line.
    if (!running && reached === true && status === 'failed') {
      parent.createDiv({
        cls: 'sub-reach-note',
        text: 'steps exited non-zero but the goal was reached',
      });
    }
  }

  /** Render the authored answer body as a distinct callout-style block. */
  private renderInlineAnswer(parent: HTMLElement, answer: string): void {
    const card = parent.createDiv('sub-card sub-card--answer sub-answer-inline');
    const inner = card.createDiv('sub-answer-body');
    inner.createDiv({ cls: 'sub-answer-header', text: '◇ Answer' });
    inner.createDiv({ cls: 'sub-answer-text', text: answer });
  }

  /**
   * Full decision tree: one node per walk step, with the shape-pool delta
   * rendered between consecutive steps. Each node shows the selected template
   * (source badge + α/β or sampled score), a collapsed list of alternatives
   * considered, exclusions with reasons, and step status + rationale prose.
   * Shadow / recovery steps are visually distinct.
   */
  private renderDecisionTree(parent: HTMLElement, steps: WalkStep[]): void {
    const tree = parent.createDiv('sub-tree');
    tree.createDiv({ cls: 'sub-section-header', text: `Decision tree — ${steps.length} step${steps.length === 1 ? '' : 's'}` });
    let prevPool: string[] | null = null;
    steps.forEach((step, i) => {
      // Pool delta going INTO this step (poolAfter[prev] → poolBefore[this]).
      const before = Array.isArray(step.poolBefore) ? step.poolBefore : (prevPool ?? []);
      this.renderStepNode(tree, step, i);
      const after = Array.isArray(step.poolAfter) ? step.poolAfter : before;
      this.renderPoolDelta(tree, before, after, step.newShapes);
      prevPool = after;
    });
  }

  private renderStepNode(parent: HTMLElement, step: WalkStep, i: number): void {
    const shadow = step.shadow === true || step.selected?.source === 'recovery';
    const node = parent.createDiv(`sub-card sub-step${shadow ? ' sub-step--shadow' : ''}`);

    // Header: step index + selected template chip + source badge + score.
    const header = node.createDiv('sub-step-head');
    const idx = typeof step.index === 'number' ? step.index : i;
    header.createSpan({ cls: 'sub-step-idx', text: `${idx + 1}` });
    const sel = step.selected ?? {};
    const selChip = header.createSpan({ cls: 'sub-chip sub-chip--sel' });
    selChip.setText(sel.templateId ? shortId(sel.templateId) : '(no template)');
    if (sel.templateId) selChip.setAttr('title', sel.templateId);
    const src = sourceLabel(sel.source);
    header.createSpan({ cls: `sub-badge sub-badge--${(sel.source ?? 'step').replace(/[^a-z]/gi, '')}`, text: src });
    const annot = scoreAnnot(sel);
    if (annot) header.createSpan({ cls: 'sub-step-score', text: annot });
    if (shadow) header.createSpan({ cls: 'sub-badge sub-badge--shadow', text: 'shadow' });
    if (step.status) {
      const ok = /complete|success|reached|ok/i.test(step.status);
      header.createSpan({ cls: `sub-chip ${ok ? 'sub-chip--ok' : 'sub-chip--warn'} sub-step-status`, text: step.status });
    }

    // Rationale prose.
    if (step.rationale) {
      node.createDiv({ cls: 'sub-step-rationale', text: step.rationale, attr: { title: step.rationale } });
    }

    // Alternatives considered (collapsed).
    const cands = Array.isArray(step.candidates) ? step.candidates : [];
    const alts = cands.filter((c) => c.templateId && c.templateId !== sel.templateId);
    if (alts.length > 0) {
      this.renderCollapsible(node, `alternatives (${alts.length})`, (host) => {
        for (const c of alts) {
          const line = host.createDiv('sub-alt-line');
          const chip = line.createSpan({ cls: 'sub-chip', text: shortId(c.templateId ?? '?') });
          if (c.templateId) chip.setAttr('title', c.templateId);
          const a = scoreAnnot(c);
          if (a) line.createSpan({ cls: 'sub-step-score', text: a });
          if (c.rejectedBecause) {
            line.createSpan({ cls: 'sub-alt-reason', text: c.rejectedBecause, attr: { title: c.rejectedBecause } });
          }
        }
      });
    }

    // Exclusions with reasons (collapsed).
    const excl = Array.isArray(step.excluded) ? step.excluded.filter((e) => e.templateId) : [];
    if (excl.length > 0) {
      this.renderCollapsible(node, `excluded (${excl.length})`, (host) => {
        for (const e of excl) {
          const line = host.createDiv('sub-alt-line sub-alt-line--excluded');
          const chip = line.createSpan({ cls: 'sub-chip sub-chip--fail', text: shortId(e.templateId ?? '?') });
          if (e.templateId) chip.setAttr('title', e.templateId);
          if (e.reason) line.createSpan({ cls: 'sub-alt-reason', text: e.reason, attr: { title: e.reason } });
        }
      });
    }
  }

  /**
   * Pool delta between two steps: chips for the shapes added (poolAfter minus
   * poolBefore, highlighted as new), plus a collapsed "pool: N shapes"
   * affordance expanding the full pool at that point.
   */
  private renderPoolDelta(parent: HTMLElement, before: string[], after: string[], newShapes?: string[]): void {
    const beforeSet = new Set(before);
    const added = (Array.isArray(newShapes) && newShapes.length > 0)
      ? newShapes
      : after.filter((s) => !beforeSet.has(s));
    if (after.length === 0 && added.length === 0) return;
    const wrap = parent.createDiv('sub-pool-delta');
    if (added.length > 0) {
      const chips = wrap.createDiv('sub-fleet-chips');
      chips.createSpan({ cls: 'sub-pool-arrow', text: '+' });
      for (const s of added) {
        chips.createSpan({ cls: 'sub-chip sub-chip--new', text: s, attr: { title: s } });
      }
    }
    if (after.length > 0) {
      this.renderCollapsible(wrap, `pool: ${after.length} shape${after.length === 1 ? '' : 's'}`, (host) => {
        const chips = host.createDiv('sub-fleet-chips');
        for (const s of after) {
          const isNew = added.includes(s);
          chips.createSpan({ cls: `sub-chip${isNew ? ' sub-chip--new' : ''}`, text: s, attr: { title: s } });
        }
      });
    }
  }

  /**
   * Learning consequence line: "taught: Δα/β on <template>, oracle label
   * written, gap filed: <id>". Gap ids wikilink only when a note exists
   * (materialize-or-omit — never a dead link).
   */
  private renderLearningLine(parent: HTMLElement, learning: WalkLearning): void {
    const parts: string[] = [];
    const delta = learning.alphaBetaDelta;
    if (delta !== undefined && delta !== null) {
      if (typeof delta === 'object') {
        const tid = (delta as Record<string, unknown>).templateId ?? (delta as Record<string, unknown>).template;
        const da = (delta as Record<string, unknown>).alpha ?? (delta as Record<string, unknown>).dAlpha ?? (delta as Record<string, unknown>).deltaAlpha;
        const db = (delta as Record<string, unknown>).beta ?? (delta as Record<string, unknown>).dBeta ?? (delta as Record<string, unknown>).deltaBeta;
        const bits: string[] = [];
        if (typeof da === 'number') bits.push(`Δα ${da >= 0 ? '+' : ''}${da.toFixed(2)}`);
        if (typeof db === 'number') bits.push(`Δβ ${db >= 0 ? '+' : ''}${db.toFixed(2)}`);
        const on = typeof tid === 'string' ? ` on ${shortId(tid)}` : '';
        if (bits.length) parts.push(`${bits.join(' ')}${on}`);
      } else {
        parts.push(`Δα/β ${String(delta)}`);
      }
    }
    if (learning.oracleLabelWritten) parts.push('oracle label written');
    const gaps = Array.isArray(learning.gapsFiled) ? learning.gapsFiled.filter(Boolean).map(String) : [];
    if (parts.length === 0 && gaps.length === 0) return;
    const line = parent.createDiv('sub-learning');
    line.createSpan({ cls: 'sub-learning-label', text: 'taught: ' });
    if (parts.length) line.createSpan({ cls: 'sub-learning-body', text: parts.join(', ') });
    for (const g of gaps) {
      const noteExists = this.gapNoteExists(g);
      const sep = line.createSpan({ text: parts.length || line.querySelector('.sub-learning-gap') ? ', gap filed: ' : 'gap filed: ' });
      void sep;
      const gapEl = line.createSpan({ cls: 'sub-learning-gap' });
      if (noteExists) {
        gapEl.setText(`[[${g}]]`);
        gapEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.plugin.app.workspace.openLinkText(g, '', false);
        });
        gapEl.addClass('sub-wikilink');
      } else {
        gapEl.setText(g);
        gapEl.setAttr('title', g);
      }
    }
  }

  /** True when a vault note plausibly corresponds to a gap id (basename match). */
  private gapNoteExists(gapId: string): boolean {
    try {
      const files = this.plugin.app.vault.getMarkdownFiles();
      return files.some((f) => f.basename === gapId || f.path.includes(gapId));
    } catch {
      return false;
    }
  }

  /** A collapsed-by-default toggle whose body is built lazily on first open. */
  private renderCollapsible(parent: HTMLElement, label: string, build: (host: HTMLElement) => void): void {
    const wrap = parent.createDiv('sub-collapsible');
    const header = wrap.createDiv({ cls: 'sub-section-header is-toggle', text: `▸ ${label}` });
    const host = wrap.createDiv('sub-collapsible-body');
    host.hide();
    let open = false;
    header.addEventListener('click', (ev) => {
      ev.stopPropagation();
      open = !open;
      header.setText(`${open ? '▾' : '▸'} ${label}`);
      if (open) {
        if (!host.hasChildNodes()) build(host);
        host.show();
      } else {
        host.hide();
      }
    });
  }

  /**
   * Legacy walk rendering when goalWalkState has no `steps` array: pool chips +
   * missing-target chips + poolEvents timeline + walkLog "why" trail. Preserves
   * the 0.4.0 behaviour so older goal-host builds still render usefully.
   */
  private renderWalkFallback(detail: HTMLElement, body: Record<string, unknown>): void {
    const pool = (Array.isArray(body.poolShapes) ? body.poolShapes : []) as string[];
    const pending = (Array.isArray(body.pendingTargets) ? body.pendingTargets : []) as string[];
    const step = typeof body.currentStep === 'string' ? body.currentStep : null;
    const walk = (Array.isArray(body.walkLog) ? body.walkLog : []) as string[];
    const chips = detail.createDiv('sub-fleet-chips');
    if (pool.length === 0 && pending.length === 0) {
      chips.createSpan({ cls: 'sub-chip', text: 'pool: empty' });
    }
    for (const shape of pool) {
      chips.createSpan({ cls: 'sub-chip', text: shape, attr: { title: shape } });
    }
    for (const shape of pending) {
      chips.createSpan({ cls: 'sub-chip sub-chip--warn', text: `missing: ${shape}`, attr: { title: shape } });
    }
    const events = (Array.isArray(body.poolEvents) ? body.poolEvents : []) as Array<{ shape: string; source: string; at: number }>;
    if (events.length > 0) {
      const timeline = detail.createDiv('sub-fleet-timeline');
      for (const ev of events.slice(-8)) {
        const src = ev.source.length > 60 ? ev.source.slice(0, 60) + '…' : ev.source;
        timeline.createDiv({ cls: 'sub-feed-line', text: `${ev.shape} — ${src}`, attr: { title: ev.source } });
      }
    }
    if (walk.length > 0) {
      const why = detail.createDiv('sub-why');
      why.createDiv({ cls: 'sub-section-header', text: `Why — ${walk.length} walk decisions` });
      const trail = why.createDiv('sub-why-trail');
      for (const line of walk) {
        const clean = line.replace('[goal-host-vessel] ', '');
        trail.createDiv({ cls: 'sub-feed-line sub-why-line', text: clean, attr: { title: clean } });
      }
      trail.scrollTop = trail.scrollHeight;
    } else if (step) {
      const stepText = step.replace('[goal-host-vessel] ', '');
      detail.createDiv({ cls: 'sub-why-line', text: stepText, attr: { title: stepText } });
    }
  }

  /** "Add context" affordance: active note / selection / freeform → WS2 poolImpulse_write. */
  private async injectContext(dispatchId: string): Promise<void> {
    if (!dispatchId) return;
    const app = this.plugin.app;
    const activeFile = app.workspace.getActiveFile();
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    const selection = view?.editor?.getSelection() ?? '';
    let shape = 'human_note';
    let content: string | null = null;
    let summary = 'human-contributed context';
    if (selection) {
      shape = 'selection';
      content = selection;
      summary = `selection from ${activeFile?.path ?? 'editor'}`;
    } else if (activeFile) {
      shape = 'note';
      content = await app.vault.cachedRead(activeFile);
      summary = `active note ${activeFile.path}`;
    } else {
      content = window.prompt('Context to inject into this dispatch:') ?? null;
      if (!content) return;
    }
    const j = await this.goalHostResolve({ type: 'poolImpulse_write', dispatchId, shape, content, summary });
    if (j && j.resolved === true) {
      new Notice(`Injected ${shape} into dispatch ${dispatchId.slice(0, 8)}`);
      this.appendMessage(`⇡ injected ${shape} (${summary}) into ${dispatchId.slice(0, 8)}`, 'impulse');
    } else {
      new Notice('Injection failed (dispatch may have finished).');
    }
  }

  private startSolicitationCards(): void {
    const mgr = this.plugin.solicitationManager;
    if (!mgr || !this.solicitationsEl) return;
    this.renderSolicitations(mgr.list());
    this.unsubscribeSolicitations = mgr.subscribe((list) => this.renderSolicitations(list));
  }

  private renderSolicitations(list: PendingSolicitation[]): void {
    const el = this.solicitationsEl;
    if (!el) return;
    el.empty();
    if (list.length === 0) return;
    for (const sol of list) {
      const card = el.createDiv('sub-card sub-card--solicitation');
      card.createDiv({ cls: 'sub-solicitation-title', text: '⚑ The substrate needs your input' });
      const bodyEl = card.createDiv('sub-solicitation-body');
      void MarkdownRenderer.render(this.plugin.app, sol.questionMarkdown, bodyEl, '/', this);
      const answerEl = card.createEl('textarea', {
        cls: 'sub-solicitation-answer',
        attr: { placeholder: 'Your answer… (typing keeps the door open)', rows: '3' },
      });
      answerEl.addEventListener('input', () => this.plugin.solicitationManager?.heartbeat(sol.solicitationId));
      const btnRow = card.createDiv('sub-solicitation-btns');
      const answerBtn = btnRow.createEl('button', { cls: 'mod-cta', text: 'Answer' });
      answerBtn.addEventListener('click', () => {
        const answer = answerEl.value.trim();
        if (!answer) {
          new Notice('Write an answer first (or use Not now).');
          return;
        }
        void this.plugin.solicitationManager?.respond(sol.solicitationId, 'answered', answer);
      });
      const declineBtn = btnRow.createEl('button', { text: 'Not now' });
      declineBtn.addEventListener('click', () => void this.plugin.solicitationManager?.respond(sol.solicitationId, 'declined'));
      const insufficientBtn = btnRow.createEl('button', { text: 'Not enough context' });
      insufficientBtn.addEventListener('click', () =>
        void this.plugin.solicitationManager?.respond(sol.solicitationId, 'insufficient_context'));
    }
  }

  /** Vault-touch feed: last in the scroll container, collapsed by default. */
  private startTouchFeed(): void {
    const ledger = this.plugin.vaultTouchLedger;
    if (!ledger || !this.touchesEl) return;
    const render = (): void => {
      const el = this.touchesEl;
      if (!el) return;
      el.empty();
      const header = el.createDiv({
        cls: 'sub-section-header is-toggle',
        text: `${this.touchesExpanded ? '▾' : '▸'} Substrate activity (${ledger.size()} touches)`,
      });
      header.addEventListener('click', () => {
        this.touchesExpanded = !this.touchesExpanded;
        render();
      });
      if (!this.touchesExpanded) return;
      const rows = ledger.read({ limit: 8 });
      const now = Date.now();
      for (const t of [...rows].reverse()) {
        const ageMs = now - new Date(t.timestamp).getTime();
        const paths = t.paths.length ? ` ${t.paths.join(', ')}` : '';
        const line = el.createDiv({
          cls: `sub-feed-line${t.mode === 'write' ? ' sub-t-touch-write' : ''}`,
        });
        line.createSpan({ cls: 'sub-feed-ts', text: `${fmtRel(ageMs)}` });
        line.createSpan({
          cls: 'sub-feed-msg',
          text: `${t.mode === 'write' ? '✎' : '◉'} ${t.shape.replace('obsidian:', '')}${paths}`,
          attr: { title: `${t.shape}${paths}` },
        });
      }
    };
    render();
    this.unsubscribeTouches = ledger.subscribe(() => render());
  }

  private async renderReachVerdict(): Promise<void> {
    const dispatchId = this.activeDispatchId;
    if (!dispatchId) return;
    try {
      const client = new GoalHostClient(this.plugin.settings.goalHostEndpoint, this.plugin.settings.apiKey);
      const record = await client.getDispatchRecord(dispatchId);
      const reached = record.reached as boolean | null;
      const reason = record.goalReachReason as string | null;
      // Persist the reach verdict into the per-goal vault note
      if (this.goalFile && (reached !== undefined || reason)) {
        try {
          const outcomeLabel = reached === true ? '✅ Reached' : reached === false ? '❌ Not reached' : '⏳ Unknown';
          const outcomeLine = `\n## Outcome\n- **Verdict**: ${outcomeLabel}\n- **Reason**: ${reason ?? ''}\n- **Recorded**: ${new Date().toISOString()}`;
          const noteFile = this.plugin.app.vault.getAbstractFileByPath(this.goalFile.path);
          if (noteFile instanceof TFile) {
            const existing = await this.plugin.app.vault.read(noteFile);
            if (!existing.includes('## Outcome')) {
              await this.plugin.app.vault.modify(noteFile, existing + outcomeLine);
            }
          }
        } catch (e) {
          console.warn('[GoalDispatch] Could not append outcome to goal note:', e);
        }
      }
      if (reached === true) {
        this.appendMessage('reached: yes', 'success');
      } else if (reached === false) {
        this.appendMessage('reached: no - ' + (reason ?? 'no reason given'), 'failure');
        if (this.scrollEl) this.scrollEl.addClass('sub-hollow');
      } else {
        this.appendMessage('reached: unknown (verdict pending)', undefined);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.appendMessage('reached: unavailable (' + msg + ')', undefined);
    }
  }

  private clearOutput(): void {
    if (this.scrollEl) this.scrollEl.removeClass('sub-hollow');
    if (this.outputEl) this.outputEl.empty();
  }

  private setDispatchBtnState(disabled: boolean): void {
    if (this.dispatchBtn) {
      this.dispatchBtn.disabled = disabled;
      this.dispatchBtn.textContent = disabled ? 'Dispatching…' : 'Dispatch';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------

  private connectWS(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = (() => {
      let ep = this.plugin.settings.websocketUrl || this.plugin.settings.activityApiUrl;
      ep = ep.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      ep = ep.replace(/\/$/, '');
      if (!ep.endsWith('/ws')) ep = ep + '/ws';
      return ep;
    })();
    const apiKey = this.plugin.settings.apiKey;

    try {
      this.ws = new window.WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[GoalDispatchView] WS connected');
        // Authenticate
        this.ws!.send(JSON.stringify({ type: 'authenticate', token: apiKey }));
      };

      this.ws.onmessage = (ev) => {
        this.handleWSMessage(ev.data as string);
      };

      this.ws.onerror = (ev) => {
        console.warn('[GoalDispatchView] WS error', ev);
      };

      this.ws.onclose = () => {
        console.log('[GoalDispatchView] WS closed, scheduling reconnect');
        this.ws = null;
        // Reconnect after 3s if the view is still open
        if (this.dispatching) {
          this.wsReconnectTimer = window.setTimeout(() => {
            this.wsReconnectTimer = null;
            this.connectWS();
          }, 3000);
        }
      };
    } catch (error) {
      console.error('[GoalDispatchView] Failed to create WS:', error);
    }
  }

  private disconnectWS(): void {
    if (this.wsReconnectTimer !== null) {
      window.clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect loop
      this.ws.close();
      this.ws = null;
    }
  }

  private getExecCtx(execId: string): ExecCtx {
    if (!this.execCtxs.has(execId)) {
      this.execCtxs.set(execId, { tasks: new Map() });
    }
    return this.execCtxs.get(execId)!;
  }

  /**
   * Render the goal's authored answer as a distinct multi-line block in the
   * panel so the user reads the response directly without opening the vault
   * note or querying concept-db. Called once per dispatch when a goalAnswer
   * concept fires for the root execution.
   */
  private appendAnswerBlock(answer: string, conceptId: string | undefined): void {
    if (!this.outputEl) return;
    const wrap = this.outputEl.createDiv('sub-feed-line sub-card sub-card--answer');
    wrap.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
    const inner = wrap.createDiv({ cls: 'sub-feed-msg sub-answer-body' });
    inner.createDiv({ cls: 'sub-answer-header', text: '◇ Answer' });
    inner.createDiv({ cls: 'sub-answer-text', text: answer });
    if (conceptId) {
      inner.createDiv({
        cls: 'sub-answer-attribution',
        text: `↳ stored as ${shortId(conceptId)}`,
        attr: { title: conceptId },
      });
    }
    this.scrollToBottom();
  }

  /**
   * Increment the suppressed-event counter and update (or create) a single
   * collapsed summary line in the output so the user can see the count
   * without the events themselves flooding the panel.
   */
  private bumpSuppressed(): void {
    this.suppressedCount++;
    if (!this.outputEl) return;
    const text = `· ${this.suppressedCount} infrastructure event${this.suppressedCount === 1 ? '' : 's'} suppressed (binding / validators / scope)`;
    if (this.suppressedSummaryLine) {
      const msgSpan = this.suppressedSummaryLine.querySelector('.sub-feed-msg');
      if (msgSpan) msgSpan.textContent = text;
      return;
    }
    const line = this.outputEl.createDiv('sub-feed-line sub-t-suppressed');
    line.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
    line.createSpan({ cls: 'sub-feed-msg', text });
    this.suppressedSummaryLine = line;
    this.scrollToBottom();
  }

  private handleWSMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!this.dispatching && !this.activeExecutionId) return;

    // While buffering (waiting for poll to return executionId), stash events
    // keyed by execId so we can replay just the right one afterward.
    if (this.buffering) {
      const d = (msg.data ?? msg) as Record<string, unknown>;
      const eid = (d.execution_id ?? d.executionId) as string | undefined;
      if (eid) {
        if (!this.eventBuffer.has(eid)) this.eventBuffer.set(eid, []);
        this.eventBuffer.get(eid)!.push(msg);
      }
      return;
    }

    this.processWSEvent(msg);
  }

  private processWSEvent(msg: Record<string, unknown>): void {
    const type = msg.type as string | undefined;
    if (!type) return;

    // Events nest their payload under `data`; older broadcasts hoist to top.
    const data = (msg.data ?? msg) as Record<string, unknown>;
    const execId = (data.execution_id ?? data.executionId) as string | undefined;
    const taskId = (data.task_id ?? data.taskId) as string | undefined;

    // Strict filter: root execution + registered sub-executions.
    const isRoot = !execId || execId === this.activeExecutionId;
    if (!isRoot && !this.execCtxs.has(execId ?? '')) return;

    // Suppress infrastructure sub-activities (slot-binding, validator-dispatch,
    // shape-provider-goal escalation, etc.). Their templateName is checked on
    // activity.started; if hidden, the execId is recorded and all subsequent
    // events on that execId are dropped + counted. The root execution and
    // concept events are never suppressed.
    if (!isRoot && execId && this.hiddenExecIds.has(execId)) {
      this.bumpSuppressed();
      return;
    }
    if (
      !isRoot &&
      execId &&
      (type === 'activity.started' || type === 'execution_started' || type === 'execution.started')
    ) {
      const variantName = (data.template_name ?? data.templateName ?? data.templateId ?? data.variant_id) as string | undefined;
      if (isHiddenTemplate(variantName)) {
        this.hiddenExecIds.add(execId);
        this.bumpSuppressed();
        return;
      }
    }

    const pad = isRoot ? '' : '  ';
    const cpd = isRoot ? '  ' : '    ';

    switch (type) {

      // ── execution lifecycle ───────────────────────────────────────────────
      case 'activity.started':
      case 'execution_started':
      case 'execution.started': {
        const variantId = (data.template_name ?? data.templateName ?? data.variant_id ?? data.variantId ?? data.templateId) as string | undefined;
        if (execId) {
          const ctx = this.getExecCtx(execId); // registers it, passes future filter
          ctx.variantId = variantId;
        }
        if (isRoot && variantId) {
          // Show the activity name for the root execution
          this.appendMessage(`◈ Activity: ${variantId}`);
        } else if (!isRoot && variantId) {
          this.appendMessage(`${pad}↳ Sub-activity: ${variantId}`, 'sub');
        }
        break;
      }

      // ── task lifecycle ────────────────────────────────────────────────────
      case 'task.started': {
        const idx = (data.task_index ?? data.taskIndex) as number | undefined;
        const desc = (data.description ?? data.task_description) as string | undefined;
        if (execId && taskId) {
          const ctx = this.getExecCtx(execId);
          ctx.tasks.set(taskId, { index: idx ?? 0, description: desc ?? taskId, startedAt: Date.now() });
        }
        const n = idx !== undefined ? `${idx + 1}` : '?';
        this.appendMessage(`${pad}▶ Task ${n}: ${desc ?? taskId}`, 'task');
        break;
      }

      case 'task.completed': {
        const success = (data.success ?? data.succeeded) as boolean | undefined;
        const durationMs = (data.duration_ms ?? data.durationMs) as number | undefined;
        const error = (data.error ?? data.error_message) as string | undefined;
        const outputIds = (data.output_impulse_ids ?? data.outputImpulseIds) as string[] | undefined;
        const inputIds = (data.input_impulse_ids ?? data.inputImpulseIds) as string[] | undefined;
        const idx = ((data.task_index ?? data.taskIndex) as number | undefined)
          ?? (execId && taskId ? this.execCtxs.get(execId)?.tasks.get(taskId)?.index : undefined);
        const n = idx !== undefined ? `${idx + 1}` : '?';
        const durStr = durationMs ? `  ${fmtDuration(durationMs)}` : '';
        const outStr = outputIds?.length ? `  → ${outputIds.length} output${outputIds.length > 1 ? 's' : ''}` : '';
        const inStr = inputIds?.length ? `  ← ${inputIds.length} in` : '';

        if (success === false) {
          const errStr = error ? `  ${error.slice(0, 100)}` : '';
          this.appendMessage(`${pad}✗ Task ${n} failed${errStr}`, 'failure');
        } else {
          this.appendMessage(`${pad}✓ Task ${n} done${durStr}${inStr}${outStr}`, 'task');
        }
        break;
      }

      // ── resolver events ───────────────────────────────────────────────────
      case 'tool.call': {
        const toolName = (data.tool_name ?? data.tool) as string | undefined;
        const tier = (data.resolver_tier ?? data.resolverTier) as string | undefined;
        const latMs = (data.latency_ms ?? data.latencyMs) as number | undefined;
        const cost = (data.cost_usd ?? data.costUsd) as number | undefined;
        const tl = tierLabel(tier);
        const parts: string[] = [`⚙ ${toolName ?? '?'}`];
        if (tl) parts.push(`[${tl}]`);
        if (latMs) parts.push(fmtDuration(latMs));
        if (cost && cost > 0) parts.push(`$${cost.toFixed(4)}`);
        this.appendMessage(`${cpd}${parts.join('  ')}`, 'tool');
        break;
      }

      case 'impulse.resolved': {
        const shape = (data.shape ?? data.impulse_id ?? data.impulseId) as string | undefined;
        const resolverId = (data.resolver_id ?? data.resolverId) as string | undefined;
        const vessel = (data.vessel_id ?? data.vesselId) as string | undefined;
        const body = data.body;
        const latMs = (data.latency_ms ?? data.latencyMs) as number | undefined;

        const parts: string[] = [`◎ ${shape ?? '?'}`];
        if (resolverId) parts.push(`via ${shortId(resolverId)}`);
        if (vessel && vessel !== resolverId) parts.push(`@ ${shortId(vessel)}`);
        if (latMs) parts.push(fmtDuration(latMs));

        // Body preview: show what context was actually loaded
        if (body !== undefined && body !== null) {
          const b = body as Record<string, unknown> | string;
          if (typeof b === 'object' && b.truncated) {
            parts.push(`↯ ${preview(b.summary, 50)}`);
          } else {
            const p = preview(body, 60);
            if (p) parts.push(`"${p}"`);
          }
        }
        this.appendMessage(`${cpd}${parts.join('  ')}`, 'impulse');
        break;
      }

      // ── concept lifecycle ─────────────────────────────────────────────────
      case 'concept.created':
      case 'concept_created': {
        // concept-db's bus payload wraps the concept as `data.concept = {...}`.
        // Older / unprefixed payloads hoisted fields to data.* directly. Read both.
        const conceptObj = (data.concept ?? data) as Record<string, unknown>;
        const conceptId = (conceptObj.id ?? data.concept_id ?? data.conceptId) as string | undefined;
        const content = conceptObj.content as string | undefined;
        const summary = (conceptObj.summary ?? data.summary ?? data.title) as string | undefined;
        const shape = (conceptObj.shape ?? data.shape ?? conceptObj.source_type ?? data.source_type) as string | undefined;

        if (conceptId && isRoot) {
          this.mintedConcepts.push({ id: conceptId, summary });
        }

        const parts: string[] = ['◆'];
        if (shape) parts.push(shape);
        parts.push(`Concept: ${conceptId ? shortId(conceptId) : '?'}`);
        const previewText = summary ?? content;
        if (previewText) {
          const p = preview(previewText, 60);
          if (p) parts.push(`"${p}"`);
        }
        this.appendMessage(`${pad}${parts.join('  ')}`, 'concept');

        // When the concept is the goal's authored answer (shape goalAnswer or
        // origin=summarize-and-emit-concept), render the full answer as a
        // distinct block so the user reads the response directly in the panel.
        // Without this they'd see only a 60-char preview and have to open the
        // vault note or query concept-db to read the actual answer.
        const meta = (conceptObj.pointer as Record<string, unknown> | undefined)?.metadata as Record<string, unknown> | undefined;
        const origin = meta?.origin as string | undefined;
        const isGoalAnswer = shape === 'goalAnswer' || origin === 'summarize-and-emit-concept';
        if (isRoot && isGoalAnswer && content) {
          this.appendAnswerBlock(content, conceptId);
        }
        break;
      }

      case 'concept.linked':
      case 'concept_linked': {
        const from = (data.from_concept_id ?? data.fromConceptId ?? data.from) as string | undefined;
        const to = (data.to_concept_id ?? data.toConceptId ?? data.to) as string | undefined;
        const edgeType = (data.edge_type ?? data.edgeType ?? data.relation) as string | undefined;
        const parts: string[] = [
          `↔ Linked ${from ? shortId(from) : '?'} ↔ ${to ? shortId(to) : '?'}`,
        ];
        if (edgeType) parts.push(`(${edgeType})`);
        this.appendMessage(`${pad}${parts.join('  ')}`, 'concept-link');
        break;
      }

      case 'concept.usage':
        // Silently skip — too noisy for the dispatch view.
        break;

      // ── execution completion ──────────────────────────────────────────────
      case 'activity.completed':
      case 'execution.completed':
      case 'execution_completed': {
        const success = (data.success ?? data.succeeded) as boolean | undefined;
        const durationMs = (data.duration_ms ?? data.durationMs) as number | undefined;
        const cost = (data.cost ?? data.cost_usd) as number | undefined;
        const durStr = durationMs ? `  ${fmtDuration(durationMs)}` : '';
        const costStr = cost && cost > 0 ? `  $${cost.toFixed(4)}` : '';

        if (isRoot) {
          const ok = success !== false;
          this.appendMessage(
            `${ok ? '✓' : '✗'} Execution ${ok ? 'complete' : 'failed'}${durStr}${costStr}`,
            ok ? 'success' : 'failure',
          );
          if (this.goalFile) {
            this.goalNoteManager.markComplete(
              this.goalFile,
              ok ? 'completed' : 'failed',
              this.mintedConcepts,
            );
          }
          this.dispatching = false;
          this.setDispatchBtnState(false);
          void this.renderReachVerdict();
        } else {
          const ok = success !== false;
          this.appendMessage(`${pad}${ok ? '✓' : '✗'} Sub-activity done${durStr}`, ok ? 'sub' : 'failure');
        }
        break;
      }

      case 'activity.failed':
      case 'execution.failed': {
        if (isRoot) {
          const err = (data.error ?? data.error_message) as string | undefined;
          this.appendMessage(`✗ Execution failed${err ? `  ${err.slice(0, 80)}` : ''}`, 'failure');
          if (this.goalFile) this.goalNoteManager.markComplete(this.goalFile, 'failed', this.mintedConcepts);
          this.dispatching = false;
          this.setDispatchBtnState(false);
          void this.renderReachVerdict();
        } else {
          this.appendMessage(`${pad}✗ Sub-activity failed`, 'failure');
        }
        break;
      }

      default: {
        // Unknown event — show type so nothing is silently swallowed
        if (isRoot) this.appendMessage(`• ${type}`, undefined);
        break;
      }
    }

    if (this.goalFile) {
      this.goalNoteManager.appendEvent(
        this.goalFile,
        `- ${new Date().toISOString()} ${type} exec=${execId ?? ''} task=${taskId ?? ''}`,
      );
    }
  }
}
