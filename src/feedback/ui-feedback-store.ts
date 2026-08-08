/**
 * uiFeedback — complaint→improvement loop (Phase 2 of the UI workstream).
 *
 * Captures human legibility complaints about substrate UI surfaces, keyed by
 * the sub-* component grammar region they target, holds them in a bounded
 * in-memory store (served as the `obsidian:ui_feedback` read shape), and
 * forwards each complaint to the development-vessel gap store
 * (`substrateGap_write`) so it enters the gap → scenario → drafter funnel.
 */

import { sidecarResolveAuto } from '../sidecar-manager';
export type UiFeedbackSurface = 'panel' | 'goal-note' | 'improvement-note';

export type UiFeedbackKind =
  | 'hard_to_see'
  | 'hard_to_understand'
  | 'cramped'
  | 'wasted_space';

export const UI_FEEDBACK_KINDS: ReadonlySet<string> = new Set([
  'hard_to_see',
  'hard_to_understand',
  'cramped',
  'wasted_space',
]);

export interface UiFeedback {
  surface: UiFeedbackSurface;
  /** sub-* component class (e.g. "sub-card--fleet") or render_variant_id. */
  region: string;
  kind: UiFeedbackKind;
  prose?: string;
  vessel_id: string;
  created_at: string;
}

export interface ForwardResult {
  forwarded: boolean;
  status?: number | string;
  gapId?: string;
}

/** Bounded in-memory ring of captured complaints (newest last). */
export class UiFeedbackStore {
  private items: UiFeedback[] = [];

  constructor(private cap = 200) {}

  add(fb: UiFeedback): void {
    this.items.push(fb);
    if (this.items.length > this.cap) {
      this.items.splice(0, this.items.length - this.cap);
    }
  }

  list(opts?: { limit?: number; surface?: string; kind?: string }): UiFeedback[] {
    let rows = this.items;
    if (opts?.surface) rows = rows.filter((r) => r.surface === opts.surface);
    if (opts?.kind) rows = rows.filter((r) => r.kind === opts.kind);
    const limit = opts?.limit ?? 100;
    return rows.slice(-limit);
  }

  size(): number {
    return this.items.length;
  }
}

/**
 * Forward a captured complaint to the development-vessel gap store so it
 * enters the gap → scenario → drafter funnel.
 *
 * Contract (verified against dev-vessel resolvers, e.g.
 * db-contention-observer.ts): a shaped resolve of { type: "substrateGap_write",
 * gap: { id, category, source, summary, detected_at, status,
 *   classification_metadata } } routed through the single sidecar conduit.
 * Gap id key: `ui-feedback-<region>-<kind>` (stable per region+kind so
 * repeat complaints upsert rather than flood).
 */
/**
 * Which source file renders a given feedback surface.
 *
 * A ui-feedback gap carried `surface` + `region` but no EDIT SITE, and an edit goal is
 * only routable when something names a repos/<vessel>/src file. Measured on the live
 * gap store: 42% of open gaps carry an edit_site and 0% of ui_legibility gaps did, so
 * every interface complaint — human-reported here, and substrate-detected through the
 * identically-keyed ui_legibility_scan path — arrived unroutable. One sat open for
 * eight hours with nothing having attempted it.
 *
 * The mapping is static and checkable: the panel is one view class, and `region` is the
 * literal CSS class string the renderer passes to createDiv, so the localizer can find
 * the exact line by grepping the named file for the region. gap-to-feature reads
 * `classification_metadata.edit_site` first (its `metadata_edit_site` method), ahead of
 * its grep and LLM fallbacks — so naming the file here skips the guessing entirely.
 *
 * Surfaces with no single owning file are omitted rather than guessed: an absent
 * edit_site leaves the existing localizer fallbacks in play, whereas a WRONG one would
 * aim the drafter confidently at the wrong file.
 */
const SURFACE_SOURCE: Partial<Record<UiFeedbackSurface, string>> = {
  panel: 'repos/obsidian-vessel/src/views/goal-dispatch-view.ts',
};

export async function forwardUiFeedbackToGapStore(
  fb: UiFeedback,
): Promise<ForwardResult> {
  const slug = fb.region
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const gapId = `ui-feedback-${slug}-${fb.kind}`;
  const pointer = {
        type: 'substrateGap_write',
        gap: {
          id: gapId,
          category: 'ui_legibility',
          source: 'human_reported',
          summary: `UI feedback (${fb.kind}) on ${fb.surface} region ${fb.region}${fb.prose ? ': ' + fb.prose : ''}`,
          detected_at: fb.created_at,
          status: 'open',
          classification_metadata: {
            surface: fb.surface,
            region: fb.surface,
            kind: fb.kind,
            prose: fb.prose ?? null,
            vessel_id: fb.vessel_id,
            // Names the file that renders this surface so the gap is ROUTABLE as an
            // edit goal. Omitted when the surface has no single owning file — the
            // localizer's grep/LLM fallbacks then still apply, and a wrong edit_site
            // would be worse than none.
            ...(SURFACE_SOURCE[fb.surface] ? { edit_site: SURFACE_SOURCE[fb.surface] } : {}),
          },
        },
  };
  // Single conduit: route the shaped gap write over the federation sidecar
  // (/outbound/resolve) so it works on a spoke without a reachable dev-vessel
  // host:port. A null result means the sidecar is down and the write did not
  // land this attempt.
  const via = await sidecarResolveAuto(pointer, 15_000);
  if (via != null) {
    return { forwarded: true, status: 200, gapId };
  }
  return { forwarded: false, status: 'sidecar conduit unavailable', gapId };
}
