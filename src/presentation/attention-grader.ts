/**
 * attention-grader.ts — exposure-gated human-attention grading of the
 * presentation arms. One episode per dispatch, merged across every card that
 * renders the same answer (feed block + fleet-row inline).
 *
 * Honesty rules (each guards a specific hollow-green mode):
 *  - no exposure → NO emission (missing-not-at-random; a card the human never
 *    saw says nothing about the presentation);
 *  - selection source 'fallback' → NO emission (never grade a non-choice);
 *  - every engagement event must be ev.isTrusted (the plugin's own dom_query /
 *    execute-command resolvers can synthesize DOM events — machine attention
 *    must not pump α);
 *  - verdict submission counts as engagement at ANY polarity: submitting
 *    grades the DELIVERY, the polarity grades the answer CONTENT and flows
 *    through goal_verification_label_write instead (de-confounding);
 *  - per-arm engagement definitions are cost-matched so no arm has a
 *    structurally cheaper positive signal.
 *
 * Grade = ONE activityExecutionTrace_write impulse over the sidecar overlay
 * (plain REST is unreachable from a federated spoke). Positive → graded-yield
 * ≈{α+0.75, β+0.25}; negative → verifier_negative {α+0, β+1}. The trace
 * carries metadata.state_space_signature = the per-human sig so conditional
 * rows accumulate once the frozen cts writer
 * (gap-context-thompson-v1-writes-frozen-since-0721) is repaired.
 */
import { sidecarResolveAuto } from '../sidecar-manager';
import { invalidatePosteriorCache, type ArmDecision, type ArmKey } from './presentation-policy';

interface Episode {
  decision: ArmDecision;
  grounding: 'grounded' | 'unverified';
  operator: string;
  answerWords: number;
  cards: Set<HTMLElement>;
  visibleSince: number | null;
  dwellMs: number;
  exposed: boolean;
  expanded: boolean;
  expandAt: number | null;
  moreExpanded: boolean;
  copied: boolean;
  copyBtn: boolean;
  verdict: boolean;
  dismissed: boolean;
  settled: boolean;
  settleTimer: number | null;
  firstExposureAt: number | null;
}

const EXPOSURE_MIN_MS = 1500;
const SETTLE_AFTER_MS = 120_000;
const POST_EXPAND_MIN_MS = 3000;

function dwellThresholdMs(words: number): number {
  return Math.min(20_000, Math.max(2000, 2000 + 50 * words));
}

export class AttentionGrader {
  private episodes = new Map<string, Episode>();
  private observer: IntersectionObserver | null = null;
  private cardToDispatch = new WeakMap<HTMLElement, string>();
  private tick: number | null = null;

  attach(
    card: HTMLElement,
    dispatchId: string,
    decision: ArmDecision,
    grounding: 'grounded' | 'unverified',
    operator: string,
    answer: string,
  ): void {
    if (!dispatchId) return;
    let ep = this.episodes.get(dispatchId);
    if (!ep) {
      ep = {
        decision, grounding, operator,
        answerWords: answer.split(/\s+/).filter(Boolean).length,
        cards: new Set(), visibleSince: null, dwellMs: 0, exposed: false,
        expanded: false, expandAt: null, moreExpanded: false,
        copied: false, copyBtn: false, verdict: false, dismissed: false,
        settled: false, settleTimer: null, firstExposureAt: null,
      };
      this.episodes.set(dispatchId, ep);
    }
    ep.cards.add(card);
    this.cardToDispatch.set(card, dispatchId);
    this.ensureObserver().observe(card);
    // Trusted text-copy from within the card is engagement on every arm.
    card.addEventListener('copy', (ev: ClipboardEvent) => {
      if (!ev.isTrusted) return;
      ep!.copied = true;
      this.maybeSettlePositive(dispatchId);
    });
  }

  /** Arm-specific affordance events, reported by the renderers on trusted clicks. */
  armEvent(dispatchId: string, kind: 'expand' | 'more' | 'copyBtn'): void {
    const ep = this.episodes.get(dispatchId);
    if (!ep || ep.settled) return;
    if (kind === 'expand') { ep.expanded = true; ep.expandAt = Date.now(); }
    if (kind === 'more') { ep.moreExpanded = true; }
    if (kind === 'copyBtn') { ep.copyBtn = true; }
    this.maybeSettlePositive(dispatchId);
  }

  verdictSubmitted(dispatchId: string): void {
    const ep = this.episodes.get(dispatchId);
    if (!ep || ep.settled) return;
    ep.verdict = true;
    this.maybeSettlePositive(dispatchId);
  }

  dismiss(dispatchId: string): void {
    const ep = this.episodes.get(dispatchId);
    if (!ep || ep.settled) return;
    ep.dismissed = true;
    this.settle(dispatchId, false);
  }

  /** View teardown: settle every exposed pending episode as-is. */
  flushAll(): void {
    for (const [id, ep] of this.episodes) {
      if (!ep.settled) this.settle(id, this.isEngaged(ep));
    }
  }

  debugState(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [id, ep] of this.episodes) {
      out.push({
        dispatchId: id, arm: ep.decision.armKey, source: ep.decision.source,
        exposed: ep.exposed, dwellMs: Math.round(this.currentDwell(ep)),
        expanded: ep.expanded, more: ep.moreExpanded, copied: ep.copied,
        copyBtn: ep.copyBtn, verdict: ep.verdict, dismissed: ep.dismissed, settled: ep.settled,
      });
    }
    return out;
  }

  private ensureObserver(): IntersectionObserver {
    if (this.observer) return this.observer;
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = this.cardToDispatch.get(entry.target as HTMLElement);
        if (!id) continue;
        const ep = this.episodes.get(id);
        if (!ep || ep.settled) continue;
        const visible = entry.intersectionRatio >= 0.5 && document.visibilityState === 'visible';
        this.setVisible(id, ep, visible);
      }
    }, { threshold: [0, 0.5, 1] });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') this.pauseAll();
    });
    window.addEventListener('blur', () => this.pauseAll());
    return this.observer;
  }

  private setVisible(id: string, ep: Episode, visible: boolean): void {
    if (visible && ep.visibleSince === null) {
      ep.visibleSince = Date.now();
      if (ep.firstExposureAt === null) {
        ep.firstExposureAt = Date.now();
        // Elapsed-without-signal → engaged=0. The timer is the negative path;
        // positives settle immediately on their signal.
        ep.settleTimer = window.setTimeout(() => {
          if (!ep.settled) this.settle(id, this.isEngaged(ep));
        }, SETTLE_AFTER_MS);
      }
      this.ensureTick();
    } else if (!visible && ep.visibleSince !== null) {
      ep.dwellMs += Date.now() - ep.visibleSince;
      ep.visibleSince = null;
    }
    if (this.currentDwell(ep) >= EXPOSURE_MIN_MS) ep.exposed = true;
  }

  private pauseAll(): void {
    for (const ep of this.episodes.values()) {
      if (ep.visibleSince !== null) {
        ep.dwellMs += Date.now() - ep.visibleSince;
        ep.visibleSince = null;
      }
    }
  }

  private currentDwell(ep: Episode): number {
    return ep.dwellMs + (ep.visibleSince !== null ? Date.now() - ep.visibleSince : 0);
  }

  /** 1s heartbeat: promotes exposure and dwell-threshold engagement while a card is visible. */
  private ensureTick(): void {
    if (this.tick !== null) return;
    this.tick = window.setInterval(() => {
      let anyVisible = false;
      for (const [id, ep] of this.episodes) {
        if (ep.settled) continue;
        if (ep.visibleSince !== null) anyVisible = true;
        if (this.currentDwell(ep) >= EXPOSURE_MIN_MS) ep.exposed = true;
        if (this.isEngaged(ep)) this.maybeSettlePositive(id);
      }
      if (!anyVisible && this.tick !== null) { window.clearInterval(this.tick); this.tick = null; }
    }, 1000);
  }

  /** Cost-matched per-arm engagement definitions. */
  private isEngaged(ep: Episode): boolean {
    if (!ep.exposed || ep.dismissed) return false;
    if (ep.copied || ep.verdict) return true;
    const arm: ArmKey = ep.decision.armKey;
    const dwell = this.currentDwell(ep);
    if (arm === 'a') return dwell >= dwellThresholdMs(ep.answerWords);
    if (arm === 'b') return ep.expanded && ep.expandAt !== null && Date.now() - ep.expandAt >= POST_EXPAND_MIN_MS;
    return ep.copyBtn || (ep.moreExpanded && dwell >= POST_EXPAND_MIN_MS);
  }

  private maybeSettlePositive(dispatchId: string): void {
    const ep = this.episodes.get(dispatchId);
    if (!ep || ep.settled) return;
    if (this.isEngaged(ep)) this.settle(dispatchId, true);
  }

  private settle(dispatchId: string, engaged: boolean): void {
    const ep = this.episodes.get(dispatchId);
    if (!ep || ep.settled) return;
    ep.settled = true;
    if (ep.settleTimer !== null) { window.clearTimeout(ep.settleTimer); ep.settleTimer = null; }
    this.pauseAll();
    // Hard suppression rules: never-exposed and non-choices emit NOTHING.
    if (!ep.exposed) return;
    if (ep.decision.source === 'fallback') return;
    void this.emitGrade(dispatchId, ep, engaged);
  }

  private async emitGrade(dispatchId: string, ep: Episode, engaged: boolean): Promise<void> {
    const tags = [
      engaged ? 'reached:true' : 'reached:false',
      'presentation.variant',
      `selection.source:${ep.decision.source}`,
      `operator:${ep.operator || 'unknown'}`,
      `dispatch:${dispatchId}`,
      `grounding:${ep.grounding}`,
    ];
    if (ep.verdict) tags.push('verdict.submitted:true');
    const traceData: Record<string, unknown> = {
      execution_id: `present-${dispatchId}`,
      template_id: ep.decision.templateId,
      status: engaged ? 'completed' : 'failed',
      success: engaged,
      duration_ms: Math.max(1, Math.round(ep.dwellMs)),
      cost_usd: 0,
      tags,
      // NO tasks[], NO composition_chain — empty tasks classify all_stochastic
      // so the posterior update fires; content there risks tier misclassification
      // and chain-credit fabrication.
      metadata: {
        state_space_signature: ep.decision.sig,
        signature_version: 1,
        attention: {
          dwell_ms: Math.round(ep.dwellMs),
          expanded: ep.expanded,
          more: ep.moreExpanded,
          copied: ep.copied,
          copy_btn: ep.copyBtn,
          verdict: ep.verdict,
          dismissed: ep.dismissed,
        },
      },
    };
    if (!engaged) {
      traceData.failure_mode = { type: 'verifier_negative', description: 'human did not engage with presentation' };
    }
    try {
      await sidecarResolveAuto({ type: 'activityExecutionTrace_write', traceData }, 20_000);
      invalidatePosteriorCache();
    } catch {
      // Honest loss: a dropped grade is never fabricated later.
    }
  }
}

export const attentionGrader = new AttentionGrader();
