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
import { requestUrl } from 'obsidian';
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
  const slug = fb.region
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const gapId = `ui-feedback-${slug}-${fb.kind}`;
  const url = `${devVesselEndpoint.replace(/\/+$/, '')}/v2/impulses/resolve`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `ApiKey ${apiKey}`;
  }
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
            region: fb.region,
            kind: fb.kind,
            prose: fb.prose ?? null,
            vessel_id: fb.vessel_id,
          },
        },
  };
  // Overlay-first: route the shaped gap write over the federation sidecar
  // (/outbound/resolve) so it works on a spoke without a reachable dev-vessel
  // host:port; fall back to the direct endpoint only when the sidecar is down.
  const via = await sidecarResolveAuto(pointer, 15_000);
  if (via != null) {
    return { forwarded: true, status: 200, gapId };
  }
  const body = JSON.stringify({ impulse: { pointer } });
  try {
    const resp = await requestUrl({
      url,
      method: 'POST',
      headers,
      body,
      throw: false,
    });
    return { forwarded: resp.status < 300, status: resp.status, gapId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { forwarded: false, status: message, gapId };
  }
}
