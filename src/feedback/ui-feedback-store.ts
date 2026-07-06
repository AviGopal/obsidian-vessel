/**
 * uiFeedback — complaint→improvement loop (Phase 2 of the UI workstream).
 *
 * Captures human legibility complaints about substrate UI surfaces, keyed by
 * the sub-* component grammar region they target, holds them in a bounded
 * in-memory store (served as the `obsidian:ui_feedback` read shape), and
 * forwards each complaint to the development-vessel gap store
 * (`substrateGap_write`) so it enters the gap → scenario → drafter funnel.
 */

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
 * db-contention-observer.ts): POST {devVesselEndpoint}/v2/impulses/resolve
 * with envelope { impulse: { pointer: { type: "substrateGap_write", gap:
 * { id, category, source, summary, detected_at, status,
 *   classification_metadata } } } }.
 * Gap id key: `ui-feedback-<region>-<kind>` (stable per region+kind so
 * repeat complaints upsert rather than flood).
 *
 * STUB: implementation is authored by the substrate (feature_compose).
 */
export async function forwardUiFeedbackToGapStore(
  fb: UiFeedback,
  devVesselEndpoint: string,
  apiKey?: string,
): Promise<ForwardResult> {
  void fb;
  void devVesselEndpoint;
  void apiKey;
  return { forwarded: false, status: 'not_implemented' };
}
