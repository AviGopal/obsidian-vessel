import { requestUrl } from 'obsidian';
import { sidecarResolveOutcome } from '../sidecar-manager';
/**
 * Solicitation manager (WS5: the human is a resolver).
 *
 * When goal-host's recovery loop is about to exhaust approaches it resolves
 * `human_input` via discovery; if this vault is present (WS4 advertisement)
 * the solicitation lands here as a POST /resolve { type: 'human_input' }.
 *
 * The resolver ACCEPTS immediately (the plugin HTTP server has a 30s request
 * timeout, so the answer cannot ride the resolve response). The pending
 * solicitation is held here, rendered as a card in the goal-dispatch panel,
 * and the human's outcome is POSTed back to goal-host via the
 * `solicitationResponse_write` shape. While the human is typing an answer,
 * `solicitationHeartbeat_write` keepalives EXTEND goal-host's deadline so the
 * system never acts before the human finishes composing.
 *
 * Outcome taxonomy (recorded by goal-host): answered / declined ("not now",
 * cheap, near-neutral) / insufficient_context (a RENDERING failure — the
 * solicitation body was not decision-ready) / timeout.
 */

export interface PendingSolicitation {
  solicitationId: string;
  dispatchId: string | null;
  questionMarkdown: string;
  timeoutMs: number;
  receivedAt: string; // ISO-8601
  status: 'pending' | 'answered' | 'declined' | 'insufficient_context' | 'expired';
}

export type SolicitationListener = (solicitations: PendingSolicitation[]) => void;

/** Minimum interval between typing heartbeats sent to goal-host. */
const HEARTBEAT_MIN_INTERVAL_MS = 30_000;

export class SolicitationManager {
  private pending = new Map<string, PendingSolicitation>();
  private listeners = new Set<SolicitationListener>();
  private lastHeartbeatAt = new Map<string, number>();
  private goalHostEndpoint: string;
  private apiKey: string;
  private notify: (message: string) => void;

  constructor(opts: { goalHostEndpoint: string; apiKey?: string; notify?: (message: string) => void }) {
    this.goalHostEndpoint = opts.goalHostEndpoint.replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? '';
    this.notify = opts.notify ?? (() => {});
  }

  /** Called by the human_input resolver on inbound solicitation. */
  accept(pointer: Record<string, unknown>): PendingSolicitation | null {
    const solicitationId = typeof pointer['solicitation_id'] === 'string' ? (pointer['solicitation_id'] as string) : null;
    const questionMarkdown = typeof pointer['question_markdown'] === 'string' ? (pointer['question_markdown'] as string) : '';
    if (!solicitationId || !questionMarkdown) return null;
    const sol: PendingSolicitation = {
      solicitationId,
      dispatchId: typeof pointer['dispatch_id'] === 'string' ? (pointer['dispatch_id'] as string) : null,
      questionMarkdown,
      timeoutMs: typeof pointer['timeout_ms'] === 'number' ? (pointer['timeout_ms'] as number) : 120_000,
      receivedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.pending.set(solicitationId, sol);
    this.emit();
    this.notify('The substrate is asking for your input — open the goal panel to answer.');
    return sol;
  }

  list(): PendingSolicitation[] {
    return [...this.pending.values()].filter((s) => s.status === 'pending');
  }

  subscribe(l: SolicitationListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    const snapshot = this.list();
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch {
        /* listeners never throw into the manager */
      }
    }
  }

  /**
   * Deliver a write shape to goal-host. Primary route: a shaped resolve
   * through the federation sidecar (crosses the overlay — the answer travels
   * even when goal-host is only libp2p-reachable). The direct goal-host
   * /resolve POST survives as an explicitly LOGGED fallback for sidecar-down
   * local setups (requestUrl, not fetch: the app://obsidian.md renderer is
   * CORS-blocked against vessels that serve no CORS headers).
   * Returns an HTTP-like status (0 on transport failure) so callers can
   * distinguish "solicitation gone server-side" (404) from unreachable.
   */
  private async post(shape: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
    const outcome = await sidecarResolveOutcome({ type: shape, ...body });
    if (outcome !== null) return { ok: outcome.ok, status: outcome.status };
    console.warn(`[SolicitationManager] sidecar resolve unavailable for ${shape} — engaging direct goal-host fallback`);
    try {
      const resp = await requestUrl({
        url: `${this.goalHostEndpoint}/resolve`,
        method: 'POST',
        throw: false,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ type: shape, ...body }),
      });
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /**
   * Typing heartbeat: call on every input event in the answer card. Throttled
   * to one POST per 30s per solicitation; goal-host extends its deadline on
   * each one (and never times out while composition continues, up to its cap).
   */
  heartbeat(solicitationId: string): void {
    const sol = this.pending.get(solicitationId);
    if (!sol || sol.status !== 'pending') return;
    const last = this.lastHeartbeatAt.get(solicitationId) ?? 0;
    if (Date.now() - last < HEARTBEAT_MIN_INTERVAL_MS) return;
    this.lastHeartbeatAt.set(solicitationId, Date.now());
    void this.post('solicitationHeartbeat_write', { solicitationId }).then((r) => {
      if (r.status === 404) this.expire(solicitationId);
    });
  }

  async respond(
    solicitationId: string,
    outcome: 'answered' | 'declined' | 'insufficient_context',
    answer?: string
  ): Promise<boolean> {
    const sol = this.pending.get(solicitationId);
    if (!sol || sol.status !== 'pending') return false;
    const r = await this.post('solicitationResponse_write', {
      solicitationId,
      outcome,
      ...(answer !== undefined ? { answer } : {}),
    });
    if (r.status === 404) {
      // Goal-host no longer holds this solicitation (the goal finished or
      // the solicitation timed out server-side) — the card is stale; drop it.
      this.expire(solicitationId);
      return false;
    }
    if (r.ok) {
      sol.status = outcome;
      this.pending.delete(solicitationId);
      this.lastHeartbeatAt.delete(solicitationId);
      this.emit();
    }
    return r.ok;
  }

  /** Drop a solicitation that is no longer answerable (gone server-side). */
  private expire(solicitationId: string): void {
    const sol = this.pending.get(solicitationId);
    if (!sol) return;
    sol.status = 'expired';
    this.pending.delete(solicitationId);
    this.lastHeartbeatAt.delete(solicitationId);
    this.emit();
  }

  /**
   * Reconcile pending cards against goal-host. A solicitation whose dispatch
   * has finished (goal completed/failed) or that goal-host has dropped is
   * gone server-side — the card must not linger. Called on an interval by
   * the goal-dispatch view.
   */
  async reconcile(): Promise<void> {
    for (const sol of [...this.pending.values()]) {
      if (sol.status !== 'pending') continue;
      if (sol.dispatchId) {
        // Primary: the goalWalkState shape over the sidecar (overlay-capable);
        // the direct /executions/:id GET survives as a LOGGED local fallback.
        const oc = await sidecarResolveOutcome({ type: 'goalWalkState', dispatchId: sol.dispatchId });
        if (oc !== null) {
          if (oc.status === 404) {
            this.expire(sol.solicitationId);
            continue;
          }
          const walkStatus = oc.ok && oc.body && typeof oc.body === 'object'
            ? String((oc.body as { status?: unknown }).status ?? '')
            : '';
          if (walkStatus && walkStatus !== 'running') {
            this.expire(sol.solicitationId);
          }
          continue;
        }
        console.warn('[SolicitationManager] sidecar resolve unavailable for goalWalkState — engaging direct goal-host fallback');
        try {
          const r = await requestUrl({
            url: `${this.goalHostEndpoint}/executions/${sol.dispatchId}`,
            method: 'GET',
            throw: false,
            headers: this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {},
          });
          const status = r.status === 200 ? ((r.json as { status?: string } | null)?.status ?? null) : null;
          if (r.status === 404 || (status !== null && status !== 'running')) {
            this.expire(sol.solicitationId);
            continue;
          }
        } catch { /* goal-host unreachable — keep the card, retry next sweep */ }
      } else {
        // No dispatch to check against: hard-expire after the advertised
        // timeout plus generous composing slack (heartbeats may have
        // extended goal-host's deadline beyond timeoutMs).
        const age = Date.now() - new Date(sol.receivedAt).getTime();
        if (age > sol.timeoutMs + 10 * 60_000) this.expire(sol.solicitationId);
      }
    }
  }

  updateEndpoint(goalHostEndpoint: string, apiKey?: string): void {
    this.goalHostEndpoint = goalHostEndpoint.replace(/\/+$/, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  clear(): void {
    this.pending.clear();
    this.lastHeartbeatAt.clear();
    this.emit();
  }
}
