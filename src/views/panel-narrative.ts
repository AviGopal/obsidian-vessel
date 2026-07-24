/**
 * Panel narrative — pure sentence builders for the goal-dispatch panel.
 *
 * The redesign contract: every fact the panel shows leads with a human
 * sentence; raw values (θ, α/β, shape names) demote to tooltips and small
 * mono annotations. These builders are pure data→string so any surface can
 * reuse them. No Obsidian imports, no substrate calls.
 */

/**
 * Beta-posterior evidence as a plain sentence.
 * α9/β2 → "it reached 9 of its last 11 tries here, the clear front-runner."
 * Selection sources that are not Thompson picks get their own explanation.
 */
export function posteriorSentence(
  sel: { alpha?: number; beta?: number; sampledScore?: number; source?: string },
  rivalCount = 0,
): string {
  const src = sel.source ?? '';
  if (src === 'satisfier') return 'Answered directly from the pool — nothing needed to run.';
  if (src === 'bridge') return 'A connector step the walk inserted to carry shapes forward.';
  if (src === 'recovery') return 'A recovery attempt after the first choice failed.';
  if (src === 'improvise') return 'Improvised — no learned pathway covered this, so the walk composed one.';
  const a = sel.alpha;
  const b = sel.beta;
  const lead = rivalCount > 0 ? `Picked over ${rivalCount} rival${rivalCount === 1 ? '' : 's'} — ` : '';
  if (typeof a === 'number' && typeof b === 'number' && a + b > 2) {
    const wins = Math.round(a);
    const total = Math.round(a + b);
    const rate = wins / Math.max(total, 1);
    const conf = rate >= 0.75
      ? ', the clear front-runner'
      : rate >= 0.5
        ? ', the best evidence available'
        : ' — a long shot the sampler still favoured';
    return `${lead}it reached ${wins} of its last ${total} tries here${conf}.`;
  }
  if (typeof sel.sampledScore === 'number') {
    return `${lead}sampled at ${sel.sampledScore.toFixed(2)} with little history yet — the sampler is exploring.`;
  }
  return `${lead}chosen with no prior history — a first try.`;
}

/** One shadow/alternative line: what was sampled but held back, and why. */
export function shadowSentence(c: {
  templateId?: string;
  alpha?: number;
  beta?: number;
  rejectedBecause?: string;
}): string {
  const name = c.templateId ?? 'an alternative';
  if (c.rejectedBecause) return `also sampled ${name} — held back: ${c.rejectedBecause}`;
  if (typeof c.alpha === 'number' && typeof c.beta === 'number') {
    const wins = Math.round(c.alpha);
    const total = Math.round(c.alpha + c.beta);
    return `also sampled ${name} — its record here (${wins} of ${total}) sampled lower this time`;
  }
  return `also sampled ${name} — it sampled lower this time`;
}

/**
 * The shape-pool contribution as one sentence:
 * "Started with 3 shapes, ended with 6 — grew the pool by 3, consumed 1."
 */
export function poolDeltaSentence(before: string[], after: string[]): string {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const grew = after.filter((s) => !beforeSet.has(s)).length;
  const consumed = before.filter((s) => !afterSet.has(s)).length;
  if (before.length === 0 && after.length === 0) return '';
  const parts: string[] = [];
  if (grew > 0) parts.push(`grew the pool by ${grew}`);
  if (consumed > 0) parts.push(`consumed ${consumed}`);
  if (parts.length === 0) parts.push('carried the pool through unchanged');
  return `Started with ${before.length} shape${before.length === 1 ? '' : 's'}, ended with ${after.length} — ${parts.join(', ')}.`;
}

/** Reach-rate tile caption: "13 of the last 15 goals actually reached what they set out to do." */
export function reachCaption(reached: number, settled: number): string {
  if (settled === 0) return 'No settled goals in the window yet.';
  return `${reached} of the last ${settled} goal${settled === 1 ? '' : 's'} actually reached what ${settled === 1 ? 'it' : 'they'} set out to do.`;
}

/** Vessels tile caption. */
export function vesselsCaption(count: number): string {
  return count > 0 ? 'all advertising into discovery' : 'none visible in discovery right now';
}

/** Peers tile caption from federation member names: "this substrate plus syzygy-hub across the relay". */
export function peersCaption(memberNames: string[]): string {
  const others = memberNames.filter((n) => n && n !== 'local');
  if (others.length === 0) return 'no peer substrates on the relay';
  return `this substrate plus ${others.join(', ')} across the relay`;
}

/** Gaps tile caption: closes per day and the age of the oldest open gap. */
export function gapsCaption(closed24h: number, oldestOpenMs: number | null): string {
  const bits: string[] = [`${closed24h} closed in the last day`];
  if (oldestOpenMs !== null && Number.isFinite(oldestOpenMs)) {
    bits.push(`oldest open ${fmtDuration(oldestOpenMs)}`);
  }
  return bits.join(' · ');
}

/** Runners tile caption. */
export function runnersCaption(names: string[]): string {
  if (names.length === 0) return 'no executors visible';
  return `can run goals at the same time`;
}

/** Compact duration: 90000 → "2m", 7200000 → "2h", 172800000 → "2d". */
export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "as of" age note for cached aggregate narratives. */
export function asOfNote(asOfMs: number): string {
  const age = Date.now() - asOfMs;
  if (age < 90_000) return 'just now';
  return `${fmtDuration(age)} ago`;
}

/** Map a machine trigger (stamped by goal-host) to a human why-now phrase. */
function triggerPhrase(trigger: string): string {
  switch (trigger) {
    case 'operator': return 'Dispatched by an operator';
    case 'boredom': return 'Self-chosen — idle-time work it picked while free';
    case 'gap-closing': return 'Self-chosen — closing one of its own gaps';
    case 'gap-decompose': return 'Self-chosen — decomposing a gap it could not close directly';
    case 'recovery': return 'Recovery — retrying after an interruption or failure';
    case 'rhythm-due': return 'Self-chosen — a rhythm came due';
    case 'gap-drain': return 'Self-chosen — draining the gap backlog';
    case 'learning-mode': return 'Self-chosen — a learning-mode probe';
    default: return `Self-chosen — ${trigger}`;
  }
}

/** Derive why-now from the goal text when goal-host did not stamp a trigger. */
function inferTrigger(goal: string): string {
  const g = (goal || '').trim();
  let m: RegExpMatchArray | null;
  if ((m = g.match(/^Close substrate gap (\S+)/i))) return `Self-chosen — closing ${m[1]}`;
  if (/^investigate and decompose goal/i.test(g)) return 'Self-chosen — decomposing a gap it could not close directly';
  if (/grounding query failed/i.test(g)) return 'Recovery — retrying after a grounding-query miss';
  if (/^\([a-z_]+\)/i.test(g)) return 'Self-chosen — a self-audit probe';
  return 'Idle-time work — the substrate chose this while free';
}

/**
 * One-line narrative for a running fleet card: WHY-NOW (the trigger), then how it
 * is being run. Prefers the machine trigger goal-host stamps on the dispatch; falls
 * back to inferring it from the goal text when the trigger field is absent.
 */
export function runningNarrative(goal: string, d: { operator?: unknown; selectedTemplateId?: unknown; trigger?: unknown }): string {
  const op = typeof d.operator === 'string' ? d.operator : '';
  const trg = typeof d.trigger === 'string' && d.trigger ? d.trigger : '';
  const who = op
    ? `Dispatched by ${op}`
    : (trg ? triggerPhrase(trg) : inferTrigger(goal));
  const tmpl = typeof d.selectedTemplateId === 'string' && d.selectedTemplateId
    ? ` — running it as ${d.selectedTemplateId}`
    : ' — still choosing how to run it';
  return `${who}${tmpl}.`;
}
