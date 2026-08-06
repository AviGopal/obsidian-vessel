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

/**
 * Distinct vessels behind a registry listing, and where they live.
 *
 * The registry lists an ADVERTISEMENT, not a vessel, so the same process is
 * listed once per route it can be reached by: bare (resolved directly here),
 * again under this substrate's relay id, and again via the hub. Summing those
 * reports three times as many vessels as exist, and the total changes with the
 * route the panel resolved through — the number moves when the network moves,
 * which is exactly what it must not do. Identity is `name@home`, with a bare
 * name treated as living here.
 */
export function distinctVessels(
  vesselIds: string[],
  selfHomeLabel = 'here',
): { total: number; byHome: Array<{ home: string; count: number }> } {
  // Group advertisements by vessel NAME first.
  const homesByName = new Map<string, Set<string>>();
  const bareNames = new Set<string>();
  for (const raw of vesselIds) {
    const id = String(raw || '').trim();
    if (!id) continue;
    const at = id.indexOf('@');
    if (at < 0) { bareNames.add(id); continue; }
    const name = id.slice(0, at);
    const home = id.slice(at + 1);
    if (!home) { bareNames.add(name); continue; }
    if (!homesByName.has(name)) homesByName.set(name, new Set());
    homesByName.get(name)!.add(home);
  }
  // A bare advertisement is the SAME vessel as one of the homed ones — it is
  // this substrate resolving the vessel directly instead of through the relay.
  // We cannot tell which home it is without a self-id we do not reliably have,
  // and we do not need to: if the name is advertised from any home, the bare
  // listing is a duplicate route to one of them, not an extra vessel. Only a
  // name that appears bare and nowhere else is a vessel we know solely from
  // here.
  const counts = new Map<string, number>();
  let total = 0;
  for (const [, homes] of homesByName) {
    for (const h of homes) counts.set(h, (counts.get(h) ?? 0) + 1);
    total += homes.size;
  }
  const bareOnly = [...bareNames].filter((n) => !homesByName.has(n));
  if (bareOnly.length > 0) {
    counts.set(selfHomeLabel, (counts.get(selfHomeLabel) ?? 0) + bareOnly.length);
    total += bareOnly.length;
  }
  return {
    total,
    byHome: [...counts.entries()]
      .map(([home, count]) => ({ home, count }))
      .sort((a, b) => b.count - a.count || a.home.localeCompare(b.home)),
  };
}

/** Vessels tile caption — says where they are, not just how many. */
export function vesselsCaption(count: number, byHome?: Array<{ home: string; count: number }>): string {
  if (count <= 0) return 'none visible in discovery right now';
  if (!byHome || byHome.length === 0) return 'all advertising into discovery';
  // Naming the split is what makes the number the same fact from any route.
  const parts = byHome.map((h) => `${h.count} ${h.home === 'here' ? 'here' : `on ${h.home}`}`);
  return `distinct vessels advertising into discovery — ${parts.join(' · ')}`;
}

export interface FleetMember {
  substrate?: string;
  role?: string;
  vesselCount?: number | null;
  reachable?: boolean;
  dispatches?: unknown;
  [k: string]: unknown;
}

/**
 * Collapse federation members that are the same substrate seen by more than one
 * route.
 *
 * The feed identifies a member by whatever name the route happened to carry, so
 * one substrate can arrive three times — once as `local` (resolved directly),
 * once as its relay id (`spoke-…`, the same box seen through the hub), and once
 * as a bare `host:port` (a peer known only by address). Counting those as three
 * peers is wrong everywhere, and wrong differently depending on which network
 * the panel is on.
 *
 * Identity is decided by EVIDENCE, not by name: two members reporting the same
 * dispatch id are the same substrate, because a dispatch id is minted once by
 * the goal-host that owns it. That test holds regardless of how the deployment
 * is named or addressed. Names are only used afterwards, to choose the label a
 * human will recognise.
 */
export function dedupeMembers(members: FleetMember[]): FleetMember[] {
  const list = members.filter((m) => m && typeof m === 'object');
  const idsOf = (m: FleetMember): Set<string> => new Set(
    (Array.isArray(m.dispatches) ? m.dispatches : [])
      .map((x) => String((x as Record<string, unknown>)?.dispatchId ?? ''))
      .filter(Boolean),
  );
  const groups: Array<{ members: FleetMember[]; ids: Set<string> }> = [];
  for (const m of list) {
    const ids = idsOf(m);
    const hit = groups.find((g) => [...ids].some((i) => g.ids.has(i)));
    if (hit && ids.size > 0) {
      hit.members.push(m);
      ids.forEach((i) => hit.ids.add(i));
    } else {
      groups.push({ members: [m], ids });
    }
  }
  // Prefer a name a human can place: never a bare address, and never the
  // opaque relay id when a friendlier name for the same box exists.
  const isAddr = (s: string): boolean => /:\d+$/.test(s) || /^\d+\.\d+\.\d+\.\d+/.test(s);
  const collapsed = groups.map((g) => {
    const names = g.members.map((m) => String(m.substrate ?? '')).filter(Boolean);
    const preferred = names.find((n) => n === 'local')
      ?? names.find((n) => !isAddr(n) && !/^spoke-/.test(n))
      ?? names.find((n) => !isAddr(n))
      ?? names[0] ?? 'unknown';
    const merged: FleetMember = { ...g.members[0] };
    merged.substrate = preferred;
    merged.role = g.members.map((m) => m.role).find((r) => typeof r === 'string' && r) as string | undefined;
    merged.vesselCount = g.members
      .map((m) => (typeof m.vesselCount === 'number' ? m.vesselCount : null))
      .reduce<number | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
    merged.reachable = g.members.some((m) => m.reachable !== false);
    // Keep every distinct dispatch across the routes this member was seen on.
    const byId = new Map<string, unknown>();
    for (const m of g.members) {
      for (const x of (Array.isArray(m.dispatches) ? m.dispatches : [])) {
        byId.set(String((x as Record<string, unknown>)?.dispatchId ?? Math.random()), x);
      }
    }
    merged.dispatches = [...byId.values()];
    // Record the other names so the UI can show that this is one box, not many.
    merged.aliases = names.filter((n) => n !== preferred);
    return merged;
  });

  // Second pass: a member known ONLY by an address, reporting no work of its
  // own, is a routing entry rather than a distinct peer — it is how we reach
  // some substrate, not another substrate. Fold it into the named member that
  // fills the same role (that is the box it addresses), keeping whatever facts
  // it carried. Without this, one hub reached by name and by address counts as
  // two peers, and the count changes with the network the panel sits on.
  const addressOnly = collapsed.filter(
    (m) => isAddr(String(m.substrate ?? '')) && (m.dispatches as unknown[]).length === 0,
  );
  if (addressOnly.length === 0) return collapsed;
  const named = collapsed.filter((m) => !addressOnly.includes(m));
  for (const addr of addressOnly) {
    const host = named.find((m) => m.role && m.role === addr.role)
      ?? named.find((m) => String(m.substrate ?? '') !== 'local');
    if (!host) continue;
    host.role = host.role ?? addr.role;
    if (typeof addr.vesselCount === 'number' && (host.vesselCount ?? 0) < addr.vesselCount) {
      host.vesselCount = addr.vesselCount;
    }
    host.aliases = [...(Array.isArray(host.aliases) ? host.aliases : []), String(addr.substrate ?? '')];
  }
  // Any address-only member with nowhere to fold into is still shown, but the
  // caption must not read its address as if it were a name.
  return [...named, ...addressOnly.filter((a) => !named.some((n) =>
    (Array.isArray(n.aliases) ? n.aliases : []).includes(String(a.substrate ?? ''))))];
}

/** Peers tile caption from federation member names: "this substrate plus syzygy-hub across the relay". */
export function peersCaption(
  members: Array<{ substrate?: string; role?: string; vesselCount?: number | null; reachable?: boolean }>,
): string {
  const others = members.filter((m) => m && m.substrate && m.substrate !== 'local');
  if (others.length === 0) return 'no peer substrates on the relay';
  const isAddr = (s: string): boolean => /:\d+$/.test(s) || /^\d+\.\d+\.\d+\.\d+/.test(s);
  const parts = others.map((m) => {
    const name = String(m.substrate);
    // An address is where a peer is, not who it is. Say so, rather than
    // printing a host:port where a reader expects a substrate name.
    const bits: string[] = [isAddr(name) ? `an unnamed substrate at ${name}` : name];
    if (m.role === 'resolver-hub') bits.push('resolver hub');
    // Deliberately NOT the peer's vessel count: that number is a count of
    // advertisements, and printing it beside the vessels tile — which counts
    // distinct vessels — puts two different numbers for "how many vessels" on
    // screen at once. The tile owns that question.
    if (m.reachable === false) bits.push('unreachable');
    return bits.join(' · ');
  });
  return `this substrate plus ${parts.join('; ')} across the relay`;
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
    case 'note': return 'From your vault — picked up from a note you wrote';
    case 'convergent-enabler': return 'Self-chosen — convergent enabler work it runs on a cadence to keep the fleet productive';
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

// ─────────────────────────────────────────────────────────────────────────────
// Self-explanation — the four human questions for an expanded dispatch:
// why-chosen · what-happened · what-it-means · what-next. All assembled from
// fields the goalWalkState body already carries (walkLog, goalReachReason,
// learning, trigger, requeueOf). The substrate is a mix of mechanisms, but every
// decision it made is recorded — these read that record back as plain language.
// ─────────────────────────────────────────────────────────────────────────────

/** Pull the goal-target inference the walk logged (what it read the goal as needing). */
export function parseInference(
  walkLog: string[],
): { shapes: string[]; confidence?: number; alternatives: string[] } | null {
  for (const line of walkLog) {
    const i = line.indexOf('goal-target inference');
    if (i < 0) continue;
    const brace = line.indexOf('{', i);
    if (brace < 0) continue;
    try {
      const obj = JSON.parse(line.slice(brace)) as {
        inferred_target_shapes?: unknown; confidence?: unknown; alternatives?: unknown;
      };
      const shapes = Array.isArray(obj.inferred_target_shapes)
        ? obj.inferred_target_shapes.map(String) : [];
      const alternatives = Array.isArray(obj.alternatives)
        ? (obj.alternatives as unknown[]).flat().map(String) : [];
      return { shapes, confidence: typeof obj.confidence === 'number' ? obj.confidence : undefined, alternatives };
    } catch { return null; }
  }
  return null;
}

/** WHY-CHOSEN: the origin (operator vs which self-trigger) + what the walk read the goal as needing. */
export function whyChosenSentence(
  d: { trigger?: unknown; operator?: unknown },
  walkLog: string[],
): string {
  const op = typeof d.operator === 'string' && d.operator ? d.operator : '';
  const trg = typeof d.trigger === 'string' && d.trigger ? d.trigger : '';
  const origin = op
    ? `You dispatched this (as ${op}).`
    : trg ? `${triggerPhrase(trg)}.` : 'Picked up by the substrate.';
  const inf = parseInference(walkLog);
  if (!inf || inf.shapes.length === 0) return origin;
  const conf = typeof inf.confidence === 'number'
    ? (inf.confidence >= 0.95 ? ' (confident)' : inf.confidence >= 0.7 ? ' (fairly sure)' : ' (a low-confidence guess)')
    : '';
  let s = `${origin} It read the goal as needing «${inf.shapes[0]}»${conf}.`;
  const alts = inf.alternatives.filter((a) => !inf.shapes.includes(a)).slice(0, 3);
  if (alts.length) {
    s += ` It also weighed ${alts.map((a) => `«${a}»`).join(', ')} and set ${alts.length === 1 ? 'it' : 'them'} aside.`;
  }
  return s;
}

/** WHAT-IT-MEANS: interpret a non-reach into a plain failure meaning. Empty string when reached. */
export function failureMeaningSentence(
  reached: boolean | null | undefined,
  goalReachReason: string,
  walkLog: string[],
): string {
  if (reached !== false) return '';
  // Classify primarily off the TERMINAL reason (goalReachReason) — the whole
  // walkLog contains a "HOLLOW" token on nearly every non-reach, so scanning it
  // wholesale drowns out the true cause. Fall back to the log only when the
  // terminal reason is silent.
  const reason = (goalReachReason || '').toLowerCase();
  const log = walkLog.join(' \n ').toLowerCase();
  const inReason = (...xs: string[]): boolean => xs.some((x) => reason.includes(x));
  const inAny = (...xs: string[]): boolean => xs.some((x) => reason.includes(x) || log.includes(x));
  const INFRA = 'What this means: a service it depended on (usually the LLM plane) was briefly unavailable — a transient infrastructure failure, not a logic error. Worth retrying.';
  const BUDGET = 'What this means: it hit a cost/budget ceiling before it could finish.';
  const NOPROD = 'What this means: nothing in the fleet can produce what this needs yet — a missing capability, not a crash. A new resolver or activity has to exist before it can succeed.';
  const HOLLOW = 'What this means: it ran, but the result came back empty or incomplete — the reach-gate refused to rubber-stamp a hollow answer. The capability may exist but had no data to fill it.';
  const WRONG = 'What this means: it produced output, but the reach-gate judged it did not actually answer what was asked.';
  // infra + budget are unambiguous wherever they appear.
  if (inAny('llm fetch 5', ' 502', ' 503', 'timeout', 'econn', 'unreachable — verdict')) return INFRA;
  if (inAny('budget', 'cost ceiling', 'budget_exhausted')) return BUDGET;
  // the terminal reason decides the rest.
  if (inReason('no producer', 'no constructible', 'missing_input', 'resolver_not_registered')) return NOPROD;
  if (inReason('does not', 'did not', 'wrong', 'incorrect', 'placeholder', 'staged-not-landed', 'mismatch')) return WRONG;
  if (inReason('content is empty', 'empty', 'no output', 'no-output', 'hollow', 'seed-only')) return HOLLOW;
  // reason was silent — fall back to the walk log.
  if (inAny('no producer', 'no constructible')) return NOPROD;
  if (inAny('hollow', 'empty', 'no output')) return HOLLOW;
  return goalReachReason
    ? `What this means: ${goalReachReason}`
    : 'What this means: the goal was not reached; no specific reason was recorded.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution path — WHICH mechanism resolved this goal.
//
// The substrate resolves a goal in five substantively different ways, and they
// leave different evidence behind. Rendering all five as if they were a
// shape-graph walk is why a satisfier resolve showed a "decision tree" for
// something that never executed, and why a landed code edit showed shape-flow
// chips instead of its commit. The path is therefore the FIRST thing the reader
// is told, and it decides what the rest of the view shows.
// ─────────────────────────────────────────────────────────────────────────────

export type ResolutionPath =
  | 'feature_compose'
  | 'command_reuse'
  | 'satisfier'
  | 'fresh_derivation'
  | 'universal_tool_fallback'
  | 'unknown';

export interface ResolutionVerdict {
  path: ResolutionPath;
  /** 'stated' = goal-host classified it; 'inferred' = we worked it out here. */
  basis: 'stated' | 'inferred';
  /** What we keyed off, so a wrong label is debuggable rather than mysterious. */
  evidence: string;
}

/**
 * Decide which of the five mechanisms resolved a goal.
 *
 * Prefers goal-host's own `executionPath`. Falls back to inference for records
 * written before that field existed — and the fallback is honest about being a
 * fallback, because a confidently-wrong label is worse than an admitted guess.
 */
export function resolutionPath(
  body: Record<string, unknown>,
  d: Record<string, unknown> = {},
): ResolutionVerdict {
  const stated = typeof body.executionPath === 'string' ? body.executionPath : '';
  const VALID: ResolutionPath[] = [
    'feature_compose', 'command_reuse', 'satisfier', 'fresh_derivation', 'universal_tool_fallback',
  ];
  if (VALID.includes(stated as ResolutionPath)) {
    return { path: stated as ResolutionPath, basis: 'stated', evidence: 'classified by goal-host' };
  }

  const exec = String(body.executionId ?? d.executionId ?? '');
  const tid = String(body.selectedTemplateId ?? d.selectedTemplateId ?? '');
  const steps = Array.isArray(body.steps) ? (body.steps as Array<Record<string, unknown>>) : [];
  const sourcesOf = (s: Record<string, unknown>): string =>
    String((s.selected as Record<string, unknown> | undefined)?.source ?? '');

  if (tid === 'feature_compose' || exec.startsWith('feature_compose:')) {
    return { path: 'feature_compose', basis: 'inferred', evidence: 'the execution id names a feature_compose edit' };
  }
  if (exec.startsWith('universal-tool-fallback:') || tid === 'universal-tool-fallback') {
    return { path: 'universal_tool_fallback', basis: 'inferred', evidence: 'the execution id names the tool-loop floor' };
  }
  if (tid.startsWith('satisfier:')) {
    return { path: 'satisfier', basis: 'inferred', evidence: 'the selected template is a satisfier resolve' };
  }
  if (steps.length > 0 && steps.every((s) => sourcesOf(s) === 'satisfier')) {
    return { path: 'satisfier', basis: 'inferred', evidence: 'every step was a direct vessel resolve' };
  }
  if (steps.length > 0) {
    return { path: 'fresh_derivation', basis: 'inferred', evidence: `${steps.length} walk step${steps.length === 1 ? '' : 's'} were selected` };
  }
  const tier = String(body.walkTier ?? '');
  if (VALID.includes(tier as ResolutionPath)) {
    return { path: tier as ResolutionPath, basis: 'inferred', evidence: 'from the walk tier' };
  }
  return { path: 'unknown', basis: 'inferred', evidence: 'nothing on the record identifies how this ran' };
}

/**
 * The outcome of a direct edit, read out of the execution id. goal-host encodes
 * it there and nowhere structured: `feature_compose:<sha>` when the edit landed,
 * `feature_compose:rejected:<hash>:<n>` when it was refused.
 */
export function featureComposeOutcome(
  executionId: string,
): { landed: boolean; sha?: string; rejectedTag?: string } | null {
  const id = String(executionId || '');
  if (!id.startsWith('feature_compose:')) return null;
  const rest = id.slice('feature_compose:'.length);
  if (rest.startsWith('rejected:')) return { landed: false, rejectedTag: rest.slice('rejected:'.length) };
  return /^[0-9a-f]{7,40}$/i.test(rest) ? { landed: true, sha: rest } : { landed: false };
}

/** What this mechanism IS, and what it means that this goal took it. */
export function resolvedBySentence(v: ResolutionVerdict, body: Record<string, unknown> = {}): string {
  const steps = Array.isArray(body.steps) ? (body.steps as unknown[]).length : 0;
  switch (v.path) {
    case 'feature_compose': {
      const outcome = featureComposeOutcome(String(body.executionId ?? ''));
      const tail = outcome?.landed
        ? ` The edit landed as commit ${outcome.sha!.slice(0, 10)}.`
        : outcome
          ? ' The edit was drafted but refused before landing.'
          : '';
      return `A direct code edit. The goal named a source file, so it was routed straight to the drafter — it never entered the shape-graph walk, which is why there are no walk steps to show.${tail}`;
    }
    case 'command_reuse':
      return 'Reuse of a command this substrate had already run successfully for a goal like this one, re-aligned to the current inputs rather than re-derived.';
    case 'satisfier':
      return 'Answered directly. A connected vessel already produces the shape this goal needed, so it was resolved in place — nothing was selected and nothing executed. There is no decision to inspect because no decision was needed.';
    case 'fresh_derivation':
      return `Derived from scratch. No learned pathway covered this goal, so the walk chained backwards over the shape graph, choosing each step by its learned odds${steps ? ` — ${steps} step${steps === 1 ? '' : 's'}, all shown below with the rivals each one beat` : ''}.`;
    case 'universal_tool_fallback':
      return 'The tool loop — the execution floor. Nothing in the fleet covered this goal, so it fell back to reason/act/observe over raw tools. This is the guaranteed-parity path, not a learned one: reaching here means the substrate had nothing better.';
    default:
      return 'How this goal was resolved was never recorded. That absence is itself worth reporting — it means the run cannot be attributed to any mechanism.';
  }
}

/** Short label for the path chip. */
export function resolvedByLabel(path: ResolutionPath): string {
  return ({
    feature_compose: 'direct code edit',
    command_reuse: 'reused a known command',
    satisfier: 'answered directly',
    fresh_derivation: 'derived from scratch',
    universal_tool_fallback: 'tool loop (floor)',
    unknown: 'unrecorded',
  } as Record<ResolutionPath, string>)[path];
}

/**
 * A human-distinguishable label for a dispatch row.
 *
 * Many dispatches arrive with no goal text at all, and a list of rows that all
 * read "(no goal)" is unusable — you cannot find the run you were just looking
 * at, and you cannot tell two of them apart to decide which to open. Fall back
 * to what IS known about the row (the activity it ran as, and why it was
 * picked) and say explicitly that the goal text is the part that is missing,
 * since a dispatch arriving without one is itself a defect worth seeing.
 */
export function dispatchLabel(d: {
  goal?: unknown; selectedTemplateId?: unknown; trigger?: unknown; executionId?: unknown;
}): string {
  const goal = typeof d.goal === 'string' ? d.goal.trim() : '';
  if (goal) return goal;
  const tid = typeof d.selectedTemplateId === 'string' && d.selectedTemplateId ? d.selectedTemplateId : '';
  const trg = typeof d.trigger === 'string' && d.trigger ? d.trigger : '';
  const exec = typeof d.executionId === 'string' && d.executionId ? d.executionId : '';
  const bits = [tid, trg].filter(Boolean).join(' · ');
  if (bits) return `${bits} — dispatched with no goal text`;
  if (exec) return `${exec} — dispatched with no goal text`;
  return 'dispatched with no goal text';
}

/**
 * What this run taught the system, in plain language — including the case where
 * it taught nothing. A run that moved no posterior, filed no gap and wrote no
 * oracle label is invisible to the learning loop, and that is exactly the fact
 * an operator needs surfaced: silence here means the execution was spent
 * without being converted into anything the substrate can reuse.
 */
export function learningOutcomeSentence(
  learning: { alphaBetaDelta?: unknown; oracleLabelWritten?: unknown; gapsFiled?: unknown } | null,
): string {
  if (!learning || typeof learning !== 'object') {
    return 'Nothing was recorded about what this run taught the system — the learning fields are absent, so it cannot be credited or penalised.';
  }
  const deltas = Array.isArray(learning.alphaBetaDelta) ? learning.alphaBetaDelta.length : 0;
  const gaps = Array.isArray(learning.gapsFiled) ? learning.gapsFiled.length : 0;
  const oracle = learning.oracleLabelWritten === true;
  if (deltas === 0 && gaps === 0 && !oracle) {
    return 'This run taught the system nothing: no selection posterior moved, no gap was filed, and no oracle label was written. The work was spent without being converted into anything reusable — if you think the verdict is wrong, your grade below is the only signal that will correct it.';
  }
  const bits: string[] = [];
  if (deltas > 0) bits.push(`updated the odds on ${deltas} pick${deltas === 1 ? '' : 's'}`);
  if (gaps > 0) bits.push(`filed ${gaps} gap${gaps === 1 ? '' : 's'} for the backlog`);
  if (oracle) bits.push('wrote an oracle label for future grading');
  return `This run ${bits.join(', ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict derivation — the chain a human needs to audit a reach verdict:
// what was asked for → what ran → what it produced → what the gate required →
// which rule fired → therefore reached / not reached. Every link is read back
// out of the walk record; nothing here is inferred by an LLM. When a link is
// genuinely absent the step says so, because "nothing was recorded here" is
// itself the finding a human most needs to see.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerdictStep {
  /** Short ordinal label, e.g. "Asked for". */
  label: string;
  /** Plain-language prose for this link in the chain. */
  text: string;
  /** Rendering tone — 'bad' marks the link where the verdict was decided. */
  tone?: 'ok' | 'warn' | 'bad';
}

/**
 * Parse the reach-gate line goal-host writes as the terminal walk decision, e.g.
 *   "goal-reach(/run-goal) attempt 1/1: HOLLOW (declarative): declarative: missing activityTemplate,learningSummary"
 * Returns the gate's own verdict tokens so the panel can explain the rule that
 * fired rather than echoing the machine string at the human.
 */
export function parseReachGate(
  walkLog: string[],
  currentStep: string,
): { outcome: string; mode: string; missing: string[]; attempt: string } | null {
  const candidates = [currentStep, ...[...walkLog].reverse()].filter((s): s is string => typeof s === 'string' && !!s);
  for (const raw of candidates) {
    if (!/goal-reach/i.test(raw)) continue;
    const outcome = (raw.match(/:\s*(HOLLOW|REACHED|NOT[_ ]REACHED|WRONG|EMPTY)\b/i)?.[1] ?? '').toUpperCase();
    if (!outcome) continue;
    const mode = raw.match(/\((declarative|imperative|judged|deterministic)\)/i)?.[1]?.toLowerCase() ?? '';
    const missing = (raw.match(/missing\s+([A-Za-z0-9_,\s]+)/i)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const attempt = raw.match(/attempt\s+(\d+\/\d+)/i)?.[1] ?? '';
    return { outcome, mode, missing, attempt };
  }
  return null;
}

/**
 * The full audit chain for a settled walk, as ordered plain-language steps.
 * Rendered as the "How this verdict was reached" block — the surface a human
 * grades the grader from.
 */
export function verdictDerivation(
  body: Record<string, unknown>,
  d: Record<string, unknown>,
): VerdictStep[] {
  const walkLog = Array.isArray(body.walkLog) ? (body.walkLog as unknown[]).map(String) : [];
  const currentStep = typeof body.currentStep === 'string' ? body.currentStep : '';
  const steps = Array.isArray(body.steps) ? (body.steps as unknown[]) : [];
  const pool = Array.isArray(body.poolShapes) ? (body.poolShapes as unknown[]).map(String) : [];
  const prov = Array.isArray(body.poolProvenance) ? (body.poolProvenance as unknown[]) : [];
  const pending = Array.isArray(body.pendingTargets) ? (body.pendingTargets as unknown[]).map(String) : [];
  const reached = (body.reached ?? d.reached) as boolean | null | undefined;
  const answer = typeof body.answerBody === 'string' ? body.answerBody.trim() : '';
  const out: VerdictStep[] = [];

  // 1. What the walk understood the goal to require. Prefer the walk's own
  // recorded inference; fall back to the shapes the reach gate went on to
  // demand, which is the same requirement observed one step later.
  const gateEarly = parseReachGate(walkLog, currentStep);
  const inf = parseInference(walkLog);
  if (inf && inf.shapes.length) {
    const conf = typeof inf.confidence === 'number'
      ? ` It was ${inf.confidence >= 0.95 ? 'confident' : inf.confidence >= 0.7 ? 'fairly sure' : 'only ' + Math.round(inf.confidence * 100) + '% sure'} of that reading.`
      : '';
    out.push({
      label: 'Asked for',
      text: `To count as done, this goal had to produce «${inf.shapes.join('», «')}».${conf}`,
    });
  } else if (gateEarly && gateEarly.missing.length) {
    out.push({
      label: 'Asked for',
      text: `The walk never logged how it read this goal, but the reach gate went on to require «${gateEarly.missing.join('», «')}» — so that is what it was being held to.`,
      tone: 'warn',
    });
  } else {
    out.push({
      label: 'Asked for',
      text: 'The walk never recorded what shapes this goal needed to produce, so there was no explicit target to aim at.',
      tone: 'warn',
    });
  }

  // 2. What actually ran.
  if (steps.length > 0) {
    out.push({
      label: 'Ran',
      text: `It took ${steps.length} step${steps.length === 1 ? '' : 's'} — each one listed in the decision tree below, with the rivals it beat and why.`,
    });
  } else {
    out.push({
      label: 'Ran',
      text: 'It took no steps at all. Nothing was selected and nothing executed — so there was never any work for the gate to judge.',
      tone: 'bad',
    });
  }

  // 3. What it produced.
  if (answer) {
    out.push({ label: 'Produced', text: `A written answer of ${answer.length} characters, shown above.`, tone: 'ok' });
  } else if (prov.length > 0 || pool.length > 0) {
    const n = Math.max(pool.length, prov.length);
    const named = pool.length ? ` (${pool.join(', ')})` : '';
    // Say plainly when the pool holds more shapes than the ledger can show the
    // content of — otherwise the count and the list disagree on screen.
    const gap = pool.length > prov.length && prov.length > 0
      ? ` Content was captured for ${prov.length} of them.`
      : prov.length === 0 ? ' No content was captured for them, so there is nothing to read back.' : '';
    out.push({
      label: 'Produced',
      text: `${n} shape${n === 1 ? '' : 's'} landed in the pool${named}.${gap} What they actually contain is in the evidence ledger — judge the verdict against that, not against the status.`,
      tone: 'ok',
    });
  } else {
    out.push({
      label: 'Produced',
      text: 'Nothing. The shape pool ended empty — no output was ever created for this goal.',
      tone: 'bad',
    });
  }

  // 4. The rule that decided it.
  const gate = parseReachGate(walkLog, currentStep);
  if (gate) {
    const modePhrase = gate.mode === 'declarative'
      ? 'a declarative check — it compares what landed in the pool against the shapes the goal declared it needed, with no LLM judgement involved'
      : gate.mode === 'judged'
        ? 'an LLM judge reading the output against the goal'
        : gate.mode ? `a ${gate.mode} check` : 'the reach gate';
    const missPhrase = gate.missing.length
      ? ` It required «${gate.missing.join('», «')}», and ${gate.missing.length === 1 ? 'that shape was never produced' : 'none of those shapes were produced'}.`
      : '';
    const attemptPhrase = gate.attempt && gate.attempt !== '1/1'
      ? ` This was attempt ${gate.attempt}.`
      : gate.attempt === '1/1' ? ' It got a single attempt — no retry was configured.' : '';
    out.push({
      label: 'Judged by',
      text: `${modePhrase}.${missPhrase}${attemptPhrase}`,
      tone: gate.outcome === 'REACHED' ? 'ok' : 'warn',
    });
    out.push({
      label: 'Therefore',
      text: gate.outcome === 'REACHED'
        ? 'The gate found everything the goal declared it needed, so the verdict is reached.'
        : `The gate returned ${gate.outcome}, which means the required shapes were absent or empty. That is why the verdict is not reached — the gate refused to call an empty result done.`,
      tone: gate.outcome === 'REACHED' ? 'ok' : 'bad',
    });
    return out;
  }

  // 4b. No gate line — say so rather than implying one ran.
  if (pending.length) {
    out.push({
      label: 'Still missing',
      text: `«${pending.join('», «')}» were still outstanding when the walk stopped.`,
      tone: 'warn',
    });
  }
  const reason = typeof body.goalReachReason === 'string' ? body.goalReachReason : '';
  out.push({
    label: 'Therefore',
    text: reached === true
      ? `The verdict is reached${reason ? ` — ${reason}.` : ', though no explicit gate decision was recorded for it.'}`
      : reached === false
        ? `The verdict is not reached${reason ? ` — ${reason}.` : ', but no gate decision was recorded explaining which rule failed. That missing record is itself worth flagging.'}`
        : 'No verdict was recorded for this walk at all — it settled without the reach gate ever running.',
    tone: reached === true ? 'ok' : 'bad',
  });
  return out;
}

/** WHAT-NEXT: the disposition — what the system did / will do after a non-reach. gaps are ids to link. */
export function dispositionSentence(
  reached: boolean | null | undefined,
  learning: { gapsFiled?: unknown } | null,
  requeueOf: unknown,
  walkLog: string[],
): { text: string; gaps: string[] } {
  if (reached === true) return { text: '', gaps: [] };
  const log = walkLog.join(' \n ').toLowerCase();
  const gaps = Array.isArray(learning?.gapsFiled)
    ? Array.from(new Set((learning as { gapsFiled?: unknown[] }).gapsFiled!.filter((g): g is string => typeof g === 'string')))
    : [];
  if (gaps.length) {
    return {
      text: `What happens now: recorded as ${gaps.length === 1 ? 'a capability gap' : 'capability gaps'} — it will be worked from the gap backlog, not silently retried the same way. It also down-weighted the picks that came back empty, so they are less likely to be chosen next time.`,
      gaps,
    };
  }
  if (typeof requeueOf === 'string' && requeueOf) return { text: 'What happens now: requeued to try again once.', gaps: [] };
  if (log.includes('requeued')) return { text: 'What happens now: requeued to retry.', gaps: [] };
  if (log.includes('investigate-and-decompose') || log.includes('escalating to') || log.includes('escalated_from') || log.includes('decompose'))
    return { text: 'What happens now: escalated to break the goal into smaller pieces it can attempt.', gaps: [] };
  if (reached === false) return { text: 'What happens now: no automatic follow-up was recorded — this one needs a human or a fresh goal to move it forward.', gaps: [] };
  return { text: '', gaps: [] };
}
