/**
 * Panel aggregates — the two learned composed producers the panel leans on,
 * dispatched as goals through the sidecar conduit (never a raw endpoint):
 *
 *  - substrate pulse vitals   (composed-cap-substrate-pulse-vitals-v2-aggregator-aut)
 *  - per-execution next-selection (composed-cap-substrate-next-selection-aggregator-auth)
 *
 * A dispatch is a goal, not an RPC: it can fail or come back hollow, and it
 * takes tens of seconds. Callers therefore always render from the last good
 * verdict (with its age) and derive the raw numbers deterministically. What
 * the panel takes from an aggregator is the reach judge's sentence — the
 * substrate's own prose about what it found — because the composed
 * deliverable content is not yet durably resolvable after execution.
 */
import { sidecarHttpAuto, sidecarResolveBody } from '../sidecar-manager';

export interface AggregateVerdict {
  reached: boolean | null;
  /** Reach-judge prose — the narrative the panel renders verbatim. */
  sentence: string;
  dispatchId: string;
  executionId?: string;
  /** ms epoch when the dispatch settled. */
  asOf: number;
}

const PULSE_TEMPLATE_ID = 'composed-cap-substrate-pulse-vitals-v2-aggregator-aut';
const PULSE_GOAL =
  'Produce the substrate pulse vitals: reach_rate, vessels_connected, peer_substrates, open_gaps, and runners roster.';
const NEXT_TEMPLATE_ID = 'composed-cap-substrate-next-selection-aggregator-auth';

let pulseVerdict: AggregateVerdict | null = null;
let pulseInFlight: Promise<AggregateVerdict | null> | null = null;
let pulseLastAttempt = 0;
const FAILURE_BACKOFF_MS = 600_000;
const nextVerdicts = new Map<string, AggregateVerdict>();
const nextInFlight = new Map<string, Promise<AggregateVerdict | null>>();

/** Extract the judge's one-line prose from a settled walkState body. */
function reachSentenceFrom(state: Record<string, unknown>): string {
  const cur = typeof state.currentStep === 'string' ? state.currentStep : '';
  const walk = Array.isArray(state.walkLog) ? (state.walkLog as unknown[]).map(String) : [];
  const src = cur || (walk.length ? walk[walk.length - 1] : '');
  if (src) {
    const m = src.match(/—\s*(.+?)\.?\s*(?:completion_shapes=|$)/);
    if (m && m[1]) return m[1].trim().replace(/\.\.$/, '.');
  }
  if (typeof state.goalReachReason === 'string' && state.goalReachReason) return state.goalReachReason;
  return '';
}

/**
 * Dispatch a target template through the sidecar's goal_execution route and
 * poll goalWalkState until it settles. Resolves null on conduit failure or
 * timeout — the caller keeps whatever it last had.
 */
async function dispatchAndSettle(
  goal: string,
  templateId: string,
  variables?: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<AggregateVerdict | null> {
  const res = await sidecarHttpAuto({
    shape: 'goal_execution',
    method: 'POST',
    path: '/run-goal',
    body: {
      goal,
      target_template_id: templateId,
      ...(variables ? { variables } : {}),
      tags: ['dispatcher:obsidian-vessel', 'surface:panel-aggregate'],
    },
  });
  const raw = (res?.body ?? {}) as Record<string, unknown>;
  const dispatchId = String(raw.dispatchId ?? raw.executionId ?? '');
  if (!res?.ok || !dispatchId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const body = await sidecarResolveBody({ type: 'goalWalkState', dispatchId });
    const state = (body ?? {}) as Record<string, unknown>;
    const status = String(state.status ?? '');
    if (status === 'completed' || status === 'failed') {
      return {
        reached: typeof state.reached === 'boolean' ? state.reached : null,
        sentence: reachSentenceFrom(state),
        dispatchId,
        executionId: typeof state.executionId === 'string' ? state.executionId : undefined,
        asOf: Date.now(),
      };
    }
  }
  return null;
}

/** Last settled pulse verdict, if any (render immediately, refresh behind). */
export function cachedPulseVerdict(): AggregateVerdict | null {
  return pulseVerdict;
}

/**
 * Refresh the pulse-vitals narrative when stale. Single-flight: concurrent
 * callers share one dispatch. Default staleness 30 minutes — the aggregator
 * is a learned producer whose every run feeds a trace, not a poll target.
 */
export function refreshPulseVerdict(maxAgeMs = 1_800_000): Promise<AggregateVerdict | null> {
  if (pulseVerdict && Date.now() - pulseVerdict.asOf < maxAgeMs) return Promise.resolve(pulseVerdict);
  if (pulseInFlight) return pulseInFlight;
  if (Date.now() - pulseLastAttempt < FAILURE_BACKOFF_MS) return Promise.resolve(pulseVerdict);
  pulseLastAttempt = Date.now();
  pulseInFlight = dispatchAndSettle(PULSE_GOAL, PULSE_TEMPLATE_ID)
    .then((v) => {
      if (v && v.sentence) pulseVerdict = v;
      pulseInFlight = null;
      return v;
    })
    .catch(() => {
      pulseInFlight = null;
      return null;
    });
  return pulseInFlight;
}

/** Cached next-selection verdict for an execution, if already fetched. */
export function cachedNextSelection(executionId: string): AggregateVerdict | null {
  return nextVerdicts.get(executionId) ?? null;
}

/**
 * Ask the next-selection aggregator what this execution should run next.
 * Dispatched once per executionId (single-flight, cached for the session);
 * the verdict sentence names the top-scoring follow-on activity.
 */
export function requestNextSelection(executionId: string): Promise<AggregateVerdict | null> {
  const hit = nextVerdicts.get(executionId);
  if (hit) return Promise.resolve(hit);
  const inflight = nextInFlight.get(executionId);
  if (inflight) return inflight;
  if (Date.now() - pulseLastAttempt < FAILURE_BACKOFF_MS && pulseVerdict === null) return Promise.resolve(null);
  const goal =
    `Recommend the top-scoring next activity for execution ${executionId} ` +
    'based on its end shape pool and current template metrics.';
  const p = dispatchAndSettle(goal, NEXT_TEMPLATE_ID, { executionId })
    .then((v) => {
      if (v && v.sentence) nextVerdicts.set(executionId, v);
      nextInFlight.delete(executionId);
      return v;
    })
    .catch(() => {
      nextInFlight.delete(executionId);
      return null;
    });
  nextInFlight.set(executionId, p);
  return p;
}
