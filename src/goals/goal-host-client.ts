/**
 * Goal Host Client
 *
 * Thin wrapper around goal-host-vessel's /run-goal endpoint.
 * Uses Obsidian's requestUrl to avoid CORS restrictions from the
 * app://obsidian.md origin.
 */

import { requestUrl } from 'obsidian';

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
}

export class GoalHostClient {
  constructor(
    private endpoint: string,
    private apiKey: string,
  ) {}

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
        const r = await requestUrl({
          url: `${this.endpoint}/executions/${dispatchId}`,
          method: 'GET',
          headers: { 'Authorization': `ApiKey ${this.apiKey}` },
        });
        const body = r.json as Record<string, unknown>;
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

    const resp = await requestUrl({
      url: `${this.endpoint}/run-goal`,
      method: 'POST',
      headers: {
        'Authorization': `ApiKey ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        goal,
        variables,
        tags,
        ...(expectedOutputShapes ? { expected_output_shapes: expectedOutputShapes } : {}),
      }),
    });
    const raw = resp.json as Record<string, unknown>;
    return {
      executionId: (raw.executionId ?? raw.dispatchId ?? '') as string,
      status: (raw.status ?? 'unknown') as string,
      selectedTemplateId: raw.selectedTemplateId as string | undefined,
    };
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
    activityApiUrl: string,
    executionId: string,
    variantId: string,
    shapes: string[],
    succeeded: boolean,
  ): Promise<void> {
    for (const shape of shapes) {
      try {
        await requestUrl({
          url: `${activityApiUrl}/v2/activities/impulse-relevance`,
          method: 'POST',
          headers: {
            'Authorization': `ApiKey ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            impulse_id: shape,
            activity_variant_id: variantId,
            execution_id: executionId,
            was_loaded: true,
            execution_succeeded: succeeded,
            pointer_type: shape,
          }),
        });
      } catch {
        // relevance writes are best-effort — don't surface errors to the user
      }
    }
  }
}
