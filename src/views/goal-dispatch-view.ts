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

import { ItemView, WorkspaceLeaf, TFile, Notice, Menu, MarkdownView, MarkdownRenderer, Modal, App } from 'obsidian';

class TextPromptModal extends Modal {
	private resolve: (v: string | null) => void;
	private submitted = false;
	constructor(app: App, private promptTitle: string, resolve: (v: string | null) => void) {
		super(app);
		this.resolve = resolve;
	}
	onOpen(): void {
		this.titleEl.setText(this.promptTitle);
		const input = this.contentEl.createEl('textarea', { cls: 'sub-prompt-input' });
		input.rows = 3;
		input.style.width = '100%';
		input.focus();
		input.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
				this.submitted = true;
				this.resolve(input.value);
				this.close();
			}
		});
		const submit = this.contentEl.createEl('button', { text: 'Submit' });
		submit.addEventListener('click', () => {
			this.submitted = true;
			this.resolve(input.value);
			this.close();
		});
	}
	onClose(): void {
		if (!this.submitted) this.resolve(null);
		this.contentEl.empty();
	}
}

function promptText(app: App, title: string): Promise<string | null> {
	return new Promise((resolve) => new TextPromptModal(app, title, resolve).open());
}
import type ObsidianVesselPlugin from '../main';
import { GoalHostClient, type VaultContext } from '../goals/goal-host-client';
import { GoalNoteManager } from '../goals/goal-note-manager';
import type { PendingSolicitation } from '../solicitations/solicitation-manager';
import type { UiFeedbackKind } from '../feedback/ui-feedback-store';
import { sidecarResolveBody, sidecarHttpAuto } from '../sidecar-manager';
import { posteriorSentence, shadowSentence, poolDeltaSentence, reachCaption, vesselsCaption, peersCaption, gapsCaption, runnersCaption, asOfNote, runningNarrative, whyChosenSentence, failureMeaningSentence, dispositionSentence, verdictDerivation, learningOutcomeSentence, dispatchLabel, dedupeMembers, distinctVessels, resolutionPath, resolvedBySentence, resolvedByLabel, featureComposeOutcome, type ResolutionPath } from './panel-narrative';
import { cachedPulseVerdict, refreshPulseVerdict, cachedNextSelection, requestNextSelection } from './panel-aggregates';
import { selectPresentationArm, peekPresentationArm } from '../presentation/presentation-policy';
import { attentionGrader } from '../presentation/attention-grader';
import { renderArmBody } from '../presentation/presentation-arms';

export const VIEW_TYPE_GOAL_DISPATCH = 'obsidian-goal-dispatch';

// ---------------------------------------------------------------------------
// Execution context tracking
// ---------------------------------------------------------------------------


/** Shorten a variant/resolver/vessel id to a readable slug (last 2 segments). */
function shortId(id: string): string {
  // Strip the activity:⟨…⟩ wrapper minted around template ids — the
  // trailing ⟩ (U+27E9) survives the tail slice and renders like a stray ")".
  const clean = id.replace(/^activity:/, '').replace(/[⟨⟩<>]/g, '');
  const parts = clean.split(/[-_:]/);
  return parts.slice(-2).join('-');
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
  alphaBetaDelta?: Record<string, unknown> | Array<Record<string, unknown>> | number | string;
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

function humanizeWalkLine(line: string): string {
  const brace = line.indexOf('{');
  if (brace === -1) return line;
  try {
    const obj = JSON.parse(line.slice(brace));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return line;
    const bits: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        if (v.length > 0 && v.length <= 4 && v.every((x) => typeof x === 'string')) bits.push(k + ': ' + v.join(', '));
        continue;
      }
      if (typeof v === 'object') continue;
      const s = String(v);
      bits.push(k + ': ' + (s.length > 48 ? s.slice(0, 48) + '…' : s));
    }
    return line.slice(0, brace).trim() + (bits.length ? ' — ' + bits.join(' · ') : '');
  } catch {
    return line;
  }
}

/**
 * Earned reach rate α/(α+β) plus the observation mass (α+β). The mass is the
 * honest caveat thickness alone can't show — it separates an earned 0.9 from an
 * uninformed α=1,β=1 prior of 0.5. Returns null when the posterior is absent.
 */
function reachOf(s: { alpha?: number; beta?: number }): { rate: number; mass: number } | null {
  const a = s.alpha, b = s.beta;
  if (typeof a !== 'number' || typeof b !== 'number' || a + b <= 0) return null;
  return { rate: a / (a + b), mass: a + b };
}

/** Reusability class — HEURISTIC from source + template-id prefix (true walk_tier
 *  is not emitted per step, so this is honestly a heuristic, never a tier badge). */
function reuseClass(s: { source?: string; templateId?: string }): string {
  if (s.source === 'satisfier') return 'tool primitive';
  const t = (s.templateId ?? '').toLowerCase();
  if (/learned[-_]?compos|composed|composition/.test(t)) return 'learned pathway';
  if (/auto-bridge/.test(t)) return 'fresh scaffold';
  if (s.source === 'thompson') return 'one-off';
  return s.source ?? 'step';
}

/** Dispatch-level target-inference confidence, parsed verbatim from walkLog. */
function walkConfidence(walkLog: string[]): { conf: number; targets: string[]; alts: string[] } | null {
  for (const l of walkLog) {
    if (!/goal-target inference/.test(l)) continue;
    const m = l.match(/(\{.*\})/);
    if (!m) continue;
    try {
      const o = JSON.parse(m[1]) as Record<string, unknown>;
      if (typeof o.confidence === 'number') {
        const alts = Array.isArray(o.alternatives)
          ? (o.alternatives as unknown[]).map((a) => (Array.isArray(a) ? a.join('/') : String(a)))
          : [];
        const targets = Array.isArray(o.inferred_target_shapes) ? (o.inferred_target_shapes as string[]) : [];
        return { conf: o.confidence, targets, alts };
      }
    } catch { /* ignore malformed */ }
  }
  return null;
}

/** Shapes a vessel-resolve satisfier produced directly (tool-grounded), from walkLog. */
function groundedShapeSet(walkLog: string[]): Set<string> {
  const s = new Set<string>();
  for (const l of walkLog) {
    const m = l.match(/VESSEL-RESOLVE SATISFIER produced "([^"]+)" directly/);
    if (m && m[1]) s.add(m[1]);
  }
  return s;
}

/**
 * Per-step grounding verdict for the trust read: 'grounded' = produced a shape a
 * tool/vessel actually resolved; 'hollow' = produced nothing or the step failed;
 * 'unconfirmed' = produced a shape but we can't prove it came from a tool (may be
 * LLM — the explicit grounded-vs-interpolated flag is not yet emitted).
 */
function stepGrounding(step: WalkStep, grounded: Set<string>): 'grounded' | 'hollow' | 'unconfirmed' {
  const outs = Array.isArray(step.newShapes) ? step.newShapes : [];
  const failed = step.status ? !/complete|success|reached|ok/i.test(step.status) : false;
  if (outs.length === 0 || failed) return 'hollow';
  if (outs.some((sh) => grounded.has(sh)) || step.selected?.source === 'satisfier') return 'grounded';
  return 'unconfirmed';
}

/**
 * Whole-walk grounding verdict for the authored answer's trust badge.
 * 'grounded' = the reach produced a tool/vessel-resolved (satisfier) shape, so the
 * answer has a tool anchor; 'unverified' = every producing step was a pure LLM
 * completion with no tool-grounded shape, so the answer may be a confabulation.
 */
function answerGrounding(body: Record<string, unknown>): 'grounded' | 'unverified' {
  // A bare LLM completion is NOT tool-grounded — it is exactly the confabulation the
  // badge must warn about. Grounding requires a NON-LLM tool/data/compute shape; a
  // pure llm_completion_dispatch satisfier reach must read 'unverified'. (Empirically
  // caught: the old any-satisfier check falsely badged bare LLM answers 'grounded'.)
  const isLLM = (sh: string): boolean => /llm_completion|llm_response|llmtext|llmcompletion/i.test(sh);
  const walkLog = Array.isArray(body.walkLog) ? (body.walkLog as unknown[]).map(String) : [];
  const grounded = groundedShapeSet(walkLog);
  if (Array.from(grounded).some((sh) => !isLLM(sh))) return 'grounded';
  const steps = Array.isArray(body.steps) ? (body.steps as WalkStep[]) : [];
  if (steps.some((s) => stepGrounding(s, grounded) === 'grounded'
      && (Array.isArray(s.newShapes) ? s.newShapes.map(String) : []).some((sh) => !isLLM(sh)))) return 'grounded';
  return 'unverified';
}

/** Compact α/β or sampled-score annotation for a template chip. */
function scoreAnnot(s: { alpha?: number; beta?: number; sampledScore?: number }): string {
  if (typeof s.sampledScore === 'number') return `sampled ${s.sampledScore.toFixed(2)}`;
  if (typeof s.alpha === 'number' || typeof s.beta === 'number') {
    return `α${(s.alpha ?? 0).toFixed(1)}/β${(s.beta ?? 0).toFixed(1)}`;
  }
  return '';
}

/**
 * The one-line reach rationale for the .sub-reach-rationale line. goal-host now
 * emits goalReachReason as AUTHORITATIVE prose, so prefer it outright — the walk
 * tail (currentStep / last walkLog line) is frequently a mechanism/telemetry line
 * (a `BRIDGE materialized … → sinks`, a `REACH-CONTENT <shape> = {json}` dump, or a
 * bare `step N ran activity:… status=failed` line), none of which is a reason.
 * Only when goalReachReason is absent (an older goal-host) do we scrape, and even
 * then we surface ONLY a genuine em-dash rationale clause — never a telemetry line.
 */
function extractReachRationale(body: Record<string, unknown>): string {
  const reason = typeof body.goalReachReason === 'string' ? body.goalReachReason.trim() : '';
  if (reason) return reason;
  // Fallback path: old goal-host without goalReachReason. Scrape a real reason
  // clause off the walk tail if one is present; otherwise surface nothing rather
  // than dumping BRIDGE / REACH-CONTENT / JSON / step-status telemetry.
  const cur = typeof body.currentStep === 'string' ? body.currentStep : '';
  const walk = Array.isArray(body.walkLog) ? (body.walkLog as unknown[]).map(String) : [];
  const src = cur || (walk.length ? walk[walk.length - 1] : '');
  if (!src) return '';
  const m = src.match(/—\s*(.+?)\.?\s*(?:completion_shapes=|$)/);
  if (m && m[1]) return m[1].trim().replace(/\.\.$/, '.');
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
export class GoalDispatchView extends ItemView {
  private plugin: ObsidianVesselPlugin;

  // DOM elements
  private omniboxWrapEl: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private dispatchBtn: HTMLButtonElement | null = null;
  private scrollEl: HTMLElement | null = null;   // THE one scroll container
  private outputEl: HTMLElement | null = null;   // feed-lines region inside scrollEl

  // State
  private pollInterval: number | null = null;
  private lastRenderedSnapshot: Map<string, string> = new Map();
  // Live per-walk-step progress for the active dispatch: a ~2.5s poll of the
  // goalWalkState shape through the sidecar. Replaces the old activity-api /ws
  // bus, which bypassed the federation sidecar and was dead in production.
  private walkPollTimer: number | null = null;
  private renderedStepCount = 0;
  private answerRendered = false;
  private activeExecutionId: string | null = null;
  private activeDispatchId: string | null = null;
  // True once the active dispatch has been observed in-flight in the
  // activeDispatches list. Lets the fleet-board settle detector distinguish
  // "not registered yet" (never seen -> keep waiting) from "settled and pruned"
  // (seen, now gone -> re-enable the button). Reset at each dispatch start.
  private activeDispatchSeen = false;
  private goalFile: TFile | null = null;
  private goalNoteManager: GoalNoteManager;
  private dispatching = false;
  private elapsedTimer: number | null = null;
  private dispatchStartedAt: number | null = null;

  // Deferred impulse-relevance writes: fired only when the execution actually
  // settles, with the real outcome.
  private pendingRelevance = new Map<string, (succeeded: boolean) => void>();

  // Concepts minted during the active dispatch — appended to the goal note on completion.
  private mintedConcepts: Array<{ id: string; summary?: string }> = [];

  // Fleet board (WS6): in-flight dispatches pinned above the feed; completed
  // dispatches collapse to a one-line count (expandable).
  private fleetEl: HTMLElement | null = null;
  private completedEl: HTMLElement | null = null;
  private completedDispatches: Array<Record<string, unknown>> = [];
  private completedExpanded = false;
  /** Free-text filter over finished runs — see renderCompleted. */
  private completedFilter = '';
  private fleetTimer: number | null = null;
  // All-runner running view: fleet feed members (per-substrate dispatch lists),
  // refreshed at most every ~25s inside the 7s fleet tick.
  private fleetMembers: Array<Record<string, unknown>> = [];
  private fleetMembersAt = 0;
  private substrateSeen = false; // true once ANY resolve has answered — gates the boot-transient fast retry
  // Highest walk-step index whose shape-flow column has already animated in,
  // per dispatch. The fleet detail fully rebuilds each poll; without this the
  // entry animation would replay every tick. New steps (index > stored) animate
  // once; everything already seen renders static. Cheap, GPU-only (WAAPI).
  private animatedFlowSteps = new Map<string, number>();

  // Dispatch rows the user has expanded — persisted across the 7s fleet
  // re-render so a running walk's live "why" trail stays open and refreshes.
  private expandedDispatches = new Set<string>();
  /**
   * The dispatch row the pointer is currently inside. A running row is rebuilt
   * on every poll so its step tree can advance, but that teardown destroys the
   * DOM the human is reading — losing scroll position inside the detail, any
   * text selection, and the hit target under the cursor. While the pointer is
   * in a row we stop rebuilding it and say so, and resume when they leave.
   */
  private hoveredDispatchId: string | null = null;
  // Running dispatches we've auto-expanded once so their live decision tree
  // (selection + shape flow) is visible as the walk proceeds without a click.
  // Membership also records an explicit user-collapse, so we never re-expand
  // a row the human deliberately closed.
  private autoExpandedRunning = new Set<string>();
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
  private inspectEl: HTMLElement | null = null;
  // Group activity feed: what the whole peering group is working on
  // (fleetActivityFeed aggregate, with direct-resolve fallback legs).
  private groupEl: HTMLElement | null = null;
  private groupExpanded = true;
  private pulseEl: HTMLElement | null = null;
  private gapsExpanded = false;
  // per-gap causal-thread expansion (gap id -> expanded)
  private gapDetailExpanded: Set<string> = new Set();
  private projectsExpanded = false;
  private workBoardTimer: number | null = null;

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
    this.startFleetBoard();
    this.startWorkBoard();
    this.startSolicitationCards();
    this.startTouchFeed();
  }

  async onClose(): Promise<void> {
    attentionGrader.flushAll();
    this.stopWalkPoll();
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


    // Identity strip: which surface this panel is, at a glance.
    const panelHead = contentEl.createDiv('sub-panel-head');
    panelHead.createSpan({ cls: 'sub-panel-dot' });
    panelHead.createSpan({ cls: 'sub-panel-title', text: 'Substrate' });
    panelHead.createSpan({ cls: 'sub-panel-sub', text: `this vessel · ${this.app.vault.getName()}` });

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
    // ⌘↵ hints the Dispatch shortcut — keep it beside Dispatch, not after
    // Clear (where it read as Clear's shortcut).
    actions.createSpan({ cls: 'sub-omnibox-hint', text: '⌘↵' });
    const clearBtn = actions.createEl('button', {
      text: 'Clear',
      cls: 'sub-omnibox-clear',
    });
    clearBtn.addEventListener('click', () => this.clearOutput());

    // ── Priority stack (pinned above the scroll container) ──
    // 1. Solicitation cards (WS5) — the substrate asking the human.
    this.pulseEl = contentEl.createDiv('sub-section sub-pulse');
        this.solicitationsEl = contentEl.createDiv('sub-section sub-solicitations');
    // 2. Fleet rows (WS6) — in-flight dispatches, collapsed one-liners.
    this.fleetEl = contentEl.createDiv('sub-section sub-fleet');
    // 3. Completed goals — one-line count, expandable.
    this.completedEl = contentEl.createDiv('sub-section sub-completed');
    // 4. Group — what the whole peering group is working on (dispatches
    //    tagged by substrate, gap filings, boredom work, rhythms).
    this.groupEl = contentEl.createDiv('sub-section sub-group');
    // 5. Gaps — the substrate's self-improvement backlog (what it's working
    //    on fixing in itself), collapsed to a count.
    this.gapsEl = contentEl.createDiv('sub-section sub-gaps');
    // 6. Projects — longer-lived work threads, collapsed to a count.
    this.projectsEl = contentEl.createDiv('sub-section sub-projects');
    // 7. Inspect — execution trace inspection and registry browsing.
    this.inspectEl = contentEl.createDiv('sub-section sub-inspect');
    this.renderInspect(this.inspectEl);

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
            const prose = (await promptText(this.plugin.app, `${label} — optional detail (close to skip):`)) ?? undefined;
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
  private async renderInspect(el: HTMLElement): Promise<void> {
    await this.renderCollapsible(el, 'Inspect', async (body) => {
      const input = body.createEl('input', {
        type: 'text',
        placeholder: 'execution id',
        cls: 'inspect-execution-input',
      });

      const openTraceBtn = body.createEl('button', {
        text: 'Open trace',
        cls: 'mod-cta',
      });
      openTraceBtn.addEventListener('click', async () => {
        const id = (input as HTMLInputElement).value.trim();
        if (!id) return;
        const bodyEl = document.createElement('pre');
        bodyEl.className = 'inspect-trace-json';
        const result = await sidecarResolveBody({ type: 'activityExecutionTrace', executionId: id }) ?? await sidecarResolveBody({ type: 'executionTrace', id });
        bodyEl.textContent = JSON.stringify(result, null, 2);
        body.appendChild(bodyEl);
      });

      const browseRegistryBtn = body.createEl('button', {
        text: 'Browse registry',
        cls: 'mod-cta',
      });
      browseRegistryBtn.addEventListener('click', async () => {
        // Registry is served by discovery (authed), NOT over the federation
        // /outbound/resolve path — reuse the same call renderPulseTiles uses.
        const reg = await sidecarHttpAuto({ service: 'discovery', method: 'POST', path: '/resolve', body: { pointer: { type: 'vesselRegistry' } } });
        const regBody = ((reg?.body ?? {}) as Record<string, unknown>);
        const regContent = ((regBody.content ?? regBody) as Record<string, unknown>);
        const vessels = (Array.isArray(regContent.vessels) ? regContent.vessels : []) as Array<Record<string, unknown>>;
        const list = body.createEl('div', { cls: 'inspect-registry-list' });
        if (vessels.length === 0) {
          list.createEl('div', { cls: 'inspect-registry-item', text: 'no vessels advertising into discovery' });
        }
        for (const v of vessels) {
          const vid = String(v['vesselId'] ?? v['id'] ?? '');
          const shapesRaw = Array.isArray(v['shapes']) ? v['shapes'] : (Array.isArray(v['advertised_shapes']) ? v['advertised_shapes'] : (Array.isArray(v['capabilities']) ? v['capabilities'] : []));
          const shapes = (shapesRaw as unknown[]).map((x) => typeof x === 'string' ? x : String((x as Record<string, unknown>)?.['shape'] ?? '')).filter(Boolean);
          const line = list.createEl('div', { cls: 'inspect-registry-item', text: shapes.length ? `${vid} — ${shapes.slice(0, 8).join(', ')}${shapes.length > 8 ? '…' : ''}` : vid });
          void line;
        }
      });
    });
  }

  private collectVaultContext(): VaultContext {
    const app = this.plugin.app;
    const ctx: VaultContext = {};
    // Stamp the human operator (the vault) so a direct omnibox dispatch shows
    // "Dispatched by <vault>" rather than falling back to a text-inferred trigger.
    ctx.operator = app.vault.getName();

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

    const { apiKey } = this.plugin.settings;

    if (!apiKey) {
      new Notice('Obsidian: API key not configured. Set it in plugin settings.');
      return;
    }

    this.dispatching = true;
    this.setDispatchBtnState(true);
    this.clearOutput();
    this.mintedConcepts = [];
    this.dispatchStartedAt = Date.now();
    this.appendMessage(`⟶ Goal: "${goal}"`);

    // Collect and display the vault context that will accompany the goal
    const ctx = this.collectVaultContext();
    this.appendVaultContextSummary(ctx);
    try {
      const client = new GoalHostClient();

      // Reset live walk-progress state for this dispatch. Progress is rendered
      // from a poll of goalWalkState (started once the execution_id is known),
      // not a WS event stream.
      this.renderedStepCount = 0;
      this.answerRendered = false;

      // Step 1: dispatch → 202 with dispatchId
      const result = await client.dispatchGoal(goal, ctx);
      const dispatchId = result.executionId; // holds dispatchId from 202 body
      this.activeDispatchId = dispatchId;
      this.activeDispatchSeen = false;
      // Pre-select the presentation arm for this dispatch so the ~2s overlay
      // posterior read never delays the answer render (attention→reward loop).
      void selectPresentationArm(dispatchId, this.plugin.settings.vesselId ?? '');

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

      // Step 3: the execution_id is known — start polling goalWalkState for
      // live per-step progress (elapsedTimer is cleared above on success; catch
      // block clears on failure).
      this.activeExecutionId = executionId;

      if (dispatchVariantId) {
        this.appendMessage(`◈ Activity: ${dispatchVariantId}`);
      }
      this.appendMessage('─'.repeat(36), 'divider');

      this.startWalkPoll();

      // Defer impulse-relevance feedback until the execution settles: firing here
      // reported success before the outcome existed and corrupted the corpus.
      const variantId = dispatchVariantId;
      if (variantId && ctx?.available_shapes?.length) {
        const relevanceShapes = [...ctx.available_shapes];
        this.pendingRelevance.set(executionId, (succeeded: boolean) => {
          void client.recordImpulseRelevance(
            executionId,
            variantId,
            relevanceShapes,
            succeeded,
          );
        });
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
      this.stopWalkPoll();
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
   * True when the user is following the feed at the bottom (within ~a few lines).
   * When false, they have scrolled up to read — auto-scroll MUST NOT yank their
   * viewport. Capture this BEFORE a DOM mutation and re-stick only if it was true,
   * so live-streaming step lines never rip the reader back to the bottom.
   */
  private isNearBottom(): boolean {
    const el = this.scrollEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
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
    const stick = this.isNearBottom();
    const cls = ['sub-feed-line', type ? `sub-t-${type}` : ''].filter(Boolean).join(' ');
    const line = this.outputEl.createDiv(cls);
    line.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
    line.createSpan({ cls: 'sub-feed-msg', text });
    if (stick) this.scrollToBottom();
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
    const stick = this.isNearBottom();
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
    if (stick) this.scrollToBottom();
  }


  // ---------------------------------------------------------------------------
  // Fleet board (WS6) + solicitation cards (WS5) + substrate activity (WS3)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a goal-host shape through the single sidecar conduit's
   * /outbound/resolve — it crosses the overlay, so the panel works on a bare
   * host holding only hub credentials + the relay multiaddr. Returns null when
   * the sidecar is unreachable.
   */
  private async goalHostResolve(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const viaSidecar = await sidecarResolveBody(body);
    if (viaSidecar !== null) return { resolved: true, body: viaSidecar };
    return null;
  }

  private startFleetBoard(): void {
    const tick = async (): Promise<void> => {
      if (!this.fleetEl) return;
      const j = await this.goalHostResolve({ type: 'activeDispatches' });
      if (!j) return;
        this.substrateSeen = true;
      const dispatches = ((j.body as Record<string, unknown> | undefined)?.dispatches ?? []) as Array<Record<string, unknown>>;
      if (Date.now() - this.fleetMembersAt > 25_000) {
        const feed = await this.fetchFleetActivityFeed();
        if (feed && Array.isArray(feed.members)) {
          this.fleetMembers = feed.members as Array<Record<string, unknown>>;
          this.fleetMembersAt = Date.now();
        }
      }
      // Settle the active dispatch once it is no longer running so the Dispatch
      // button re-enables. Two terminal shapes to catch: (a) the dispatch is
      // still listed but with a non-'running' status — match renderFleet's own
      // done-definition (status !== 'running'), NOT the literal 'completed'/
      // 'failed' pair, since a settled dispatch may report a reach-verdict or
      // other terminal status string; (b) the dispatch has dropped out of the
      // active list entirely (goal-host prunes settled dispatches), which is a
      // settle only AFTER we saw it in-flight — a not-yet-registered dispatch is
      // also absent but must keep waiting. Requiring the exact 'completed'/
      // 'failed' pair left the button stuck on 'Dispatching…' after one goal.
      if (this.activeDispatchId) {
        const mine = dispatches.find(
          // activeDispatches entries key the dispatch id under `dispatchId`
          // (verified live: every entry has dispatchId set, `id` is always
          // absent). Matching on `d.id` never hit, so `mine` stayed undefined,
          // activeDispatchSeen never flipped true, and the settle never fired —
          // the button stuck after one goal even with the status !== 'running'
          // fix. Match dispatchId primarily, id as a fallback.
          (d: Record<string, unknown>) =>
            (d.dispatchId ?? d.id) === this.activeDispatchId,
        );
        if (mine) this.activeDispatchSeen = true;
        const settled = mine ? mine.status !== 'running' : this.activeDispatchSeen;
        if (settled) {
          if (this.elapsedTimer !== null) { window.clearInterval(this.elapsedTimer); this.elapsedTimer = null; }
          this.stopWalkPoll();
          this.dispatching = false;
          this.setDispatchBtnState(false);
          this.activeDispatchId = null;
          this.activeExecutionId = null;
          this.activeDispatchSeen = false;
        }
      }
      // Repaint every tick — the board must stay live even while a row is
      // expanded. renderFleet preserves an expanded row's open state (the
      // data-dispatch-key/rowSnap diff reuses unchanged rows in place and
      // renderFleetRow re-attaches + re-fetches detail for any row still in
      // expandedDispatches), and it is the ONLY path that refreshes the
      // settled/completed list (completedDispatches is set inside it). Gating
      // it behind an empty-expansion check froze the whole board — and the
      // completed list with it — the moment the user opened a row to read it.
      // SMOOTHNESS FOR HUMAN RESOLVERS: never reflow the board out from under a
      // human who is mid-interaction. If a feedback control inside the panel is
      // focused (grading a dispatch — typing directed feedback), DEFER this ambient
      // repaint to the next tick so their scroll position and typing are never
      // yanked. Otherwise preserve the scroll position across the repaint so an
      // incoming completion never jumps their place. (The interacting human is
      // exactly the reliability we optimize for — a moving UI makes them misclick.)
      const _activeEl = this.scrollEl?.ownerDocument?.activeElement as HTMLElement | null;
      const _humanEditing = !!(_activeEl && this.scrollEl?.contains(_activeEl)
        && (_activeEl.tagName === 'TEXTAREA' || _activeEl.tagName === 'INPUT' || _activeEl.isContentEditable));
      if (_humanEditing) return;
      const _savedTop = this.scrollEl ? this.scrollEl.scrollTop : 0;
      await this.guardSection(this.fleetEl, 'Fleet', () => this.renderFleet(dispatches));
      if (this.scrollEl && Math.abs(this.scrollEl.scrollTop - _savedTop) > 1) this.scrollEl.scrollTop = _savedTop;
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
   * Resolve a shape by name through the single sidecar conduit (crosses the
   * federation overlay; reaches libp2p-only producers that host-reachable HTTP
   * cannot). Returns null when the sidecar is unreachable.
   */
  private async devVesselResolve(
    shape: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const viaSidecar = await sidecarResolveBody({ type: shape, ...extra });
    if (viaSidecar !== null) return { resolved: true, body: viaSidecar };
    return null;
  }

  private async guardSection(el: HTMLElement | null, name: string, render: () => void | Promise<void>): Promise<void> {
    try {
      await render();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`[GoalDispatchView] ${name} section failed to render`, err);
      if (!el) return;
      el.empty();
      const card = el.createDiv('sub-card sub-card--error');
      card.createDiv({ cls: 'sub-section-header', text: `${name} — render failed` });
      card.createDiv({ cls: 'sub-fleet-note', text: err.message.slice(0, 180), attr: { title: (err.stack ?? err.message).slice(0, 1500) } });
    }
  }

  private startWorkBoard(): void {
    const tick = (): void => {
      void this.guardSection(this.groupEl, 'Group', () => this.renderGroupFeed());
      void this.guardSection(this.gapsEl, 'Gaps', () => this.renderGaps());
      void this.guardSection(this.projectsEl, 'Projects', () => this.renderProjects());
      void this.guardSection(this.pulseEl, 'Pulse', () => this.renderPulse());
    };
    tick();
    this.workBoardTimer = window.setInterval(tick, 30000);
		// On a fresh boot the sidecar conduit may not be up yet, so the very first tick can find no conduit and render honest empties. Retry on a short cadence until ANY resolve answers (then the sections re-render with real data on that same fast tick), for at most a minute; the 30s cadence owns steady state. registerInterval → cleared on view close.
		const fastRetry = window.setInterval(() => {
			if (this.substrateSeen) {
				window.clearInterval(fastRetry);
				return;
			}
			tick();
		}, 5000);
		this.registerInterval(fastRetry);
		window.setTimeout(() => window.clearInterval(fastRetry), 60_000);
  }

  private stopWorkBoard(): void {
    if (this.workBoardTimer !== null) {
      window.clearInterval(this.workBoardTimer);
      this.workBoardTimer = null;
    }
  }

  /**
   * Fetch the goal-host fleetActivityFeed aggregate through the sidecar.
   * Primary: the shaped resolve (overlay-capable — works on a bare host).
   * Progressive enhancement: some goal-host builds serve the shape only on
   * /v2/impulses/resolve while the registered /resolve row still rejects it,
   * so when the shaped resolve yields nothing usable, retry the v2 surface
   * through the sidecar's shape-routed HTTP proxy. Returns null when the
   * aggregate producer is missing entirely — the renderer then composes the
   * same sections from direct resolves instead of going blank.
   */
  private async fetchFleetActivityFeed(): Promise<Record<string, unknown> | null> {
    const viaResolve = await sidecarResolveBody({ type: 'fleetActivityFeed' });
    if (viaResolve && Array.isArray(viaResolve.members)) return viaResolve;
    const viaV2 = await sidecarHttpAuto({
      shape: 'fleetActivityFeed',
      method: 'POST',
      path: '/v2/impulses/resolve',
      body: { impulse: { pointer: { type: 'fleetActivityFeed' } } },
    });
    if (viaV2?.ok && viaV2.body && typeof viaV2.body === 'object') {
      const outer = viaV2.body as Record<string, unknown>;
      for (const candidate of [outer.body, outer.content, outer]) {
        if (
          candidate && typeof candidate === 'object' &&
          Array.isArray((candidate as Record<string, unknown>).members)
        ) {
          return candidate as Record<string, unknown>;
        }
      }
    }
    return null;
  }

  /**
   * Group activity feed: what the whole peering group is working on — member
   * dispatches tagged by substrate, gap filings from any member, boredom
   * (condition-driven idle) work, and rhythm due-ness. Data path: the
   * fleetActivityFeed aggregate via the sidecar; while that producer is
   * missing or its legs land empty, the same sections are composed from
   * direct overlay resolves (activeDispatches / substrateGap / rhythm
   * poolImpulses) with an honest note — the panel never renders blank solely
   * because the aggregate producer is absent.
   */
  private groupCache: {
    feedOk: boolean;
    members: Array<Record<string, unknown>>;
    gaps: Array<Record<string, unknown>>;
    boredom: Array<Record<string, unknown>>;
    rhythms: Array<Record<string, unknown>>;
    supplemented: string[];
  } | null = null;

  private async renderGroupFeed(refetch = true): Promise<void> {
    const el = this.groupEl;
    if (!el) return;
    if (!refetch && this.groupCache) {
      this.drawGroupFeed(el, this.groupCache);
      return;
    }
    const feed = await this.fetchFleetActivityFeed();

    const arr = (v: unknown): Array<Record<string, unknown>> =>
      Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
    let members = feed ? arr(feed.members) : [];
    let gaps = feed ? arr(feed.gaps) : [];
    const boredom = feed ? arr(feed.boredom) : [];
    let rhythms = feed ? arr(feed.rhythms) : [];
    const supplemented: string[] = [];
    const dispatchCountOf = (ms: Array<Record<string, unknown>>): number =>
      ms.reduce((n, m) => n + arr(m.dispatches).length, 0);

    if (dispatchCountOf(members) === 0) {
      const dj = await this.goalHostResolve({ type: 'activeDispatches' });
      const dispatches = arr((dj?.body as Record<string, unknown> | undefined)?.dispatches);
      if (dispatches.length > 0) {
        members = [
          { substrate: 'local', reachable: true, dispatches },
          ...members.filter((m) => m.substrate !== 'local'),
        ];
        supplemented.push('dispatches');
      }
    }
    if (gaps.length === 0) {
      const gj = await this.devVesselResolve('substrateGap', { limit: 100 });
      const open = arr((gj?.body as Record<string, unknown> | undefined)?.gaps).filter((g) => g.status === 'open');
      if (open.length > 0) {
        gaps = open.map((g) => ({ substrate: 'local', ...g }));
        supplemented.push('gaps');
      }
    }
    if (rhythms.length === 0) {
      const rj = await this.devVesselResolve('poolImpulse', { shape: 'timeShapedRhythm', limit: 12 });
      const imps = arr((rj?.body as Record<string, unknown> | undefined)?.impulses);
      if (imps.length > 0) {
        rhythms = imps;
        supplemented.push('rhythms');
      }
    }

    // One substrate seen by several routes is one member, not several — decide
    // that by shared dispatch ids, before anything counts or renders them.
    this.groupCache = { feedOk: !!feed, members: dedupeMembers(members as never) as typeof members, gaps, boredom, rhythms, supplemented };
    this.drawGroupFeed(el, this.groupCache);
  }

  /** Pure draw from composed data — synchronous, so toggles repaint instantly. */
  private drawGroupFeed(el: HTMLElement, c: NonNullable<GoalDispatchView['groupCache']>): void {
    const arr = (v: unknown): Array<Record<string, unknown>> =>
      Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
    const { members, gaps, boredom, rhythms, supplemented } = c;
    const dispatchCountOf = (ms: Array<Record<string, unknown>>): number =>
      ms.reduce((n, m) => n + arr(m.dispatches).length, 0);
    const groupSnap = JSON.stringify({ members, gaps, boredom, rhythms, supplemented, expanded: this.groupExpanded });
    if (this.lastRenderedSnapshot.get('group') === groupSnap) return;
    this.lastRenderedSnapshot.set('group', groupSnap);
    el.empty();
    if (members.length === 0 && gaps.length === 0 && boredom.length === 0 && rhythms.length === 0) {
      el.createDiv({
        cls: 'sub-fleet-note',
        text: 'Group — no activity data reachable (aggregate feed missing and direct resolves silent)',
      });
      return;
    }

    const dispatchTotal = dispatchCountOf(members);
    const header = el.createDiv({
      cls: 'sub-section-header is-toggle',
      text: `${this.groupExpanded ? '▾' : '▸'} Group — ${members.length} member${members.length === 1 ? '' : 's'} · ${dispatchTotal} dispatch${dispatchTotal === 1 ? '' : 'es'} · ${gaps.length} gap${gaps.length === 1 ? '' : 's'}`,
    });
    header.addEventListener('click', () => {
      this.groupExpanded = !this.groupExpanded;
      void this.renderGroupFeed(false);
    });
    this.makeToggleAccessible(header, this.groupExpanded, () => {
      this.groupExpanded = !this.groupExpanded;
      void this.renderGroupFeed(false);
    });
    if (!c.feedOk) {
      el.createDiv({ cls: 'sub-fleet-note', text: 'aggregate feed unavailable — showing direct overlay resolves' });
    } else if (supplemented.length > 0) {
      el.createDiv({ cls: 'sub-fleet-note', text: `feed producer incomplete — ${supplemented.join(', ')} from direct resolves` });
    }
    if (!this.groupExpanded) return;

    // Member dispatches, tagged by substrate.
    for (const m of members) {
      const name = String(m.substrate ?? 'unknown');
      const reachable = m.reachable !== false;
      el.createDiv({
        cls: 'sub-fleet-note',
        text: `${reachable ? '●' : '○'} ${name}${reachable ? '' : ' (unreachable)'}`,
      });
      const dispatches = arr(m.dispatches);
      for (const d of dispatches) {
        // sub-fleet-elapsed: [narrowed] UI feedback (hard_to_understand) on the
        // surface: the elapsed column keeps counting after a run has finished.
        // Ensure the time displayed for 'elapsed' is fixed if 'finished_at' is present.
        if (d.finished_at && d.started_at) {
          d.elapsed_ms = new Date(d.finished_at as string).getTime() - new Date(d.started_at as string).getTime();
        }
      }
      if (dispatches.length === 0 && reachable) {
        el.createDiv({ cls: 'sub-fleet-empty', text: 'idle — no dispatches reported' });
      }
      for (const d of dispatches.slice(0, 8)) {
        const row = el.createDiv('sub-card sub-card--fleet');
        const running = d.status === 'running';
        const dot = running ? '●' : d.reached === true ? '✓' : d.reached === false ? '✗' : '○';
        const statusCls = running ? 'is-running' : d.reached === true ? 'is-reached' : 'is-not-reached';
        row.createSpan({ cls: `sub-fleet-status ${statusCls}`, text: dot });
        const goal = dispatchLabel(d as { goal?: unknown });
        row.createSpan({
          cls: 'sub-fleet-goal',
          text: goal.length > 54 ? goal.slice(0, 54) + '…' : goal,
          attr: { title: goal },
        });
        row.createSpan({ cls: 'sub-chip', text: name, attr: { title: `substrate: ${name}` } });
        const started = typeof d.startedAt === 'number' ? d.startedAt : 0;
        if (started) row.createSpan({ cls: 'sub-fleet-elapsed', text: fmtRel(Date.now() - started) });
      }
    }

    // Gap filings from any member.
    if (gaps.length > 0) {
      el.createDiv({ cls: 'sub-section-header', text: `Gap filings — ${gaps.length}` });
      for (const g of gaps.slice(0, 8)) {
        const row = el.createDiv('sub-card sub-gap-row');
        const label = String(g.category ?? g.id ?? '(gap)');
        row.createSpan({
          cls: 'sub-gap-cat',
          text: label.length > 38 ? label.slice(0, 38) + '…' : label,
          attr: { title: String(g.id ?? label) },
        });
        row.createSpan({ cls: 'sub-chip', text: String(g.substrate ?? 'local'), attr: { title: `substrate: ${String(g.substrate ?? 'local')}` } });
        const src = String(g.source ?? '');
        if (src) {
          row.createSpan({ cls: `sub-badge sub-badge--${src.replace(/[^a-z]/gi, '')}`, text: sourceLabel(src), attr: { title: `source: ${src}` } });
        }
        const summary = typeof g.summary === 'string' ? g.summary.replace(/^\[[^\]]*\]\s*/, '') : '';
        if (summary) {
          row.createDiv({
            cls: 'sub-gap-summary',
            text: summary.length > 100 ? summary.slice(0, 100) + '…' : summary,
            attr: { title: summary },
          });
        }
      }
      if (gaps.length > 8) {
        el.createDiv({ cls: 'sub-fleet-note', text: `+${gaps.length - 8} more gap filings` });
      }
    }

    // Boredom (condition-driven idle) work — honest empty-state when absent.
    el.createDiv({
      cls: 'sub-section-header',
      text: boredom.length > 0 ? `Boredom work — ${boredom.length}` : 'Boredom work — none reported',
    });
    for (const b of boredom.slice(0, 6)) {
      const text = String(b.summary ?? b.goal ?? b.description ?? b.id ?? JSON.stringify(b).slice(0, 90));
      const line = el.createDiv({ cls: 'sub-feed-line' });
      line.createSpan({
        cls: 'sub-feed-msg',
        text: text.length > 100 ? text.slice(0, 100) + '…' : text,
        attr: { title: text },
      });
      if (b.substrate) line.createSpan({ cls: 'sub-chip', text: String(b.substrate) });
    }

    // Rhythm due-ness meters (same 4px meter primitive as the pulse strip).
    if (rhythms.length > 0) {
      const meters = el.createDiv({ cls: 'sub-rhythm-meters' });
      for (const r of rhythms.slice(0, 12)) {
        const body = (r.body && typeof r.body === 'object' ? r.body : r) as Record<string, unknown>;
        const family = String(body.family ?? body.id ?? r.id ?? 'rhythm');
        const staleness = typeof body.staleness === 'number' ? body.staleness : 0;
        const meter = meters.createDiv({ cls: 'sub-rhythm-meter' });
        meter.createSpan({ cls: 'sub-rhythm-name', text: family });
        const track = meter.createDiv({ cls: 'sub-rhythm-track' });
        const fill = track.createDiv({ cls: 'sub-rhythm-fill' });
        fill.style.width = `${Math.round(staleness * 100)}%`;
        meter.setAttr('title', `rhythm ${family} · staleness ${Math.round(staleness * 100)}%${r.substrate ? ` · ${String(r.substrate)}` : ''}`);
      }
    }
  }

  /**
   * Gaps section: the substrate's self-improvement backlog. Each gap's SOURCE
   * badge is the "why it's being worked on" signal — substrate_detected (a
   * detector found it), goal_host_auto_draft (the walk chose to draft a fix),
   * operator_narration (a human filed it), gap_decompose (split from a bigger
   * gap). Collapsed to an open/closed count; expands to the recent open gaps.
   */
  private gapsCache: Array<Record<string, unknown>> | null = null;

  private async renderGaps(refetch = true): Promise<void> {
    const el = this.gapsEl;
    if (!el) return;
    // Toggles pass refetch:false and redraw synchronously from the cache —
    // a click must never wait on an overlay round-trip to show its effect.
    if (refetch || this.gapsCache === null) {
      const j = await this.devVesselResolve('substrateGap', { limit: 200 });
      this.gapsCache = ((j?.body as Record<string, unknown> | undefined)?.gaps ?? []) as Array<Record<string, unknown>>;
    }
    const gaps = this.gapsCache;
    const gapsSnap = JSON.stringify({ gaps, expanded: this.gapsExpanded, threads: [...this.gapDetailExpanded] });
    if (this.lastRenderedSnapshot.get('gaps') === gapsSnap) return;
    this.lastRenderedSnapshot.set('gaps', gapsSnap);
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
      void this.renderGaps(false);
    });
    this.makeToggleAccessible(header, this.gapsExpanded, () => {
      this.gapsExpanded = !this.gapsExpanded;
      void this.renderGaps(false);
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
    this.makeToggleAccessible(toggle, expanded, () => {
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
  private async renderPulse() {
        if (!this.pulseEl) return;
        // Do NOT empty here: renderPulseTiles empties atomically only when it
        // is about to redraw (after its snapshot gate and after the resolves
        // land). Emptying up front blanked the section for the whole fetch,
        // and left it blank forever whenever the snapshot was unchanged.
        await this.renderPulseTiles(this.pulseEl);
  }

  private async renderPulseTiles(el: HTMLElement): Promise<void> {
    const [dj, gj, rhythmRes, feed, reg] = await Promise.all([
      this.goalHostResolve({ type: 'activeDispatches' }),
      this.devVesselResolve('substrateGap', { limit: 200 }),
      this.devVesselResolve('poolImpulse', { shape: 'timeShapedRhythm', limit: 12 }),
      this.fetchFleetActivityFeed(),
      sidecarHttpAuto({ service: 'discovery', method: 'POST', path: '/resolve', body: { pointer: { type: 'vesselRegistry' } } }),
    ]);
    const dispatches = ((dj?.body as Record<string, unknown> | undefined)?.dispatches ?? []) as Array<Record<string, unknown>>;
    const gaps = ((gj?.body as Record<string, unknown> | undefined)?.gaps ?? []) as Array<Record<string, unknown>>;
    const regBody = ((reg?.body ?? {}) as Record<string, unknown>);
    const regContent = ((regBody.content ?? regBody) as Record<string, unknown>);
    const vessels = (Array.isArray(regContent.vessels) ? regContent.vessels : []) as Array<Record<string, unknown>>;
    const members = (feed && Array.isArray(feed.members) ? feed.members : []) as Array<Record<string, unknown>>;
    const verdict = cachedPulseVerdict();
    // Never blank an existing good render on a TRANSIENT all-empty fetch (the common
    // case on a degraded/offline plane — all five fan-out resolves default to [] on
    // timeout). Honor the "panel never renders blank" intent: preserve the last good
    // tiles instead of emptying to a bare header.
    const allEmpty = dispatches.length === 0 && gaps.length === 0 && vessels.length === 0
      && members.length === 0 && !verdict?.sentence;
    if (allEmpty && el.querySelector('.sub-pulse-tiles')) return;
    // Snapshot on the RENDERED values (counts + running + verdict), NOT the raw objects
    // whose timestamps churn every tick and forced a needless empty()+rebuild (flicker).
    const pulseSnapshot = JSON.stringify({
      d: dispatches.length,
      run: dispatches.filter((x) => (x as { status?: string }).status === 'running').length,
      g: gaps.length, v: vessels.length, m: members.length,
      verdict: verdict?.sentence ?? '', at: verdict?.asOf ?? 0,
    });
    if (this.lastRenderedSnapshot.get('pulse') === pulseSnapshot) return;
    this.lastRenderedSnapshot.set('pulse', pulseSnapshot);
    el.empty();
    el.createDiv({ cls: 'sub-section-header', text: 'Pulse' });
    const tiles = el.createDiv({ cls: 'sub-pulse-tiles' });
    const addTile = (label: string, value: string, cap: string, opts?: { wide?: boolean; meterPct?: number; tooltip?: string }): HTMLElement => {
      const tile = tiles.createDiv({ cls: `sub-stat-tile${opts?.wide ? ' sub-stat-tile--wide' : ''}` });
      tile.createDiv({ cls: 'sub-stat-label', text: label });
      tile.createDiv({ cls: 'sub-stat-value', text: value });
      if (typeof opts?.meterPct === 'number') {
        const meter = tile.createDiv({ cls: 'sub-stat-meter' });
        const fill = meter.createDiv({ cls: 'sub-stat-meter-fill' });
        fill.style.width = `${Math.max(0, Math.min(100, Math.round(opts.meterPct)))}%`;
      }
      if (cap) tile.createDiv({ cls: 'sub-stat-cap', text: cap });
      if (opts?.tooltip) tile.setAttr('title', opts.tooltip);
      return tile;
    };
    // Reach rate — the one number the execution contract is measured against.
    const memberDispatches = members.flatMap((m) => (Array.isArray(m.dispatches) ? m.dispatches : []) as Array<Record<string, unknown>>);
    const settledWindow = (memberDispatches.length ? memberDispatches : dispatches)
      .filter((d) => d['status'] === 'completed' || d['status'] === 'failed')
      .sort((a, b) => Number(a['startedAt'] ?? 0) - Number(b['startedAt'] ?? 0))
      .slice(-20);
    if (settledWindow.length) {
      const reachedCount = settledWindow.filter((d) => d['reached'] === true || d['reached'] === 'yes').length;
      const pct = Math.round((reachedCount / settledWindow.length) * 100);
      addTile('reach rate', `${pct}%`, reachCaption(reachedCount, settledWindow.length), {
        wide: true,
        meterPct: pct,
        tooltip: 'Goal-reach verdicts on the last settled dispatches - the honest outcome signal, not exit status.',
      });
    }
    if (vessels.length) {
      // Count vessels, not advertisements — the same process is listed once per
      // route it can be reached by (see distinctVessels).
      const ids = vessels.map((v) => String(v['vesselId'] ?? '')).filter(Boolean);
      const dv = distinctVessels(ids);
      addTile('vessels', String(dv.total), vesselsCaption(dv.total, dv.byHome), {
        tooltip: `${ids.length} advertisements resolve to ${dv.total} distinct vessels: ${ids.join(', ')}`,
      });
    }
    if (members.length) {
      // Count PEER substrates (exclude this substrate's own 'local' member) so
      // the tile does not count self as a peer — the caption describes each
      // peer's role (resolver hub) and vessel count from the fleet feed.
      const canonical = dedupeMembers(members as never);
      const peerCount = canonical.filter((m) => String(m['substrate'] ?? '') !== 'local').length;
      addTile('peers', String(peerCount), peersCaption(canonical as Array<{ substrate?: string; role?: string; vesselCount?: number | null; reachable?: boolean }>), {
        tooltip: 'Peer substrates reachable across the federation relay (resolver/relay hubs this spoke federates to).',
      });
    }
    if (gaps.length) {
      const open = gaps.filter((g) => g['status'] === 'open');
      const dayAgo = Date.now() - 86_400_000;
      const closed24 = gaps.filter((g) => g['status'] === 'closed' && Date.parse(String(g['updated_at'] ?? '')) > dayAgo).length;
      const oldest = open.map((g) => Date.parse(String(g['created_at'] ?? g['detected_at'] ?? ''))).filter((t) => Number.isFinite(t)).sort((a, b) => a - b)[0];
      addTile('known gaps', String(open.length), gapsCaption(closed24, oldest !== undefined ? Date.now() - oldest : null), {
        tooltip: 'Gap flow: how much self-improvement backlog is open and how fast it is draining.',
      });
    }
    // Runners — who can execute goals simultaneously; hue keys match the fleet cards.
    const runnerNames: string[] = [];
    for (const v of vessels) {
      const shapes = (Array.isArray(v['shapes']) ? v['shapes'] : []).map(String);
      const vid = String(v['vesselId'] ?? '');
      const home = vid.includes('@') ? vid.slice(vid.indexOf('@') + 1) : '';
      if (shapes.includes('goal_execution')) runnerNames.push(home ? `goal-host · ${home}` : 'goal-host');
      if (shapes.includes('light_dispatch_execution')) runnerNames.push(home ? `light-dispatch · ${home}` : 'light-dispatch');
    }
    if (feed && feed['boredom']) runnerNames.push('boredom');
    if (runnerNames.length) {
      const tile = addTile('runners', String(runnerNames.length), runnersCaption(runnerNames));
      const chips = tile.createDiv({ cls: 'sub-runner-chips' });
      for (const name of runnerNames) {
        const chip = chips.createSpan({ cls: 'sub-runner-chip' });
        const hue = name.startsWith('goal-host') ? 'is-goalhost' : name.startsWith('light-dispatch') ? 'is-lightdispatch' : 'is-boredom';
        chip.createSpan({ cls: `sub-runner-dot ${hue}` });
        chip.createSpan({ text: name });
      }
    }
    // The substrate's own sentence about its vitals: the pulse aggregator's
    // reach-judged verdict, refreshed when stale (a dispatched goal, not a poll).
    if (verdict && verdict.sentence) {
      const narr = el.createDiv({ cls: 'sub-pulse-narr' });
      narr.setText(verdict.sentence);
      narr.createSpan({ cls: 'sub-pulse-asof', text: asOfNote(verdict.asOf) });
    }
    void refreshPulseVerdict().then((v) => {
      if (v && v.asOf !== (verdict?.asOf ?? 0)) {
        this.lastRenderedSnapshot.delete('pulse');
        void this.renderPulse();
      }
    });
    const rhythms = (((rhythmRes?.body as Record<string, unknown> | undefined)?.['impulses'] ?? []) as Array<unknown>).filter((r): r is { body: Record<string, unknown> & { staleness: number } } => {
      if (!r || typeof r !== 'object') return false;
      const rb = (r as Record<string, unknown>)['body'];
      return !!rb && typeof rb === 'object' && typeof (rb as Record<string, unknown>)['staleness'] === 'number';
    }) as Array<{ id: string; body: { family: string; axis: string; staleness: number; budget: number; alpha: number; beta: number } }>;
    if (rhythms.length > 0) {
      const sorted = [...rhythms].sort((a, b) => b.body.staleness - a.body.staleness);
      const meters = el.createDiv({ cls: 'sub-rhythm-meters' });
      for (const rhythm of sorted) {
        const { family, axis, staleness, budget, alpha, beta } = rhythm.body;
        const meter = meters.createDiv({ cls: 'sub-rhythm-meter' });
        meter.createSpan({ cls: 'sub-rhythm-name', text: family });
        const track = meter.createDiv({ cls: 'sub-rhythm-track' });
        const fill = track.createDiv({ cls: 'sub-rhythm-fill' });
        fill.style.width = `${Math.round(staleness * 100)}%`;
        meter.setAttr('title', `rhythm ${family} · axis ${axis} · staleness ${Math.round(staleness * 100)}% · budget ${budget} · α${alpha}/β${beta} — due-ness the conductor folds into boredom selection`);
      }
    }
  }

  private projectsCache: Array<Record<string, unknown>> | null = null;

  private async renderProjects(refetch = true): Promise<void> {
    const el = this.projectsEl;
    if (!el) return;
    if (refetch || this.projectsCache === null) {
      const j = await this.devVesselResolve('memoryNote', { note_type: 'project', limit: 40 });
      this.projectsCache = ((j?.body as Record<string, unknown> | undefined)?.notes ?? []) as Array<Record<string, unknown>>;
    }
    const notes = this.projectsCache;
		const projectsSnap = JSON.stringify({ notes, expanded: this.projectsExpanded });
		if (this.lastRenderedSnapshot.get('projects') === projectsSnap) return;
		this.lastRenderedSnapshot.set('projects', projectsSnap);
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
      void this.renderProjects(false);
    });
    this.makeToggleAccessible(header, this.projectsExpanded, () => {
      this.projectsExpanded = !this.projectsExpanded;
      void this.renderProjects(false);
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
    const goal = dispatchLabel(d as { goal?: unknown });
    const goalSnippet = goal.length > 60 ? goal.slice(0, 60) + '…' : goal;
    row.createSpan({ cls: `sub-fleet-status ${statusCls}`, text: dot });
    row.createSpan({ cls: 'sub-fleet-goal', text: goalSnippet, attr: { title: goal } });
        const tid = typeof d.selectedTemplateId === 'string' ? d.selectedTemplateId : '';
        if (tid) {
          row.createSpan({ cls: 'sub-chip sub-chip--sel sub-fleet-activity', text: shortId(tid), attr: { title: 'activity: ' + tid } });
        }
    row.createSpan({ cls: 'sub-fleet-elapsed', text: elapsed });
    // Reached-led verdict pill for settled rows; narrative line + runner
    // accent for running rows (mockup parity).
    if (!running) {
      const verdictCls = d.reached === true ? 'is-ok' : d.reached === false ? 'is-no' : '';
      const verdictText = d.reached === true ? '● reached' : d.reached === false ? '● not reached' : '○ unknown';
      row.createSpan({ cls: `sub-verdict ${verdictCls}`, text: verdictText });
    }
    if (running) {
      row.addClass('is-running-card');
      row.createDiv({ cls: 'sub-fleet-narr', text: runningNarrative(goal, d as { operator?: unknown; selectedTemplateId?: unknown }) });
    }
    // Reached-led: when steps failed but the goal was still reached, say so
    // inline rather than letting the ✗-adjacent status imply failure.
    if (!running && d.reached === true && d.status === 'failed') {
      row.createSpan({ cls: 'sub-chip sub-chip--ok sub-fleet-note', text: 'goal reached', attr: { title: 'steps exited non-zero but the goal was reached' } });
    }
    row.addEventListener('click', (ev) => { const t = ev.target as HTMLElement | null; if (t && t.closest('.sub-fleet-detail')) return; void this.expandFleetRow(row, d); });
    // Auto-expand a running dispatch the first time we see it so its live
    // decision tree (selection + shape flow) renders as the walk proceeds,
    // matching cockpit parity. autoExpandedRunning also holds explicit
    // collapses, so we honour a human closing the row.
    const rowId = String(d.dispatchId ?? '');
    if (running && rowId && !this.autoExpandedRunning.has(rowId)) {
      this.autoExpandedRunning.add(rowId);
      this.expandedDispatches.add(rowId);
    }
        this.makeToggleAccessible(row, this.expandedDispatches.has(String(d.dispatchId ?? '')), () => void this.expandFleetRow(row, d));
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
    const fleetSnap = JSON.stringify({ dispatches, members: this.fleetMembers });
    if (this.lastRenderedSnapshot.get('fleet') === fleetSnap) return;
    this.lastRenderedSnapshot.set('fleet', fleetSnap);
    // The running view spans every runner the fleet feed can see, grouped by
    // home substrate ("currently running, from all runners, grouped by
    // address"); the overlay-picked owner's own list is the fallback when
    // the feed has not answered yet.
    const memberRunning = this.fleetMembers.flatMap((m) => {
      const home = String(m.substrate ?? '');
      return ((Array.isArray(m.dispatches) ? m.dispatches : []) as Array<Record<string, unknown>>)
        .filter((d) => d.status === 'running')
        .map((d) => ({ ...d, __home: home } as Record<string, unknown>));
    });
    const localRunning = dispatches.filter((d) => d.status === 'running');
    const running = memberRunning.length > 0
      ? memberRunning.sort((a, b) => String(a.__home ?? '').localeCompare(String(b.__home ?? '')))
      : localRunning;
    // Rows the human has open stay on the board after they settle. A dispatch
    // becomes READABLE at the moment it finishes — that is when the verdict and
    // the evidence exist — but that is also the moment it used to drop out of
    // the fleet and reappear, unfindable, inside a collapsed pile of look-alike
    // rows. Anything opened (by the reader, or auto-opened while running) is
    // held here until they close it, which is what the row click already does.
    const heldIds = new Set(this.expandedDispatches);
    const held = dispatches.filter(
      (d) => d.status !== 'running' && heldIds.has(String(d.dispatchId ?? d.id ?? '')),
    ).map((d) => ({ ...d, __home: '__held' } as Record<string, unknown>));
    const board = [...running, ...held];
    // Held rows live in exactly one place — don't also list them as completed.
    this.completedDispatches = dispatches.filter(
      (d) => d.status !== 'running' && !heldIds.has(String(d.dispatchId ?? d.id ?? '')),
    );
    let header = el.querySelector(':scope > .sub-section-header') as HTMLElement | null;
    if (!header) {
      el.empty();
      header = el.createDiv({ cls: 'sub-section-header' });
    }
    header.setText(`Fleet — ${running.length} in flight`);
    const emptyNote = el.querySelector(':scope > .sub-fleet-empty') as HTMLElement | null;
    if (running.length === 0 && !emptyNote) {
      el.createDiv({ cls: 'sub-fleet-empty', text: 'No dispatches in flight.' });
    } else if (running.length > 0 && emptyNote) {
      emptyNote.remove();
    }
    const seen = new Set<string>();
    const seenHeads = new Set<string>();
    let lastHome: string | null = null;
    for (const d of board) {
      const key = String(d.dispatchId ?? d.id ?? '');
      seen.add(key);
      // Runner group head whenever the home substrate changes (rows are
      // sorted by it); hue key matches the pulse runner chips.
      const home = String(d.__home ?? '');
      if (home !== lastHome) {
        lastHome = home;
        seenHeads.add(home);
        let head = el.querySelector(`:scope > [data-runner-head="${CSS.escape(home)}"]`) as HTMLElement | null;
        if (!head) {
          head = el.createDiv({ cls: `sub-group-head${home === '__held' ? ' is-held' : ''}` });
          head.dataset.runnerHead = home;
          head.createSpan({ cls: `sub-runner-dot ${home === '__held' ? 'is-held' : 'is-goalhost'}` });
          head.createSpan({
            text: home === '__held'
              ? 'Finished — kept open for you to read (click a row to release it)'
              : home && home !== 'local' ? `goal-host · ${home}` : 'goal-host',
          });
          head.createSpan({ cls: 'sub-group-n' });
        }
        const n = head.querySelector('.sub-group-n') as HTMLElement | null;
        if (n) n.setText(String(board.filter((r) => String(r.__home ?? '') === home).length));
        el.appendChild(head);
      }
      const rowSnap = JSON.stringify(d);
      let wrap = el.querySelector(`:scope > [data-dispatch-key="${CSS.escape(key)}"]`) as HTMLElement | null;
      // Running rows always rebuild so renderFleetDetail re-fetches fresh
      // goalWalkState and the live step tree advances in place; the summary
      // `d` can be unchanged while `steps` grow, so a rowSnap match is stale.
      if (wrap && wrap.dataset.rowSnap === rowSnap && d.status !== 'running') {
        el.appendChild(wrap);
        continue;
      }
      // Never tear down the row the pointer is inside. Rebuilding it mid-read
      // is what makes the board feel like it moves under the reader: the detail
      // scroll jumps back, a selection is lost, and whatever they were about to
      // click has gone. Freeze it, mark it frozen so the pause is legible, and
      // let the next poll after they leave catch it up.
      if (wrap && this.hoveredDispatchId === key) {
        wrap.addClass('is-frozen');
        el.appendChild(wrap);
        continue;
      }
      if (!wrap) {
        wrap = el.createDiv();
        wrap.dataset.dispatchKey = key;
        wrap.addEventListener('mouseenter', () => { this.hoveredDispatchId = key; });
        wrap.addEventListener('mouseleave', () => {
          if (this.hoveredDispatchId === key) this.hoveredDispatchId = null;
          wrap?.removeClass('is-frozen');
        });
      }
      wrap.removeClass('is-frozen');
      wrap.dataset.rowSnap = rowSnap;
      wrap.empty();
      el.appendChild(wrap);
      this.renderFleetRow(wrap, d, d.status === 'running');
    }
    for (const stale of Array.from(el.querySelectorAll(':scope > [data-dispatch-key]'))) {
      const k = (stale as HTMLElement).dataset.dispatchKey ?? '';
      // An open row is never reaped, even once goal-host has pruned it from the
      // active list — the reader closes it, nothing else does.
      if (!seen.has(k) && !this.expandedDispatches.has(k)) stale.remove();
    }
    for (const staleHead of Array.from(el.querySelectorAll(':scope > [data-runner-head]'))) {
      const k = (staleHead as HTMLElement).dataset.runnerHead ?? '';
      if (!seenHeads.has(k)) staleHead.remove();
    }
    this.renderCompleted();
  }

  private makeToggleAccessible(el: HTMLElement, expanded: boolean, onActivate: () => void): void {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-expanded', String(expanded));
    el.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.target !== el) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onActivate();
      }
    });
  }

  /** Completed goals: a one-line count, expandable to collapsed rows. */
  private renderCompleted(): void {
    const el = this.completedEl;
    if (!el) return;
    const completedSnap = JSON.stringify({ done: this.completedDispatches, expanded: this.completedExpanded, q: this.completedFilter });
    if (this.lastRenderedSnapshot.get('completed') === completedSnap) return;
    this.lastRenderedSnapshot.set('completed', completedSnap);
    const done = this.completedDispatches;
    if (done.length === 0) { el.empty(); return; }
    const reached = done.filter((d) => d.reached === true).length;

    // The header and the filter box PERSIST across re-renders; only the row
    // list is rebuilt. Recreating the whole section every poll destroyed the
    // filter input mid-keystroke — you would click it, a poll would fire, and
    // your focus (and anything typed since) was gone. Nothing the human is
    // typing into may be torn down by a background refresh.
    let header = el.querySelector(':scope > .sub-section-header') as HTMLElement | null;
    if (!header) {
      el.empty();
      header = el.createDiv({ cls: 'sub-section-header is-toggle' });
      const toggle = (): void => {
        this.completedExpanded = !this.completedExpanded;
        this.renderCompleted();
      };
      header.addEventListener('click', toggle);
      this.makeToggleAccessible(header, this.completedExpanded, toggle);
    }
    header.setText(`${this.completedExpanded ? '▾' : '▸'} ${done.length} completed (${reached} reached)`);
    header.setAttribute('aria-expanded', String(this.completedExpanded));

    if (!this.completedExpanded) {
      el.querySelector(':scope > .sub-completed-filter')?.remove();
      el.querySelector(':scope > .sub-completed-rows')?.remove();
      return;
    }

    // Finding a specific finished run was the hard part: a hundred settled
    // dispatches, most of them look-alikes, rendered ten at a time with no way
    // to reach the other ninety. Filter over the whole set — by goal text, by
    // the activity that ran, by verdict ("not reached"), or by execution id —
    // and say honestly how many the list is showing out of how many matched.
    const q = this.completedFilter.trim().toLowerCase();
    const matches = q
      ? done.filter((d) => {
          const verdict = d.reached === true ? 'reached' : d.reached === false ? 'not reached' : 'unknown';
          return [
            dispatchLabel(d as { goal?: unknown }),
            String(d.selectedTemplateId ?? ''),
            String(d.executionId ?? ''),
            String(d.dispatchId ?? ''),
            String(d.status ?? ''),
            verdict,
          ].join(' ').toLowerCase().includes(q);
        })
      : done;

    let search = el.querySelector(':scope > .sub-completed-filter') as HTMLInputElement | null;
    if (!search) {
      search = el.createEl('input', {
        cls: 'sub-completed-filter',
        attr: { type: 'text', placeholder: 'Filter finished runs — goal, activity, "not reached", execution id…' },
      }) as HTMLInputElement;
      search.value = this.completedFilter;
      search.addEventListener('input', () => {
        this.completedFilter = search!.value;
        this.renderCompleted();
      });
      search.addEventListener('click', (ev) => ev.stopPropagation());
    }

    let rows = el.querySelector(':scope > .sub-completed-rows') as HTMLElement | null;
    if (!rows) rows = el.createDiv('sub-completed-rows');
    rows.empty();

    const LIMIT = 25;
    for (const d of matches.slice(0, LIMIT)) this.renderFleetRow(rows, d, false);
    if (matches.length === 0) {
      rows.createDiv({ cls: 'sub-fleet-empty', text: `Nothing matches “${this.completedFilter}”.` });
    } else if (matches.length > LIMIT) {
      // Never let a truncated list read as the whole list.
      rows.createDiv({
        cls: 'sub-fleet-note',
        text: `Showing ${LIMIT} of ${matches.length} matching runs — narrow the filter to see the rest.`,
      });
    }
  }

  private async expandFleetRow(row: HTMLElement, d: Record<string, unknown>): Promise<void> {
    const id = String(d.dispatchId ?? '');
    const existing = row.querySelector('.sub-fleet-detail');
    if (existing) {
      existing.remove();
      this.expandedDispatches.delete(id);
      this.autoExpandedRunning.add(id); // remember an explicit collapse
      return;
    }
    this.expandedDispatches.add(id);
    await this.renderFleetDetail(row, d);
  }

  /**
   * Section render guard (generalizes the pulse value-keyed fix): a section stops
   * el.empty()+recreating when its underlying VALUES are unchanged. Caller builds a
   * VALUE-KEYED snapshot (ids/counts/statuses — NEVER raw timestamped objects) and
   * calls this before teardown: returns true when unchanged (caller returns early,
   * live DOM — scroll, expansion — preserved), else records the snapshot and returns
   * false (caller rebuilds). Backed by the existing lastRenderedSnapshot store.
   */
  private sectionUnchanged(key: string, valueKey: string): boolean {
    if (this.lastRenderedSnapshot.get(key) === valueKey) return true;
    this.lastRenderedSnapshot.set(key, valueKey);
    return false;
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
    const dispatchId = String(d.dispatchId ?? '');
    const j = await this.goalHostResolve({ type: 'goalWalkState', dispatchId });
    let body = ((j?.body ?? {}) as Record<string, unknown>);
    // Fallback to the replicated trace store for settled rows when the walkState
    // resolve fails. The trace store is keyed by EXECUTION id, not dispatch id —
    // keying it by dispatchId (as this fallback originally did) can only ever
    // return "Execution trace not found", so the fallback could never fire and
    // the row still claimed it had loaded from the archive.
    const execForArchive = typeof d.executionId === 'string' && !d.executionId.startsWith('interrupted:')
      ? d.executionId : '';
    let archiveHit = false;
    if (j === null && execForArchive && String(d.status) !== 'running') {
      const t1 = await this.goalHostResolve({ type: 'activityExecutionTrace', executionId: execForArchive });
      const t2 = await this.goalHostResolve({ type: 'executionTrace', id: execForArchive });
      const traceFromArchive = t1?.body ?? t2?.body;
      // A not-found answer is an object too — only adopt a body that actually
      // carries walk content, so a miss never masquerades as a hit.
      if (traceFromArchive && typeof traceFromArchive === 'object' && !Array.isArray(traceFromArchive)
          && (traceFromArchive as Record<string, unknown>).success !== false) {
        body = traceFromArchive as Record<string, unknown>;
        archiveHit = true;
      }
    }
    // Stop the decision tree rebuilding every 7s on an UNCHANGED SETTLED walk (the
    // flicker/reset that loses scroll + expansion when reading a completed row).
    // Value-key the rendered-relevant walk values (never the raw timestamped body);
    // if a settled detail already exists and its key is unchanged, preserve it in
    // place. A RUNNING walk always rebuilds — its step tree is still growing.
    const status = String(body.status ?? d.status ?? '');
    const stepsArr = Array.isArray(body.steps) ? (body.steps as WalkStep[]) : [];
    const lastStep = stepsArr.length > 0 ? stepsArr[stepsArr.length - 1] : undefined;
    const detailKey = JSON.stringify({
      dispatchId, status,
      reached: d.reached ?? body.reached ?? null,
      stepN: stepsArr.length,
      lastStep: lastStep ? { i: lastStep.index, s: lastStep.status, t: lastStep.selected?.templateId } : null,
      answerLen: typeof body.answerBody === 'string' ? body.answerBody.trim().length : 0,
      logN: Array.isArray(body.walkLog) ? body.walkLog.length : 0,
      // Re-render when produced-content evidence arrives/changes (rides the poll)
      // without churning an unchanged settled row.
      evidenceLen: Array.isArray(body.poolProvenance)
        ? (body.poolProvenance as Array<Record<string, unknown>>).reduce((n, e) => n + (typeof e?.chars === 'number' ? e.chars : 0), 0)
        : 0,
    });
    const existing = row.querySelector('.sub-fleet-detail');
    if (existing && status !== 'running' && this.sectionUnchanged(`fleetDetail:${dispatchId}`, detailKey)) return;
    existing?.remove();
    const detail = row.createDiv('sub-fleet-detail');
    
    // Say where this detail came from — but only claim the archive when the
    // archive actually answered. When the live walk record is gone AND the
    // archive missed, that absence is the honest thing to report: the panel is
    // showing an empty row because the record is unrecoverable, not because the
    // walk did nothing.
    if (archiveHit) {
      detail.createDiv({
        cls: 'sub-provenance',
        text: 'Reconstructed from the trace archive — the live walk record for this dispatch has already been pruned.',
      });
    } else if (j === null && String(d.status) !== 'running') {
      detail.createDiv({
        cls: 'sub-provenance sub-provenance--missing',
        text: 'The walk record for this dispatch could not be retrieved, and the trace archive had no copy either. Nothing below is available for this row — this is a missing record, not an empty walk.',
      });
    }

    // 1. Reached-led headline (status demoted; failed-but-reached explained).
    this.renderReachHeadline(detail, body, d);

    // 1a. RESOLVED BY — which of the five mechanisms ran. This is the organising
    // fact of the whole view: it decides which evidence exists at all, so the
    // reader is told it before being shown anything. Everything below is gated
    // on it rather than rendered uniformly, which is what used to put a
    // "decision tree" under a resolve that never executed a step.
    const resolution = resolutionPath(body, d);
    // A dispatch still in flight has not resolved yet, so "how was this
    // resolved" has no answer — reporting it as `unrecorded` would flag every
    // running row as a defect. Show it once the run settles, or earlier if the
    // path is already determinable.
    const isRunning = String(body.status ?? d.status ?? '') === 'running';
    if (!isRunning || resolution.path !== 'unknown') {
      this.renderResolvedBy(detail, resolution, body, isRunning);
    }

    // 1b. Self-explanation — the four human questions in plain language, above
    // the technical decision tree: why THIS was chosen, what it means if it
    // failed, and what the substrate will do next. Assembled from the walkLog /
    // goalReachReason / learning the body already carries.
    this.renderSelfExplanation(detail, body, d);

    // 2. Authored answer (question-goals): show it prominently up top.
    const answerBody = typeof body.answerBody === 'string' ? body.answerBody.trim() : '';
    if (answerBody) this.renderInlineAnswer(detail, answerBody, answerGrounding(body), String(d.dispatchId ?? ''));

    // 2b. Evidence ledger — the actual CONTENT each shape produced, so a human can
    // judge whether the goal reached against real evidence (works for FAILED walks
    // too, where no answerBody exists). Verdict-NEUTRAL: seeing content must not imply
    // reach; the human grades the grader FROM this.
    this.renderEvidenceLedger(detail, body, d);

    // 3. The path-specific body — exactly ONE of these, chosen by how the goal
    // was actually resolved. A decision tree only describes a shape-graph walk;
    // showing it for a direct edit or a satisfier resolve invents deliberation
    // that never happened.
    const steps = Array.isArray(body.steps) ? (body.steps as WalkStep[]) : [];
    if (resolution.path === 'feature_compose') {
      this.renderEditBody(detail, body, d);
    } else if (resolution.path === 'satisfier') {
      this.renderSatisfierBody(detail, body, steps);
    } else if (steps.length > 0) {
      const producers = new Map<string, string>();
        for (const ev of (Array.isArray(body.poolEvents) ? body.poolEvents : []) as Array<{ shape: string; source: string }>) {
          if (ev && ev.shape && ev.source && !producers.has(ev.shape)) producers.set(ev.shape, ev.source);
        }
        this.renderDecisionTree(detail, steps, producers, String(d.dispatchId ?? ''), (Array.isArray(body.walkLog) ? body.walkLog : []).map(String), typeof body.grounded === 'boolean' ? body.grounded : undefined);
    } else {
      this.renderWalkFallback(detail, body);
    }

    // 3b. Verdict derivation — the audit chain from "what was asked for" to
    // "therefore reached / not reached". This is the block a human grades the
    // grader FROM, so it renders for every settled walk, including (especially)
    // the ones that produced nothing: an empty walk still has a why.
    const derivStatus = String(body.status ?? d.status ?? '');
    if (derivStatus !== 'running') this.renderVerdictDerivation(detail, body, d);

    // 4. Learning consequence line (terminal only, when present).
    const learning = (body.learning ?? null) as WalkLearning | null;
    if (derivStatus !== 'running') this.renderLearningLine(detail, learning);
    // 4b. "What it should run next" — the next-selection aggregator's judged
    // sentence for settled executions (dispatched once per execution, cached).
    const settledStatus = String(body.status ?? d.status ?? '');
    if (steps.length > 0 && settledStatus !== 'running') this.renderContribBar(detail, steps);
    const execForNext = typeof d.executionId === 'string' && !d.executionId.startsWith('interrupted:') ? d.executionId : (typeof body.executionId === 'string' ? body.executionId : '');
    if (execForNext && settledStatus !== 'running') {
      this.renderNextSelection(detail, execForNext);
      this.renderGradePanel(detail, execForNext, body, d);
    }

    // 5. Attach to live WS feed.
    const execId = typeof d.executionId === 'string' && !d.executionId.startsWith('interrupted:') ? d.executionId : null;
    if (execId) {
      const attachBtn = detail.createEl('button', { cls: 'sub-fleet-btn', text: 'attach' });
      attachBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.activeDispatchId = String(d.dispatchId ?? '');
        this.activeExecutionId = execId;
        this.renderedStepCount = 0;
        this.answerRendered = false;
        this.startWalkPoll();
        this.appendMessage(`⇢ attached to dispatch ${String(d.dispatchId ?? '').slice(0, 8)} (execution ${execId.slice(0, 12)}…)`);
      });
    }
  }

  /**
   * Render the next-selection aggregator's verdict — what this execution
   * should run next — as a sentence. Dispatches the composed aggregator once
   * per execution (session-cached, single-flight); re-renders when it settles.
   */
  private renderNextSelection(parent: HTMLElement, executionId: string): void {
    const box = parent.createDiv('sub-next');
    box.createDiv({ cls: 'sub-next-label', text: 'What it should run next' });
    const hit = cachedNextSelection(executionId);
    if (hit) {
      box.createDiv({ cls: 'sub-next-rec', text: hit.sentence });
      return;
    }
    const pending = box.createDiv({ cls: 'sub-next-pending', text: 'asking the substrate…' });
    void requestNextSelection(executionId).then((v) => {
      if (!v || !v.sentence) {
        pending.setText('no recommendation came back — the aggregator dispatch did not settle');
        return;
      }
      pending.remove();
      box.createDiv({ cls: 'sub-next-rec', text: v.sentence });
    });
  }

  /**
   * Render a one-click operator verdict control for settled executions.
   * Shows "Was this reached?" label and three verdict buttons.
   */
  /**
   * Grade-the-grader panel (REACH dimension). Sits below the evidence ledger so the
   * human grades the verdict FROM the produced content. Anti-rubber-stamp: it states
   * the grader's claim + WHY (goalReachReason), pre-selects NOTHING, and requires
   * directed notes to override — a human override actually corrects record.reached
   * server-side (goal-host consumes verdict+notes), it is not a dead label.
   */
  private renderGradePanel(parent: HTMLElement, executionId: string, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const prov = Array.isArray(body.poolProvenance) ? body.poolProvenance : [];
    const answerBody = typeof body.answerBody === 'string' ? body.answerBody.trim() : '';
    // A row with no produced content used to be refused a grade surface, on the
    // theory that there was nothing to judge. That was backwards: an empty
    // hollow row is exactly where a human verdict carries the most ground truth,
    // because the automatic grader had nothing to grade either and the run
    // taught the loop nothing. submitVerdict already supports these rows (it
    // falls back to the executionId when no template is bound). So the surface
    // renders for every settled row; when there is no produced content we say so
    // and tell the human what their verdict actually corrects.
    const thin = prov.length === 0 && !answerBody;
    const graderReached = (d.reached ?? body.reached ?? null) as boolean | null;
    const humanGraded = body.humanGraded === true;
    const reason = typeof body.goalReachReason === 'string' ? body.goalReachReason : '';
    const wrap = parent.createDiv('sub-grade');

    const reachCard = wrap.createDiv('sub-grade-card sub-grade-reach');
    const rTxt = graderReached === true ? 'yes' : graderReached === false ? 'no' : 'unknown';
    reachCard.createDiv({ cls: 'sub-grade-head', text: `Your verdict — the grader said reached = ${rTxt}` });
    if (reason) reachCard.createDiv({ cls: 'sub-grade-reason', text: `because: ${reason}` });
    reachCard.createDiv({
      cls: 'sub-grade-why',
      text: thin
        ? 'This run produced nothing, so the automatic grader had no content to judge and the learning loop recorded no lesson from it. Your verdict is the only ground truth this execution will ever carry: it writes an oracle label the future grader is measured against, and it corrects record.reached.'
        : 'Judge the verdict against the evidence above, not against the status. Your answer writes an oracle label that the automatic grader is later scored on, and corrects record.reached for this execution.',
    });
    if (humanGraded) {
      const hn = typeof body.humanReachNotes === 'string' && body.humanReachNotes ? `: “${body.humanReachNotes}”` : '';
      reachCard.createDiv({ cls: 'sub-grade-human', text: `✓ you graded this${hn}` });
    }
    const notesEl = reachCard.createEl('textarea', { cls: 'sub-grade-notes', attr: { placeholder: 'directed feedback (required to override / partial)…', rows: '2' } });
    const btnRow = reachCard.createDiv('sub-grade-btns');
    const mk = (label: string, verdict: 'achieved' | 'not_achieved' | 'partial', requireNotes: boolean) => {
      const b = btnRow.createEl('button', { cls: 'sub-fleet-btn', text: label });
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const notes = notesEl.value.trim();
        if (requireNotes && !notes) { notesEl.addClass('sub-grade-notes--need'); notesEl.focus(); return; }
        void this.submitVerdict(executionId, d, verdict, notes, btnRow);
      });
    };
    mk('confirm reached', 'achieved', false);
    mk('override → not reached', 'not_achieved', true);
    mk('partial', 'partial', true);
  }

  /**
   * Submit an operator verdict for an execution and replace buttons with confirmation.
   */
  private async submitVerdict(executionId: string, d: Record<string, unknown>, verdict: 'achieved' | 'not_achieved' | 'partial', notes?: string, btnRow?: HTMLElement): Promise<void> {
    const goal = typeof d.goal === 'string' ? d.goal : `goal for execution ${executionId}`;
    // Fall back to the executionId when no template is bound (failed/satisfier
    // rows) so the oracle label still records — that is exactly where a
    // "not reached" verdict is the most valuable ground-truth signal.
    const activityId = (typeof d.selectedTemplateId === 'string' && d.selectedTemplateId) ? String(d.selectedTemplateId) : executionId;

    const pointer = {
      type: 'goal_verification_label_write' as const,
      goal,
      execution_id: executionId,
      activity_id: activityId,
      verdict,
      confidence: 0.9,
      labeler: 'human',
      notes: (typeof notes === 'string' && notes) ? notes : `human verdict: ${verdict}`,
    };

    attentionGrader.verdictSubmitted(String(d.dispatchId ?? ''));
    const body = await sidecarResolveBody(pointer);

    // Local restamp so the collapsed row verdict + the value-keyed detailKey reflect
    // the human verdict immediately (goal-host also corrects record.reached on the
    // next poll — this just avoids a visible lag). A 'partial' clears to unknown.
    if (body != null) {
      d.reached = verdict === 'achieved' ? true : verdict === 'not_achieved' ? false : null;
      (d as Record<string, unknown>).humanGraded = true;
    }

    const host = btnRow ?? (document.querySelector('.sub-grade-btns') as HTMLElement | null);
    if (host) {
      const btns = host.querySelectorAll('.sub-fleet-btn');
      for (const b of Array.from(btns)) b.remove();
      host.createDiv({
        cls: 'sub-verdict-confirm',
        text: body != null ? `recorded — reach set to ${verdict} (human)` : 'not recorded — sidecar unavailable',
      });
    }
  }

  /**
   * Pool contribution summary for a settled execution: a diverging bar
   * (grew / carried / consumed) plus the same fact as a sentence, computed
   * from the first poolBefore to the last poolAfter across the walk steps.
   */
  private renderContribBar(parent: HTMLElement, steps: WalkStep[]): void {
    const first = steps.find((s) => Array.isArray(s.poolBefore));
    const last = [...steps].reverse().find((s) => Array.isArray(s.poolAfter));
    const before = (first?.poolBefore ?? []) as string[];
    const after = (last?.poolAfter ?? []) as string[];
    if (before.length === 0 && after.length === 0) return;
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const grew = after.filter((s) => !beforeSet.has(s)).length;
    const consumed = before.filter((s) => !afterSet.has(s)).length;
    const kept = after.length - grew;
    const total = Math.max(grew + consumed + kept, 1);
    const wrap = parent.createDiv('sub-contrib');
    wrap.createDiv({ cls: 'sub-next-label', text: 'What it did to the shape pool' });
    const bar = wrap.createDiv('sub-contrib-bar');
    const seg = (cls: string, n: number): void => {
      if (n <= 0) return;
      const s = bar.createSpan({ cls: `sub-contrib-seg ${cls}` });
      s.style.width = `${Math.round((n / total) * 100)}%`;
    };
    seg('is-grow', grew);
    seg('is-keep', kept);
    seg('is-cut', consumed);
    const legend = wrap.createDiv('sub-contrib-legend');
    if (grew > 0) legend.createSpan({ text: `grew +${grew}` });
    if (kept > 0) legend.createSpan({ text: `carried ${kept}` });
    if (consumed > 0) legend.createSpan({ text: `consumed ${consumed}` });
    const sentence = poolDeltaSentence(before, after);
    if (sentence) wrap.createDiv({ cls: 'sub-pool-sentence', text: sentence });
  }

  /**
   * Reached-led headline: verdict pill + one-line rationale. `status` is shown
   * only as a small secondary chip; when status=failed but reached=true a single
   * explanatory line replaces the misleading "failed" lead.
   */
  /**
   * The plain-language self-explanation block for an expanded dispatch. The
   * substrate is a mix of mechanisms (walk, Thompson selection, reach-gate,
   * gap-filer) but every decision is recorded — this reads that record back as
   * the four questions a human actually asks: why this, what it means, what next.
   * why-chosen shows always (context); meaning + disposition only on a non-reach,
   * where the obscurity bites. The decision tree below is the "show your work".
   */
  private renderSelfExplanation(parent: HTMLElement, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const walkLog = Array.isArray(body.walkLog) ? (body.walkLog as unknown[]).map(String) : [];
    const reached = (body.reached ?? d.reached) as boolean | null | undefined;
    const reason = typeof body.goalReachReason === 'string' ? body.goalReachReason : '';
    const learning = (body.learning ?? null) as { gapsFiled?: unknown } | null;
    const requeueOf = (body.requeueOf ?? d.requeueOf);
    const trg = { trigger: body.trigger ?? d.trigger, operator: body.operator ?? d.operator };

    const box = parent.createDiv('sub-explain');

    // WHY-CHOSEN — always shown; carries the purpose (which trigger / operator).
    const why = whyChosenSentence(trg, walkLog);
    if (why) {
      const row = box.createDiv('sub-explain-row');
      row.createSpan({ cls: 'sub-explain-q', text: 'Why this' });
      row.createSpan({ cls: 'sub-explain-a', text: why });
    }

    // WHAT-IT-MEANS — only on a non-reach.
    const meaning = failureMeaningSentence(reached, reason, walkLog);
    if (meaning) {
      const row = box.createDiv('sub-explain-row sub-explain-row--warn');
      row.createSpan({ cls: 'sub-explain-q', text: 'What it means' });
      row.createSpan({ cls: 'sub-explain-a', text: meaning });
    }

    // WHAT-NEXT — the disposition; gaps rendered as clickable links.
    const disp = dispositionSentence(reached, learning, requeueOf, walkLog);
    if (disp.text) {
      const row = box.createDiv('sub-explain-row sub-explain-row--next');
      row.createSpan({ cls: 'sub-explain-q', text: 'What happens now' });
      const a = row.createSpan({ cls: 'sub-explain-a', text: disp.text });
      if (disp.gaps.length > 0) {
        a.appendText(' ');
        disp.gaps.forEach((g, i) => {
          if (i > 0) a.appendText(', ');
          const link = a.createEl('a', { cls: 'sub-gap-link', text: g });
          link.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.app.workspace.openLinkText(g, '', false);
          });
        });
      }
    }

    if (box.childElementCount === 0) box.remove();
  }

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
    // Walk-level trust chips (from goalWalkState.grounded / walkTier). grounded is
    // the honest tool-anchored-vs-bare-LLM verdict; walkTier is how the walk
    // resolved (learned reuse vs fresh derivation).
    const grounded = typeof body.grounded === 'boolean' ? (body.grounded as boolean) : undefined;
    if (!running && grounded !== undefined && (reached === true || grounded === true)) {
      head.createSpan({
        cls: `sub-chip ${grounded ? 'sub-chip--ok' : 'sub-chip--warn'}`,
        text: grounded ? 'tool-grounded' : 'not tool-grounded',
        attr: { title: grounded
          ? 'the reach was anchored in an executed tool / landed edit / real producer→consumer edge — not a bare LLM answer'
          : 'no executed-tool anchor — the value may be LLM-interpolated / unverified' },
      });
    }
    const walkTier = typeof body.walkTier === 'string' ? (body.walkTier as string) : '';
    if (!running && walkTier) {
      const tierPhrase = ({
        learned_pathway: 'reused learned pathway',
        satisfier: 'direct tool resolve',
        universal_tool_fallback: 'raw tool loop',
        feature_compose: 'code edit',
        fresh_derivation: 'fresh derivation',
      } as Record<string, string>)[walkTier] ?? walkTier.replace(/_/g, ' ');
      // 'via' marks the resolution MECHANISM — a distinct dimension from the
      // grounded chip's honest-reach QUALITY verdict, so they don't read as duplicative.
      head.createSpan({ cls: 'sub-chip', text: `via ${tierPhrase}`, attr: { title: `reuse tier: ${walkTier} — how the walk resolved (learned reuse vs fresh derivation)` } });
    }
    // The reach reason belongs on a REACHED walk. On a non-reach the "What it
    // means" row (renderSelfExplanation) owns the reason; while running there is
    // no reason yet. Gating here avoids a duplicate row and a premature rationale.
    if (!running && reached === true) {
      const rationale = extractReachRationale(body);
      if (rationale) {
        parent.createDiv({ cls: 'sub-reach-rationale', text: rationale, attr: { title: rationale } });
      }
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
  private renderInlineAnswer(parent: HTMLElement, answer: string, grounding: 'grounded' | 'unverified' = 'unverified', dispatchId = ''): void {
    const card = parent.createDiv('sub-card sub-card--answer sub-answer-inline');
    const inner = card.createDiv('sub-answer-body');
    const header = inner.createDiv({ cls: 'sub-answer-header', text: '◇ Answer' });
    header.createSpan({
      cls: `sub-answer-badge sub-answer-badge--${grounding}`,
      text: grounding === 'grounded' ? '● grounded' : '○ unverified — no tool anchor',
    });
    this.renderAnswerViaArm(card, inner, answer, grounding, dispatchId);
  }

  /**
   * Shared answer-body render: route through the Thompson-selected
   * presentation arm and attach the attention grader. One decision and one
   * episode per dispatch — the feed block and the fleet-row inline card merge
   * their dwell/affordance signals. A 'fallback' decision (no selection was
   * made through the policy) still renders arm A but is NEVER graded.
   */
  private renderAnswerViaArm(card: HTMLElement, inner: HTMLElement, answer: string, grounding: 'grounded' | 'unverified', dispatchId: string): void {
    try {
      this.renderAnswerViaArmInner(card, inner, answer, grounding, dispatchId);
    } catch (err) {
      // The answer must NEVER be lost to a presentation-loop bug: fall back to
      // the plain markdown render and surface the error in the feed.
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.appendMessage(`presentation-arm render failed — fell back to plain: ${msg.slice(0, 300)}`, 'failure');
      const textEl = inner.createDiv({ cls: 'sub-answer-text' });
      void MarkdownRenderer.render(this.plugin.app, answer, textEl, '/', this);
    }
  }

  private renderAnswerViaArmInner(card: HTMLElement, inner: HTMLElement, answer: string, grounding: 'grounded' | 'unverified', dispatchId: string): void {
    const decision = peekPresentationArm(dispatchId);
    card.dataset.presentationArm = decision.armKey;
    card.dataset.selectionSource = decision.source;
    const header = inner.querySelector(':scope > .sub-answer-header') as HTMLElement | null;
    if (header && dispatchId) {
      const dismiss = header.createSpan({ cls: 'sub-answer-dismiss', text: '×', attr: { title: 'dismiss this answer' } });
      dismiss.addEventListener('click', (ev) => {
        if (!ev.isTrusted) return;
        attentionGrader.dismiss(dispatchId);
        card.addClass('sub-answer--dismissed');
      });
    }
    renderArmBody(this.plugin.app, this, inner, decision.armKey, answer, grounding, {
      armEvent: (kind) => attentionGrader.armEvent(dispatchId, kind),
    });
    if (dispatchId) {
      attentionGrader.attach(card, dispatchId, decision, grounding, this.plugin.app.vault.getName(), answer);
    }
  }

  /**
   * Tier-2 live shape-flow mini-DAG. A compact left-to-right layered diagram
   * of the current walk: one producer node per step (coloured by source /
   * failure), the shapes it added to the pool branching below it, and a spine
   * edge to the next step. Deterministic layout by step index — NO force
   * simulation — so it is cheap and never jitters. Paint is inline (existing
   * CSS vars) and entry animation is the Web Animations API gated on
   * prefers-reduced-motion, so the feature is fully live after a JS-only
   * plugin reload (Obsidian does not re-read styles.css on reload).
   */
  private renderShapeFlow(parent: HTMLElement, steps: WalkStep[], dispatchId: string, walkLog: string[] = [], walkGrounded?: boolean): void {
    if (!steps.length) return;
    const grounded = groundedShapeSet(walkLog);
    const confidence = walkConfidence(walkLog);
    const NS = 'http://www.w3.org/2000/svg';
    const COL_W = 112, NODE_W = 96, NODE_H = 20, PILL_H = 15, GAP = 5, TOP = 6, PAD = 8, MAX_COLS = 14, LABEL = 13;
    const shown = steps.slice(0, MAX_COLS);
    const perStep = shown.map((s) => (Array.isArray(s.newShapes) ? s.newShapes : []).slice(0, 4));
    const maxShapes = Math.max(0, ...perStep.map((a) => a.length));
    const width = PAD * 2 + shown.length * COL_W;
    const height = TOP + NODE_H + (maxShapes > 0 ? GAP + maxShapes * (PILL_H + GAP) : 0) + PAD;

    const wrap = parent.createDiv('sub-flow');
    const hdr = wrap.createDiv({ cls: 'sub-section-header', text: 'Shape flow' });
    // Confidence is one dispatch-level scalar — rendered ONCE here, never per node.
    if (confidence) {
      const c = hdr.createSpan({ text: ` · goal understood ${(confidence.conf * 100).toFixed(0)}%` });
      c.style.setProperty('opacity', '0.65');
      c.style.setProperty('font-weight', 'normal');
      c.setAttr('title', `how sure the system was it read the whole goal right (${(confidence.conf * 100).toFixed(0)}%) — one value for the whole walk, not per step. It aimed at ${confidence.targets.join(', ') || '(none)'}${confidence.alts.length ? `; runner-up readings: ${confidence.alts.join(', ')}` : ''}`);
    }
    const scroll = wrap.createDiv();
    scroll.style.overflowX = 'auto';
    scroll.style.paddingBottom = '2px';

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.display = 'block';
    scroll.appendChild(svg);

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
    const seen = this.animatedFlowSteps.get(dispatchId) ?? -1;
    let maxIdx = seen;

    const geom = (tag: string, attrs: Record<string, string | number>): SVGElement => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, String(attrs[k]));
      return e;
    };
    const paint = (el: SVGElement, styles: Record<string, string>): void => {
      for (const k in styles) el.style.setProperty(k, styles[k]);
    };
    const title = (el: SVGElement, text: string): void => {
      const t = document.createElementNS(NS, 'title'); t.textContent = text; el.appendChild(t);
    };
    const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);
    const colorFor = (source: string | undefined, status: string | undefined): string => {
      if (status && !/complete|success|reached|ok/i.test(status)) return 'var(--sub-warn)';
      switch (source) {
        case 'satisfier': return 'var(--sub-ok)';
        case 'thompson': return 'var(--sub-info)';
        case 'recovery': return 'var(--color-purple, var(--sub-info))';
        default: return 'var(--sub-text-muted)';
      }
    };
    const fadeIn = (el: SVGElement, delay: number, endOpacity = 1): void => {
      if (reduce) return;
      el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: endOpacity, transform: 'translateY(0)' }],
        { duration: 180, delay, easing: 'ease-out', fill: 'backwards' });
    };
    const drawEdge = (el: SVGElement, len: number, delay: number): void => {
      if (reduce) return;
      el.style.strokeDasharray = String(len);
      el.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: 200, delay, easing: 'ease-out', fill: 'backwards' });
    };

    shown.forEach((step, i) => {
      const sel = step.selected ?? {};
      const cx = PAD + i * COL_W;
      const midY = TOP + NODE_H / 2;
      const isNew = i > seen;
      if (i > maxIdx) maxIdx = i;
      const stagger = isNew ? (i - seen) * 55 : 0;
      const color = colorFor(sel.source, step.status);

      // Spine edge to the next producer.
      if (i < shown.length - 1) {
        const x1 = cx + NODE_W, x2 = PAD + (i + 1) * COL_W;
        const line = geom('line', { x1, y1: midY, x2, y2: midY });
        paint(line, { stroke: 'var(--sub-border)', 'stroke-width': '1.5' });
        svg.appendChild(line);
        if (isNew) drawEdge(line, x2 - x1, stagger);
      }

      // Producer node. Two non-colour trust channels ride on marks already drawn:
      //   usefulness → stroke WIDTH (fat = earned posterior); colour stays source/status.
      //   grounding  → node OPACITY (dim = hollow/ungrounded, faint dim = unconfirmed).
      const col = document.createElementNS(NS, 'g');
      svg.appendChild(col);
      const reach = reachOf(sel);
      // Per-step MECHANISM (did THIS step run a tool / produce a shape) — a
      // within-walk detail distinct from the walk-level 'tool-grounded' verdict.
      // When the whole walk is authoritatively grounded, an 'unconfirmed' step
      // still fed a grounded reach, so don't dim it as suspicious.
      const grounding = stepGrounding(step, grounded);
      const nodeOpacity = grounding === 'hollow' ? 0.5 : (grounding === 'unconfirmed' && walkGrounded !== true) ? 0.8 : 1;
      col.style.setProperty('opacity', String(nodeOpacity));
      const rect = geom('rect', { x: cx, y: TOP, width: NODE_W, height: NODE_H, rx: 5 });
      paint(rect, { fill: 'var(--sub-bg-card)', stroke: color, 'stroke-width': '1.4' });
      col.appendChild(rect);
      const label = sel.templateId ? shortId(sel.templateId) : sourceLabel(sel.source);
      const txt = geom('text', { x: cx + NODE_W / 2, y: midY + 2, 'text-anchor': 'middle', 'font-size': 10 });
      paint(txt, { fill: 'var(--sub-text)', 'font-family': 'var(--font-monospace, monospace)' });
      // Keep the distinctive tail (the produced shape) instead of dropping it.
      txt.textContent = label.length > LABEL ? '…' + label.slice(-(LABEL - 1)) : label;
      col.appendChild(txt);
      // Track-record bar (absolute: faint track = 100%, fill = reach rate). Reads
      // on a single node, unlike a relative stroke-width. Absent = no posterior yet.
      if (reach) {
        const barY = TOP + NODE_H - 4, barX = cx + 3, barW = NODE_W - 6;
        const track = geom('rect', { x: barX, y: barY, width: barW, height: 2, rx: 1 });
        paint(track, { fill: 'var(--sub-text-muted)', opacity: '0.25' });
        col.appendChild(track);
        const fill = geom('rect', { x: barX, y: barY, width: Math.max(1.5, reach.rate * barW), height: 2, rx: 1 });
        paint(fill, { fill: color, opacity: '0.9' });
        col.appendChild(fill);
      }
      const groundWord = grounding === 'grounded' ? 'ran a tool (vessel resolve)' : grounding === 'hollow' ? 'produced nothing' : 'produced a shape (no tool trace)';
      title(rect, `${sel.templateId ?? sourceLabel(sel.source)} · ${reuseClass(sel)}${reach ? ` · reach ${(reach.rate * 100).toFixed(0)}% over ${reach.mass.toFixed(0)} obs` : ''} · ${groundWord}${step.status ? ` · ${step.status}` : ''}`);
      if (isNew) fadeIn(col, stagger, nodeOpacity);

      // Shapes this step added to the pool, branching below the producer.
      perStep[i].forEach((sh, j) => {
        const py = TOP + NODE_H + GAP + j * (PILL_H + GAP);
        const bx1 = cx + NODE_W / 2, by1 = TOP + NODE_H, bx2 = cx + 9, by2 = py + PILL_H / 2;
        const my = (by1 + by2) / 2;
        const edge = geom('path', { d: `M ${bx1} ${by1} C ${bx1} ${my}, ${bx2} ${my}, ${bx2} ${by2}`, fill: 'none' });
        paint(edge, { stroke: 'var(--sub-ok)', 'stroke-width': '1.2', opacity: '0.5' });
        svg.appendChild(edge);
        const g2 = document.createElementNS(NS, 'g');
        svg.appendChild(g2);
        const pill = geom('rect', { x: cx, y: py, width: NODE_W, height: PILL_H, rx: 7 });
        paint(pill, { fill: 'color-mix(in srgb, var(--sub-ok) 12%, transparent)', stroke: 'var(--sub-ok)', 'stroke-width': '1' });
        g2.appendChild(pill);
        const ptxt = geom('text', { x: cx + NODE_W / 2, y: py + PILL_H / 2 + 3, 'text-anchor': 'middle', 'font-size': 9 });
        paint(ptxt, { fill: 'var(--sub-ok)', 'font-family': 'var(--font-monospace, monospace)' });
        ptxt.textContent = clip(sh, LABEL + 1);
        g2.appendChild(ptxt);
        title(pill, sh);
        if (isNew) { drawEdge(edge, 42, stagger + 40); fadeIn(g2, stagger + 55 + j * 25); }
      });
    });

    wrap.createDiv({ cls: 'sub-step-shadowline', text: 'per step: bottom bar = track record (fuller = more proven) · faded = produced nothing · hover for detail. Overall grounding is the headline chip.' });
    if (steps.length > MAX_COLS) {
      wrap.createDiv({ cls: 'sub-step-shadowline', text: `+${steps.length - MAX_COLS} more step(s) — see the decision tree below` });
    }
    this.animatedFlowSteps.set(dispatchId, maxIdx);
  }

  /**
   * Full decision tree: one node per walk step, with the shape-pool delta
   * rendered between consecutive steps. Each node shows the selected template
   * (source badge + α/β or sampled score), a collapsed list of alternatives
   * considered, exclusions with reasons, and step status + rationale prose.
   * Shadow / recovery steps are visually distinct.
   */
  private renderDecisionTree(parent: HTMLElement, steps: WalkStep[], producers: Map<string, string>, dispatchId = '', walkLog: string[] = [], walkGrounded?: boolean): void {
    // Tier-2: live shape-flow mini-DAG above the detailed step list.
    this.renderShapeFlow(parent, steps, dispatchId, walkLog, walkGrounded);
    const tree = parent.createDiv('sub-tree');
    tree.createDiv({ cls: 'sub-section-header', text: `Decision tree — ${steps.length} step${steps.length === 1 ? '' : 's'}` });
    let prevPool: string[] | null = null;
    steps.forEach((step, i) => {
      // Pool delta going INTO this step (poolAfter[prev] → poolBefore[this]).
      const before = Array.isArray(step.poolBefore) ? step.poolBefore : (prevPool ?? []);
      this.renderStepNode(tree, step, i);
      const after = Array.isArray(step.poolAfter) ? step.poolAfter : before;
      this.renderPoolDelta(
        tree,
        before,
        after,
        Array.isArray(step.newShapes) ? step.newShapes : undefined,
        producers,
      );
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
    const rr = reachOf(sel);
    if (rr) header.createSpan({ cls: 'sub-step-score', text: `reach ${(rr.rate * 100).toFixed(0)}%`, attr: { title: `earned reach rate α/(α+β) over ${rr.mass.toFixed(0)} observations` } });
    header.createSpan({ cls: 'sub-step-score', text: `· ${reuseClass(sel)}`, attr: { title: 'reusability (heuristic: source + template-id prefix)' } });
    if (shadow) header.createSpan({ cls: 'sub-badge sub-badge--shadow', text: 'shadow' });
    if (step.status) {
      const ok = /complete|success|reached|ok/i.test(step.status);
      header.createSpan({ cls: `sub-chip ${ok ? 'sub-chip--ok' : 'sub-chip--warn'} sub-step-status`, text: step.status });
    }

    // Narrative why-line: the posterior stated as evidence a person acts on,
    // with the strongest held-back rival inline as the counterfactual.
    const rivalsAll = (Array.isArray(step.candidates) ? step.candidates : []).filter((c) => c.templateId && c.templateId !== sel.templateId);
    node.createDiv({ cls: 'sub-step-why', text: posteriorSentence(sel, rivalsAll.length) });
    const topRival = [...rivalsAll].sort((a, b) => (b.sampledScore ?? 0) - (a.sampledScore ?? 0))[0];
    if (topRival) {
      node.createDiv({ cls: 'sub-step-shadowline', text: shadowSentence({ templateId: topRival.templateId ? shortId(topRival.templateId) : undefined, alpha: topRival.alpha, beta: topRival.beta, rejectedBecause: topRival.rejectedBecause }) });
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
  private renderPoolDelta(parent: HTMLElement, before: string[], after: string[], newShapes?: string[], producers?: Map<string, string>): void {
    const beforeSet = new Set(before);
    const added = (Array.isArray(newShapes) && newShapes.length > 0)
      ? newShapes
      : after.filter((s) => !beforeSet.has(s));
    if (after.length === 0 && added.length === 0) return;
    const wrap = parent.createDiv('sub-pool-delta');
    // Contribution stated as a sentence; the chips remain as annotations.
    const sentence = poolDeltaSentence(before, after);
    if (sentence) wrap.createDiv({ cls: 'sub-pool-sentence', text: sentence });
    const chipTitle = (shape: string): string => { const p = producers?.get(shape); return p ? shape + ' — produced by ' + p : shape; };
    if (added.length > 0) {
      const chips = wrap.createDiv('sub-fleet-chips');
      chips.createSpan({ cls: 'sub-pool-arrow', text: '+' });
      for (const s of added) {
        chips.createSpan({ cls: 'sub-chip sub-chip--new', text: s, attr: { title: chipTitle(s) } });
      }
    }
    if (after.length > 0) {
      this.renderCollapsible(wrap, `pool: ${after.length} shape${after.length === 1 ? '' : 's'}`, (host) => {
        const chips = host.createDiv('sub-fleet-chips');
        for (const s of after) {
          const isNew = added.includes(s);
          chips.createSpan({ cls: `sub-chip${isNew ? ' sub-chip--new' : ''}`, text: s, attr: { title: chipTitle(s) } });
        }
      });
    }
  }

  /**
   * Learning consequence line: "taught: Δα/β on <template>, oracle label
   * written, gap filed: <id>". Gap ids wikilink only when a note exists
   * (materialize-or-omit — never a dead link).
   */
  /**
   * "Resolved by" — names which of the five mechanisms ran, in prose, and says
   * what taking that path means. Rendered directly under the verdict because it
   * tells the reader which evidence to expect below (and which not to look for).
   */
  private renderResolvedBy(
    parent: HTMLElement,
    resolution: { path: ResolutionPath; basis: 'stated' | 'inferred'; evidence: string },
    body: Record<string, unknown>,
    isRunning = false,
  ): void {
    const wrap = parent.createDiv(`sub-resolvedby is-${resolution.path.replace(/_/g, '-')}`);
    const head = wrap.createDiv('sub-resolvedby-head');
    head.createSpan({ cls: 'sub-resolvedby-label', text: isRunning ? 'Resolving by' : 'Resolved by' });
    head.createSpan({ cls: 'sub-resolvedby-name', text: resolvedByLabel(resolution.path) });
    if (resolution.basis === 'inferred') {
      // Never present a guess as a fact: an unattributed run is a finding.
      head.createSpan({
        cls: 'sub-chip sub-chip--warn',
        text: 'inferred',
        attr: { title: `goal-host did not record how this ran. Worked out here from: ${resolution.evidence}.` },
      });
    }
    wrap.createDiv({ cls: 'sub-resolvedby-text', text: resolvedBySentence(resolution, body) });
  }

  /**
   * Direct-edit body: what the drafter actually did to the tree. The diff is not
   * on the record, so we show what IS there — the commit, whether it landed, and
   * the verifier's own words — and say plainly that the diff is not available
   * rather than implying this is the whole story.
   */
  private renderEditBody(parent: HTMLElement, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const wrap = parent.createDiv('sub-pathbody sub-pathbody--edit');
    wrap.createDiv({ cls: 'sub-section-header', text: 'The edit' });
    const outcome = featureComposeOutcome(String(body.executionId ?? d.executionId ?? ''));
    const row = wrap.createDiv('sub-pathbody-row');
    if (outcome?.landed && outcome.sha) {
      row.createSpan({ cls: 'sub-chip sub-chip--ok', text: 'landed' });
      row.createSpan({ cls: 'sub-mono', text: outcome.sha.slice(0, 12), attr: { title: `commit ${outcome.sha}` } });
    } else if (outcome) {
      row.createSpan({ cls: 'sub-chip sub-chip--warn', text: 'not landed' });
      if (outcome.rejectedTag) {
        row.createSpan({ cls: 'sub-mono', text: outcome.rejectedTag, attr: { title: 'the drafter refused or the verify gate rejected this edit' } });
      }
    } else {
      row.createSpan({ cls: 'sub-chip sub-chip--warn', text: 'outcome not recorded' });
    }
    const reason = typeof body.goalReachReason === 'string' ? body.goalReachReason : '';
    if (reason) wrap.createDiv({ cls: 'sub-pathbody-text', text: reason });
    wrap.createDiv({
      cls: 'sub-pathbody-note',
      text: outcome?.landed
        ? 'The diff itself is not carried on the dispatch record, so it cannot be shown here — read the commit to see what changed.'
        : 'The diff is not carried on the dispatch record, and nothing was committed, so there is no artefact to read: what the drafter proposed was not retained anywhere.',
    });
  }

  /**
   * Satisfier body: there is no deliberation to show. Say which shape a
   * connected vessel answered with, and say explicitly that nothing ran, rather
   * than rendering an empty tree that implies a choice was made.
   */
  private renderSatisfierBody(parent: HTMLElement, body: Record<string, unknown>, steps: WalkStep[]): void {
    const wrap = parent.createDiv('sub-pathbody sub-pathbody--satisfier');
    wrap.createDiv({ cls: 'sub-section-header', text: 'What answered it' });
    const pool = (Array.isArray(body.poolShapes) ? body.poolShapes : []) as string[];
    const shapes = steps
      .map((s) => String((s.selected as { templateId?: string } | undefined)?.templateId ?? ''))
      .filter((t) => t.startsWith('satisfier:'))
      .map((t) => t.slice('satisfier:'.length));
    const named = shapes.length ? shapes : pool;
    if (named.length) {
      const chips = wrap.createDiv('sub-fleet-chips');
      for (const sh of named) chips.createSpan({ cls: 'sub-chip sub-chip--ok', text: sh, attr: { title: sh } });
    }
    // Show EVERY recorded resolve, not just the first. Gating the decision tree
    // off for this path must not silently drop evidence that does exist — a
    // satisfier run is usually a single resolve, but if it ever carries several
    // the reader still sees all of them.
    const rationales = steps
      .map((s) => String((s as { rationale?: unknown }).rationale ?? '').trim())
      .filter((r) => r.length > 0);
    if (rationales.length > 0) {
      for (const r of rationales) wrap.createDiv({ cls: 'sub-pathbody-text', text: r });
    } else {
      wrap.createDiv({
        cls: 'sub-pathbody-text',
        text: 'A connected vessel already produces this shape, so it was resolved in place. No activity was selected and no step executed.',
      });
    }
    wrap.createDiv({
      cls: 'sub-pathbody-note',
      text: 'Which vessel served the resolve is not recorded, so on a federated fleet you cannot tell a local answer from a peer’s from here.',
    });
  }

  /**
   * "How this verdict was reached" — the ordered audit chain (asked for → ran →
   * produced → judged by → therefore). Rendered for every settled walk so that a
   * human can see WHY the verdict landed the way it did without reading a trace,
   * and can disagree with a specific link rather than the bare pass/fail.
   */
  private renderVerdictDerivation(parent: HTMLElement, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const chain = verdictDerivation(body, d);
    if (chain.length === 0) return;
    const wrap = parent.createDiv('sub-derivation');
    wrap.createDiv({
      cls: 'sub-derivation-header',
      text: '⟐ How this verdict was reached',
    });
    for (const step of chain) {
      const row = wrap.createDiv(`sub-derivation-row${step.tone ? ` is-${step.tone}` : ''}`);
      row.createSpan({ cls: 'sub-derivation-label', text: step.label });
      row.createSpan({ cls: 'sub-derivation-text', text: step.text });
    }
  }

  private renderLearningLine(parent: HTMLElement, learning: WalkLearning | null): void {
    // Always speak, even when nothing was learned: a run that moved no
    // posterior and filed no gap is invisible to the learning loop, and that
    // silence is the single most useful thing to show an operator who is
    // deciding whether their feedback is needed here.
    const outcome = learningOutcomeSentence(learning);
    const taught = parent.createDiv('sub-learning-outcome');
    taught.createSpan({ cls: 'sub-learning-label', text: 'What the system learned' });
    taught.createSpan({ cls: 'sub-learning-outcome-text', text: outcome });
    if (!learning || typeof learning !== 'object') return;
    const parts: string[] = [];
    const delta = learning.alphaBetaDelta;
    if (Array.isArray(delta)) {
      // goal-host emits an array of {templateId, dAlpha, dBeta} — one per pick it graded.
      for (const e of delta as Array<Record<string, unknown>>) {
        const tid = e['templateId'] ?? e['template'];
        const da = e['dAlpha'] ?? e['alpha'] ?? e['deltaAlpha'];
        const db = e['dBeta'] ?? e['beta'] ?? e['deltaBeta'];
        const bits: string[] = [];
        if (typeof da === 'number' && da !== 0) bits.push(`Δα ${da >= 0 ? '+' : ''}${da}`);
        if (typeof db === 'number' && db !== 0) bits.push(`Δβ ${db >= 0 ? '+' : ''}${db}`);
        const on = typeof tid === 'string' ? ` on ${shortId(tid)}` : '';
        if (bits.length) parts.push(`${bits.join(' ')}${on}`);
      }
    } else if (delta !== undefined && delta !== null) {
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
  /**
   * Evidence ledger: one collapsible row per produced pool impulse, expanding to the
   * actual CONTENT the walk produced (capped preview from goalWalkState.poolProvenance,
   * which recomputes for BOTH reached and failed walks). Verdict-NEUTRAL by design — no
   * reach coloring here — because seeing content beside a green pill invites reflexive
   * agreement; the human judges the grader's verdict FROM this evidence. Each row is
   * badged tool-produced (grounded) vs llm-produced (may confabulate), and truncation is
   * labeled honestly so a preview is never mistaken for totality.
   */
  private renderEvidenceLedger(parent: HTMLElement, body: Record<string, unknown>, d: Record<string, unknown>): void {
    const prov = Array.isArray(body.poolProvenance)
      ? (body.poolProvenance as Array<Record<string, unknown>>)
      : [];
    if (prov.length === 0) return;
    const wrap = parent.createDiv('sub-evidence-ledger');
    wrap.createDiv({ cls: 'sub-evidence-header', text: '◈ Evidence — what the walk produced (judge the verdict against this)' });
    const isLLMProduced = (shape: string, producedBy: string): boolean =>
      /llm|completion|llmtext/i.test(shape) || /llm|completion/i.test(producedBy);
    for (const e of prov) {
      const shape = String(e.shape ?? 'shape');
      const producedBy = e.producedBy != null ? String(e.producedBy) : '';
      const chars = typeof e.chars === 'number' ? e.chars : 0;
      const preview = typeof e.contentPreview === 'string' ? e.contentPreview : '';
      const truncated = e.truncated === true;
      const grounded = !isLLMProduced(shape, producedBy);
      const badgeCls = grounded ? 'grounded' : 'unverified';
      // Honest distinction: a shape present in the pool with NO retained content is not
      // the same as "no shape produced". Say which.
      if (chars === 0 || !preview) {
        const rowEmpty = wrap.createDiv('sub-evidence-row sub-evidence-empty');
        rowEmpty.createSpan({ cls: `sub-evidence-badge sub-evidence-badge--${badgeCls}`, text: grounded ? '●' : '○' });
        rowEmpty.createSpan({ cls: 'sub-evidence-shape', text: shape });
        rowEmpty.createSpan({ cls: 'sub-evidence-meta', text: 'no content retained' });
        continue;
      }
      const meta = `${chars} chars${truncated ? ' · preview' : ''}${producedBy ? '  ·  ' + shortId(producedBy) : ''}`;
      this.renderCollapsible(wrap, `${shape}  ·  ${meta}`, (host) => {
        host.createDiv({
          cls: `sub-evidence-badge sub-evidence-badge--${badgeCls}`,
          text: grounded ? '● tool-produced (grounded)' : '○ llm-produced — may confabulate',
        });
        const pre = host.createEl('pre', { cls: 'sub-evidence-content' });
        pre.setText(preview);
        if (truncated) {
          host.createDiv({ cls: 'sub-evidence-truncnote', text: `showing first ${preview.length} of ${chars} characters` });
        }
      });
    }
  }

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
        trail.createDiv({ cls: 'sub-feed-line sub-why-line', text: humanizeWalkLine(clean), attr: { title: clean } });
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
      content = (await promptText(app, 'Context to inject into this dispatch:')) ?? null;
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
    // Reconcile pending cards against goal-host so a card whose goal has
    // completed (or whose solicitation timed out server-side) disappears
    // instead of lingering forever. registerInterval → cleared on view close.
    this.registerInterval(window.setInterval(() => void mgr.reconcile(), 30_000));
  }

  private renderSolicitations(list: PendingSolicitation[]): void {
    const el = this.solicitationsEl;
    if (!el) return;
    const solSnap = JSON.stringify(list);
    if (this.lastRenderedSnapshot.get('solicitations') === solSnap) return;
    this.lastRenderedSnapshot.set('solicitations', solSnap);
    // QW4: preserve half-typed answers across the snapshot rebuild — el.empty()
    // below would destroy an in-progress textarea, and the cooperative human is
    // mislabeled unresponsive when the solicitation times out.
    const preservedAnswers = new Map<string, { value: string; selStart: number; selEnd: number; focused: boolean }>();
    for (const ta of Array.from(el.querySelectorAll('textarea.sub-solicitation-answer')) as HTMLTextAreaElement[]) {
      const sid = ta.dataset.solicitationId;
      if (!sid) continue;
      preservedAnswers.set(sid, {
        value: ta.value,
        selStart: ta.selectionStart ?? ta.value.length,
        selEnd: ta.selectionEnd ?? ta.value.length,
        focused: document.activeElement === ta,
      });
    }
    el.empty();
    if (list.length === 0) return;
    for (const sol of list) {
      const card = el.createDiv('sub-card sub-card--solicitation');
      const head = card.createDiv('sub-solicitation-head');
      head.createDiv({ cls: 'sub-solicitation-title', text: '⚑ The substrate needs your input' });
      head.createDiv({
        cls: 'sub-solicitation-meta',
        text: `${new Date(sol.receivedAt).toLocaleTimeString()}${sol.dispatchId ? ` · goal ${sol.dispatchId.slice(0, 8)}` : ''}`,
      });
      const bodyEl = card.createDiv('sub-solicitation-body');
      void MarkdownRenderer.render(this.plugin.app, sol.questionMarkdown, bodyEl, '/', this);
      card.createDiv({ cls: 'sub-solicitation-label', text: 'Your answer' });
      const answerEl = card.createEl('textarea', {
        cls: 'sub-solicitation-answer',
        attr: { placeholder: 'Type your answer — typing keeps the door open…', rows: '4' },
      });
      answerEl.dataset.solicitationId = sol.solicitationId;
      const prevAnswer = preservedAnswers.get(sol.solicitationId);
      if (prevAnswer) {
        answerEl.value = prevAnswer.value;
        if (prevAnswer.focused) {
          answerEl.focus();
          try {
            answerEl.setSelectionRange(prevAnswer.selStart, prevAnswer.selEnd);
          } catch {
            /* setSelectionRange can throw on detached nodes; value is already restored */
          }
        }
      }
      answerEl.addEventListener('input', () => this.plugin.solicitationManager?.heartbeat(sol.solicitationId));
      const btnRow = card.createDiv('sub-solicitation-btns');
      // Deliver an outcome with honest feedback: disable the row while the
      // POST is in flight, confirm on success, and re-enable + Notice on
      // failure (respond() already drops the card if goal-host says the
      // solicitation is gone, so a false return here with the card still
      // present means transport failure).
      const sendOutcome = async (
        btn: HTMLButtonElement,
        outcome: 'answered' | 'declined' | 'insufficient_context',
        answer?: string,
      ): Promise<void> => {
        const mgr = this.plugin.solicitationManager;
        if (!mgr) return;
        const buttons = Array.from(btnRow.querySelectorAll('button')) as HTMLButtonElement[];
        for (const b of buttons) b.disabled = true;
        const originalLabel = btn.textContent ?? '';
        btn.textContent = 'Sending…';
        const ok = await mgr.respond(sol.solicitationId, outcome, answer);
        if (ok) {
          new Notice(outcome === 'answered' ? 'Answer delivered to the substrate.' : 'Response recorded.');
          return;
        }
        btn.textContent = originalLabel;
        for (const b of buttons) b.disabled = false;
        new Notice('Could not deliver the response — the solicitation may have expired or goal-host is unreachable.');
      };
      const answerBtn = btnRow.createEl('button', { cls: 'mod-cta', text: 'Answer' });
      answerBtn.addEventListener('click', () => {
        const answer = answerEl.value.trim();
        if (!answer) {
          new Notice('Write an answer first (or use Not now).');
          return;
        }
        void sendOutcome(answerBtn, 'answered', answer);
      });
      const declineBtn = btnRow.createEl('button', { text: 'Not now' });
      declineBtn.addEventListener('click', () => void sendOutcome(declineBtn, 'declined'));
      const insufficientBtn = btnRow.createEl('button', { text: 'Not enough context' });
      insufficientBtn.addEventListener('click', () => void sendOutcome(insufficientBtn, 'insufficient_context'));
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
        if (t.dispatch_id || t.execution_id) {
          const id = t.dispatch_id ?? t.execution_id;
          const chip = line.createSpan({ cls: 'sub-chip', text: `↳ ${shortId(String(id))}` });
          chip.setAttribute('title', String(id));
        }
      }
    };
    render();
    this.unsubscribeTouches = ledger.subscribe(() => render());
  }

  private async renderReachVerdict(): Promise<void> {
    const dispatchId = this.activeDispatchId;
    if (!dispatchId) return;
    try {
      const client = new GoalHostClient();
      const record = await client.getDispatchRecord(dispatchId);
      const reached = record.reached as boolean | null;
      const reason = typeof record.goalReachReason === 'string' ? record.goalReachReason : null;
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
  // Walk-state poll (live dispatch progress)
  //
  // Replaces the old activity-api `/ws` event bus. That bus bypassed the
  // federation sidecar and connected to `websocketUrl || activityApiUrl`, both
  // blank in production — so it was dead. Instead, while a dispatch is active we
  // poll the goalWalkState shape through the sidecar (~2.5s) and render the
  // walk's steps as they land. Granularity is per-walk-step, coarser than the
  // old per-event feed, but the events it replaces never actually arrived.
  // ---------------------------------------------------------------------------

  private startWalkPoll(): void {
    this.stopWalkPoll();
    if (!this.activeExecutionId) return;
    void this.pollWalkOnce();
    this.walkPollTimer = window.setInterval(() => void this.pollWalkOnce(), 2500);
  }

  private stopWalkPoll(): void {
    if (this.walkPollTimer !== null) {
      window.clearInterval(this.walkPollTimer);
      this.walkPollTimer = null;
    }
  }

  private async pollWalkOnce(): Promise<void> {
    const execId = this.activeExecutionId;
    if (!execId) return;
    const j = await this.goalHostResolve({ type: 'goalWalkState', execution_id: execId });
    const body = (j?.body ?? null) as Record<string, unknown> | null;
    if (!body) return;
    this.renderWalkProgress(body);
  }

  /**
   * Render live dispatch progress from a polled goalWalkState snapshot.
   * Appends a feed line for each newly-observed walk step (selected producer,
   * source, rationale, and any newly-produced shapes), renders the authored
   * answer once when present, and settles the dispatch (reach verdict, note
   * completion, deferred impulse-relevance) when the walk reaches a terminal
   * status.
   */
  private renderWalkProgress(body: Record<string, unknown>): void {
    const steps = Array.isArray(body.steps) ? (body.steps as WalkStep[]) : [];
    // Resets-on-failed-attempts fix: a hollow-fail REFRAME rebuilds/re-indexes the
    // steps array shorter or from 0. The monotonic high-water below would then never
    // render the new attempt (its steps sit at indices below renderedStepCount) — the
    // feed silently freezes and a failed attempt looks like a broken walk. Detect the
    // shrink, mark an explicit attempt boundary, and reset the high-water so the new
    // attempt renders as a labeled continuation rather than a dead feed.
    if (steps.length < this.renderedStepCount) {
      this.appendMessage('↺ reframed — reach fell short; walking a new attempt', 'divider');
      this.renderedStepCount = 0;
    }
    for (let i = this.renderedStepCount; i < steps.length; i++) {
      const step = steps[i];
      const sel = step.selected ?? {};
      const n = (step.index ?? i) + 1;
      const tmpl = sel.templateId ? shortId(sel.templateId) : 'step';
      const parts = [`▶ Step ${n}: ${tmpl}`];
      const src = sourceLabel(sel.source);
      if (src && src !== 'step') parts.push(`[${src}]`);
      if (step.rationale) {
        const r = preview(step.rationale, 80);
        if (r) parts.push(r);
      }
      this.appendMessage(parts.join('  '), step.status === 'failed' ? 'failure' : 'task');
      if (Array.isArray(step.newShapes) && step.newShapes.length > 0) {
        this.appendMessage(`  ◎ ${step.newShapes.join(', ')}`, 'impulse');
      }
    }
    this.renderedStepCount = Math.max(this.renderedStepCount, steps.length);

    // Authored answer (question goals): render once, prominently.
    const answerBody = typeof body.answerBody === 'string' ? body.answerBody.trim() : '';
    if (answerBody && !this.answerRendered) {
      this.answerRendered = true;
      this.appendAnswerBlock(answerBody, undefined, answerGrounding(body), this.activeDispatchId ?? '');
    }

    // Settle when the walk reports a terminal status. `status` is the template
    // exit; `reached` is the honest verdict — either being present-and-terminal
    // ends the dispatch.
    const status = String(body.status ?? '');
    const reached = body.reached as boolean | null | undefined;
    const terminal =
      status === 'completed' ||
      status === 'failed' ||
      (status !== 'running' && (reached === true || reached === false));
    if (terminal && this.dispatching) {
      const ok = status !== 'failed' && reached !== false;
      // Never show green before the honest reach verdict: ✓ is gated on
      // reached===true; a non-reach (or failed exit) is red; an unknown/pending
      // reach reads NEUTRAL — a settled dispatch is not a success until the
      // goal-reach verdict confirms it.
      if (reached === true) {
        this.appendMessage('✓ Execution complete', 'success');
      } else if (reached === false || status === 'failed') {
        this.appendMessage('✗ Execution failed', 'failure');
      } else {
        this.appendMessage('○ Execution settled — reach verdict pending', undefined);
      }
      if (this.goalFile) {
        this.goalNoteManager.markComplete(this.goalFile, ok ? 'completed' : 'failed', this.mintedConcepts);
      }
      this.dispatching = false;
      this.setDispatchBtnState(false);
      void this.renderReachVerdict();
      const settleId = this.activeExecutionId ?? '';
      const fireRelevance = this.pendingRelevance.get(settleId);
      if (fireRelevance) {
        this.pendingRelevance.delete(settleId);
        fireRelevance(ok);
      }
      this.stopWalkPoll();
    }
  }

  /**
   * Render the goal's authored answer as a distinct multi-line block in the
   * panel so the user reads the response directly without opening the vault
   * note or querying concept-db. Called once per dispatch when a goalAnswer
   * concept fires for the root execution.
   */
  private appendAnswerBlock(answer: string, conceptId: string | undefined, grounding: 'grounded' | 'unverified' = 'unverified', dispatchId = ''): void {
    if (!this.outputEl) return;
    const stick = this.isNearBottom();
    const wrap = this.outputEl.createDiv('sub-feed-line sub-card sub-card--answer');
    wrap.createSpan({ cls: 'sub-feed-ts', text: this.feedTs() });
    const inner = wrap.createDiv({ cls: 'sub-feed-msg sub-answer-body' });
    const header = inner.createDiv({ cls: 'sub-answer-header', text: '◇ Answer' });
    header.createSpan({
      cls: `sub-answer-badge sub-answer-badge--${grounding}`,
      text: grounding === 'grounded' ? '● grounded' : '○ unverified — no tool anchor',
    });
    this.renderAnswerViaArm(wrap, inner, answer, grounding, dispatchId);
    if (conceptId) {
      inner.createDiv({
        cls: 'sub-answer-attribution',
        text: `↳ stored as ${shortId(conceptId)}`,
        attr: { title: conceptId },
      });
    }
    if (stick) this.scrollToBottom();
  }
}
