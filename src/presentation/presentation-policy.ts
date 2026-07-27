/**
 * presentation-policy.ts — Thompson selection over answer-presentation arms.
 *
 * The three arms are real activity templates in the fleet's activity-api
 * (minted once, `proposed: true` so walk candidate pools never see them);
 * their posteriors live in variant_performance_metrics (global) and
 * context_thompson_scores (per-human, keyed by a 16-hex signature derived
 * from this install's vesselId). Selection samples Beta(α,β) CLIENT-side
 * because the fleet /recommend REST surface is unreachable from a federated
 * spoke (only impulse resolves cross the overlay) and has no candidate
 * whitelist; the posterior STORE stays authoritative — this is still the one
 * selection primitive, read at use time (law 1/one-selection-primitive).
 *
 * Grades are emitted by attention-grader.ts as activityExecutionTrace_write
 * impulses carrying the same signature, so per-human conditional rows
 * accumulate server-side (blocked today by
 * gap-context-thompson-v1-writes-frozen-since-0721 — selection honestly
 * falls back to the pooled global posterior until conditional n ≥ FLOOR).
 */
import { sidecarResolveAuto } from '../sidecar-manager';

export type ArmKey = 'a' | 'b' | 'c';

export const PRESENTATION_ARMS: ReadonlyArray<{ key: ArmKey; templateId: string }> = [
  { key: 'a', templateId: 'obsidian-present-inline-full' },
  { key: 'b', templateId: 'obsidian-present-lede-progressive' },
  { key: 'c', templateId: 'obsidian-present-digest-action' },
];

export interface ArmDecision {
  dispatchId: string;
  armKey: ArmKey;
  templateId: string;
  /** 'fallback' decisions are NEVER graded — grading a non-choice is the law-2 violation. */
  source: 'thompson' | 'epsilon' | 'fallback';
  sig: string;
  /** Sampled posteriors at decision time (counterfactual record, law 12). */
  posteriors?: Array<{ templateId: string; alpha: number; beta: number; conditional: boolean; sample: number }>;
  at: string;
}

const EPSILON = 0.1;
/** Mirrors activity-api SIGNATURE_SAMPLING_FLOOR: below n=5 the conditional row is noise. */
const CONDITIONAL_FLOOR = 5;
const POSTERIOR_TTL_MS = 5 * 60_000;

const decisionCache = new Map<string, ArmDecision>();
const decisionLog: ArmDecision[] = [];
let cachedSig: { vesselId: string; sig: string } | null = null;
let posteriorCache: { at: number; byTemplate: Map<string, { alpha: number; beta: number; conditional: boolean }> } | null = null;

/** Per-human context key: domain-prefixed away from walk state-space signatures. */
export async function humanSig16(vesselId: string): Promise<string> {
  if (cachedSig && cachedSig.vesselId === vesselId) return cachedSig.sig;
  const data = new TextEncoder().encode('presentation|' + (vesselId || 'unknown-vessel'));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const sig = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  cachedSig = { vesselId, sig };
  return sig;
}

/** Unwrap the sidecar resolve envelope down to the resolver's JSON payload. */
function resolvedValue(res: unknown): unknown {
  const r = res as Record<string, unknown> | null;
  if (!r) return null;
  const content = (r.content ?? r) as Record<string, unknown>;
  const raw = content?.value ?? content?.body ?? content;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw;
}

/** Global α/β from the activityMetrics direct-table read (markdown table; the
 *  structured variantMetricsSummary shape DERIVES fake α/β — do not use it). */
async function fetchGlobalPosterior(templateId: string): Promise<{ alpha: number; beta: number } | null> {
  const res = await sidecarResolveAuto({ type: 'activityMetrics', activityId: templateId }, 12_000);
  const v = resolvedValue(res);
  const text = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const line = text.split('\n').find((l) => l.includes(templateId));
  const m = line ? /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s*\|?\s*$/.exec(line.trim()) : null;
  if (!m) return null;
  return { alpha: parseFloat(m[1]), beta: parseFloat(m[2]) };
}

async function fetchConditionalRows(sig: string): Promise<Map<string, { alpha: number; beta: number; n: number }>> {
  const out = new Map<string, { alpha: number; beta: number; n: number }>();
  const res = await sidecarResolveAuto({ type: 'contextThompsonScores', signatureVersion: 1, limit: 500 }, 12_000);
  const v = resolvedValue(res) as { entries?: Array<Record<string, unknown>> } | null;
  for (const e of v?.entries ?? []) {
    if (e.context_bucket === sig && typeof e.template_id === 'string') {
      out.set(e.template_id, {
        alpha: Number(e.alpha ?? 1),
        beta: Number(e.beta ?? 1),
        n: Number(e.n_observations ?? 0),
      });
    }
  }
  return out;
}

async function loadPosteriors(sig: string): Promise<Map<string, { alpha: number; beta: number; conditional: boolean }>> {
  if (posteriorCache && Date.now() - posteriorCache.at < POSTERIOR_TTL_MS) return posteriorCache.byTemplate;
  const byTemplate = new Map<string, { alpha: number; beta: number; conditional: boolean }>();
  const conditional = await fetchConditionalRows(sig).catch(() => new Map<string, { alpha: number; beta: number; n: number }>());
  for (const arm of PRESENTATION_ARMS) {
    const c = conditional.get(arm.templateId);
    if (c && c.n >= CONDITIONAL_FLOOR) {
      byTemplate.set(arm.templateId, { alpha: c.alpha, beta: c.beta, conditional: true });
      continue;
    }
    const g = await fetchGlobalPosterior(arm.templateId).catch(() => null);
    byTemplate.set(arm.templateId, { alpha: g?.alpha ?? 1, beta: g?.beta ?? 1, conditional: false });
  }
  posteriorCache = { at: Date.now(), byTemplate };
  return byTemplate;
}

/** Invalidate the posterior cache after a grade lands so the next selection sees it. */
export function invalidatePosteriorCache(): void {
  posteriorCache = null;
}

// Marsaglia–Tsang gamma sampler → Beta(α,β) sample.
function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      const u1 = Math.random(), u2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function sampleBeta(alpha: number, beta: number): number {
  const a = sampleGamma(Math.max(alpha, 0.01));
  const b = sampleGamma(Math.max(beta, 0.01));
  return a / (a + b);
}

function record(decision: ArmDecision): ArmDecision {
  decisionCache.set(decision.dispatchId, decision);
  decisionLog.push(decision);
  if (decisionLog.length > 200) decisionLog.splice(0, decisionLog.length - 200);
  return decision;
}

/**
 * Select the presentation arm for a dispatch. Call at dispatch time so the
 * ~2s overlay posterior read is hidden from the answer render. Idempotent.
 */
export async function selectPresentationArm(dispatchId: string, vesselId: string): Promise<ArmDecision> {
  if (!dispatchId) return fallbackDecision(dispatchId);
  const cached = decisionCache.get(dispatchId);
  if (cached) return cached;
  try {
    const sig = await humanSig16(vesselId);
    if (Math.random() < EPSILON) {
      const arm = PRESENTATION_ARMS[Math.floor(Math.random() * PRESENTATION_ARMS.length)];
      return record({ dispatchId, armKey: arm.key, templateId: arm.templateId, source: 'epsilon', sig, at: new Date().toISOString() });
    }
    const posteriors = await loadPosteriors(sig);
    let best: { key: ArmKey; templateId: string; sample: number } | null = null;
    const snapshot: NonNullable<ArmDecision['posteriors']> = [];
    for (const arm of PRESENTATION_ARMS) {
      const p = posteriors.get(arm.templateId) ?? { alpha: 1, beta: 1, conditional: false };
      const sample = sampleBeta(p.alpha, p.beta);
      snapshot.push({ templateId: arm.templateId, alpha: p.alpha, beta: p.beta, conditional: p.conditional, sample });
      if (!best || sample > best.sample) best = { key: arm.key, templateId: arm.templateId, sample };
    }
    if (!best) return record(fallbackDecision(dispatchId));
    return record({ dispatchId, armKey: best.key, templateId: best.templateId, source: 'thompson', sig, posteriors: snapshot, at: new Date().toISOString() });
  } catch {
    return record(fallbackDecision(dispatchId));
  }
}

function fallbackDecision(dispatchId: string): ArmDecision {
  return { dispatchId, armKey: 'a', templateId: PRESENTATION_ARMS[0].templateId, source: 'fallback', sig: '', at: new Date().toISOString() };
}

/** Render-time lookup. A miss means the dispatch was not selected through the
 *  policy (older dispatch, foreign runner) — render arm A ungraded. */
export function peekPresentationArm(dispatchId: string): ArmDecision {
  return decisionCache.get(dispatchId) ?? fallbackDecision(dispatchId);
}

export function getPresentationDecisions(): ReadonlyArray<ArmDecision> {
  return decisionLog;
}
