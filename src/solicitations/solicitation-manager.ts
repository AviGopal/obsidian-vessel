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

  private async post(shape: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      const resp = await fetch(`${this.goalHostEndpoint}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ type: shape, ...body }),
      });
      return resp.ok;
    } catch {
      return false;
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
    void this.post('solicitationHeartbeat_write', { solicitationId });
  }

  async respond(
    solicitationId: string,
    outcome: 'answered' | 'declined' | 'insufficient_context',
    answer?: string
  ): Promise<boolean> {
    const sol = this.pending.get(solicitationId);
    if (!sol || sol.status !== 'pending') return false;
    const ok = await this.post('solicitationResponse_write', {
      solicitationId,
      outcome,
      ...(answer !== undefined ? { answer } : {}),
    });
    if (ok) {
      sol.status = outcome;
      this.pending.delete(solicitationId);
      this.lastHeartbeatAt.delete(solicitationId);
      this.emit();
    }
    return ok;
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
