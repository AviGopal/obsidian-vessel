/**
 * obsidian:presentation_decisions — read-only observability into the
 * presentation bandit: the selection ring buffer (which arm, which source,
 * which posteriors were sampled) and the live grader episodes. This is what
 * makes the client-side Thompson choice OBSERVABLE to the substrate (and to
 * the counterfactual audit: every emitted present-* grade must match a
 * logged thompson/epsilon decision here — an orphan grade is a red alert).
 */
import type { App } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';
import { getPresentationDecisions } from '../presentation/presentation-policy';
import { attentionGrader } from '../presentation/attention-grader';

async function resolvePresentationDecisions(pointer: ImpulsePointer, _app: App): Promise<ResolverResult> {
  const p = pointer as unknown as { limit?: number };
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const decisions = getPresentationDecisions();
  return {
    content: JSON.stringify({
      shape: 'obsidian:presentation_decisions',
      total: decisions.length,
      decisions: decisions.slice(-limit),
      episodes: attentionGrader.debugState(),
    }),
  };
}

registerResolver('obsidian:presentation_decisions', resolvePresentationDecisions);
