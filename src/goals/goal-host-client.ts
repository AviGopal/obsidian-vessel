/**
 * Goal Host Client
 *
 * Thin wrapper around goal-host-vessel's /run-goal endpoint.
 * Uses Obsidian's requestUrl to avoid CORS restrictions from the
 * app://obsidian.md origin.
 */

import { sidecarHttpAuto, sidecarResolveBody } from '../sidecar-manager';

export interface GoalDispatchResult {
  executionId: string;
  status: string;
  selectedTemplateId?: string;
}

/**
 * Snapshot of the current Obsidian workspace state.
 *
 * Passed as `variables` to /run-goal so activities can reference vault
 * context via template interpolation ({{active_note_path}}, etc.) and so
 * Thompson sampling can bias toward activities that accept obsidian shapes.
 *
 * All fields are optional — the client collects what's available and skips
 * anything the API doesn't expose.
 */
export interface VaultContext {
  /** Path of the note currently focused in the editor. */
  active_note_path?: string;
  /** Headings breadcrumb of the cursor position, e.g. "## Section > ### Sub". */
  active_note_section?: string;
  /** Text the user has selected in the active editor, if any. */
  selection?: string;
  /** Paths of all notes currently open in workspace tabs. */
  open_note_paths?: string[];
  /** Vault-root filesystem path (so activities can construct absolute paths). */
  vault_path?: string;
  /** Obsidian-vessel HTTP resolve endpoint for impulse callbacks. */
  obsidian_vessel_endpoint?: string;
  /** Shape tags this context exposes — fed to expected_output_shapes hint. */
  available_shapes?: string[];
  /** Human operator id (the vault) — stamps the dispatch so the panel shows "Dispatched by <you>" instead of guessing the trigger. */
  operator?: string;
}

export class GoalHostClient {
  // The single sidecar conduit holds the endpoint and API key; this client
  // needs neither — every call routes through sidecarHttpAuto / sidecarResolve.
  constructor() {}

  /**
   * Sidecar-first transport: route through the federation sidecar (the
   * plugin's substrate conduit — works identically local or remote) by the
   * goal_execution shape; fall back to the direct endpoint when the sidecar
   * is not up. Throws on a non-2xx response either way.
   */
  private async http(path: string, body?: unknown, method?: string): Promise<Record<string, unknown>> {
    const m = method || (body != null ? 'POST' : 'GET');
    const via = await sidecarHttpAuto({ shape: 'goal_execution', method: m, path, body });
    if (!via) throw new Error(`goal-host ${path} failed: sidecar conduit unavailable`);
    if (!via.ok) throw new Error(`goal-host ${path} failed with status ${via.status}`);
    return (via.body ?? {}) as Record<string, unknown>;
  }

  /**
   * Poll GET /executions/:dispatchId until execution_id is known or timeout.
   * Returns { executionId, variantId } on success, throws with reason on failure.
   *
   * Does NOT bail early on status=failed — auto-draft LLM errors are transient
   * and the execution may be retried. Only gives up after the full timeout or
   * after seeing failed status on 3 consecutive polls.
   */
  async pollExecutionId(
    dispatchId: string,
    timeoutMs = 300000,
  ): Promise<{ executionId: string; variantId?: string }> {
    const deadline = Date.now() + timeoutMs;
    let consecutiveFails = 0;
    let lastError = '';

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const body = (await sidecarResolveBody({ type: 'goalWalkState', dispatchId })) ?? {};
        if (body.executionId) {
          return {
            executionId: body.executionId as string,
            variantId: body.selectedTemplateId as string | undefined,
          };
        }
        if (body.status === 'failed') {
          lastError = (body.error as string) || 'execution failed';
          consecutiveFails++;
          if (consecutiveFails >= 3) {
            throw new Error(`Dispatch failed: ${lastError}`);
          }
          // keep polling — may recover
        } else {
          consecutiveFails = 0; // reset on running/other status
        }
      } catch (e) {
        // Re-throw our own deliberate errors
        if (e instanceof Error && e.message.startsWith('Dispatch failed:')) throw e;
        // Network/timeout errors — keep polling
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(`No response after ${Math.round(timeoutMs / 60000)} min${lastError ? `: ${lastError}` : ''}`);
  }

  /**
   * Fetch the dispatch record from goal-host GET /executions/:dispatchId.
   * The record carries the honest goal-reach verdict: `reached` (true/false/null)
   * and `goalReachReason` — distinct from `status`, which is only exit status.
   */
  async getDispatchRecord(dispatchId: string): Promise<Record<string, unknown>> {
    return (await sidecarResolveBody({ type: 'goalWalkState', dispatchId })) ?? {};
  }

  /**
   * Fetch the goal-host walk state for a dispatch via POST /resolve
   * ({"impulse":{"pointer":{"type":"goalWalkState",...}}}). Carries the
   * decision-tree `steps`, terminal `learning` block, and authored `answerBody`
   * when goal-host has landed them. Returns the `body` object, or {} on failure.
   */
  async getWalkState(dispatchId: string): Promise<Record<string, unknown>> {
    try {
      const body = await sidecarResolveBody({ type: 'goalWalkState', dispatchId });
      return (body as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  async dispatchGoal(goal: string, ctx?: VaultContext): Promise<GoalDispatchResult> {
    const variables: Record<string, unknown> = ctx ? { ...ctx } : {};
    const expectedOutputShapes = ctx?.available_shapes?.length
      ? ctx.available_shapes
      : undefined;

    // Tags persist to the execution trace so the vault context is visible to
    // the learning loop even though variables themselves are ephemeral.
    const tags: string[] = ['dispatcher:obsidian-vessel'];
    if (ctx?.active_note_path) tags.push('obsidian:has_active_note');
    if (ctx?.selection) tags.push('obsidian:has_selection');
    if (ctx?.open_note_paths?.length) tags.push(`obsidian:open_notes_${ctx.open_note_paths.length}`);
    if (ctx?.available_shapes?.length) tags.push(`obsidian:shapes_${ctx.available_shapes.length}`);

    const via = await sidecarHttpAuto({ shape: 'goal_execution', method: 'POST', path: '/v2/impulses/resolve', body: { impulse: { pointer: { type: 'goalDispatchAsync', goal, variables, tags, ...(ctx?.operator ? { operator: ctx.operator } : {}), ...(expectedOutputShapes ? { expected_output_shapes: expectedOutputShapes } : {}) } } } });
    if (!via) throw 'sidecar conduit unavailable';
    if (!via.ok) throw new Error(`goal dispatch failed: ${via.status}`);
    const b = (via.body ?? {}) as Record<string, unknown>;
    const rec = (b.body && typeof b.body === 'object' ? b.body : b) as Record<string, unknown>;
    return { executionId: String(rec.dispatchId ?? rec.executionId ?? ''), status: String(rec.status ?? 'unknown'), selectedTemplateId: rec.selectedTemplateId as string | undefined };
  }

  /**
   * Submit impulse relevance feedback to the learning loop after execution.
   *
   * Records `P(success | obsidian:shape present)` for each shape that was in
   * the vault context. This teaches the recommender which activities benefit
   * from having vault content available as context, biasing future selections
   * toward vault-aware templates when obsidian shapes are in the pool.
   *
   * Fires once per dispatch: was_loaded=true because the shapes were available
   * to the execution (even if not all were resolved); execution_succeeded
   * reflects the actual trace outcome.
   */
  async recordImpulseRelevance(
    executionId: string,
    variantId: string,
    shapes: string[],
    succeeded: boolean,
  ): Promise<void> {
    for (const shape of shapes) {
      try {
        const payload = {
          impulse_id: shape,
          activity_variant_id: variantId,
          execution_id: executionId,
          was_loaded: true,
          execution_succeeded: succeeded,
          pointer_type: shape,
        };
        await sidecarHttpAuto({ shape: 'impulseRelevance', method: 'POST', path: '/v2/activities/impulse-relevance', body: payload });
      } catch {
        // relevance writes are best-effort — don't surface errors to the user
      }
    }
  }
}
