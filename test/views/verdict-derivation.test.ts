/**
 * Tests for the verdict-derivation prose — the audit chain the panel renders as
 * "How this verdict was reached".
 *
 * The contract these lock down is legibility, not formatting: a human reading
 * only the panel must be able to see what the goal was held to, what ran, what
 * it produced, which rule decided the verdict, and what the run taught the
 * system. The dominant real-world case is a HOLLOW run that took zero steps and
 * produced nothing — historically the panel rendered almost nothing for it, so
 * that case is asserted hardest here.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseReachGate,
  verdictDerivation,
  learningOutcomeSentence,
} from '../../src/views/panel-narrative';

const HOLLOW_LINE =
  '[goal-host-vessel] goal-reach(/run-goal) attempt 1/1: HOLLOW (declarative): declarative: missing activityTemplate,learningSummary';

const hollowBody = (): Record<string, unknown> => ({
  status: 'completed',
  reached: false,
  poolShapes: [],
  poolProvenance: [],
  poolEvents: [],
  pendingTargets: [],
  steps: [],
  walkLog: [HOLLOW_LINE],
  currentStep: HOLLOW_LINE,
  learning: { alphaBetaDelta: [], gapsFiled: [], goalPathRecorded: false, oracleLabelWritten: false },
});

describe('parseReachGate', () => {
  test('extracts the gate outcome, mode, required shapes and attempt', () => {
    const g = parseReachGate([HOLLOW_LINE], '');
    expect(g).not.toBeNull();
    expect(g!.outcome).toBe('HOLLOW');
    expect(g!.mode).toBe('declarative');
    expect(g!.missing).toEqual(['activityTemplate', 'learningSummary']);
    expect(g!.attempt).toBe('1/1');
  });

  test('returns null when no gate decision was recorded', () => {
    expect(parseReachGate(['[goal-host-vessel] walk: no pick'], '')).toBeNull();
  });
});

describe('verdictDerivation', () => {
  test('a hollow zero-step run still explains itself end to end', () => {
    const chain = verdictDerivation(hollowBody(), {});
    const labels = chain.map((s) => s.label);
    expect(labels).toContain('Asked for');
    expect(labels).toContain('Ran');
    expect(labels).toContain('Produced');
    expect(labels).toContain('Judged by');
    expect(labels).toContain('Therefore');

    // The requirement is recoverable from the gate even when the walk logged
    // no inference of its own — otherwise the human cannot tell what it was
    // being held to.
    expect(chain.find((s) => s.label === 'Asked for')!.text).toContain('activityTemplate');
    // Zero steps and zero output must be stated, not implied by absence.
    expect(chain.find((s) => s.label === 'Ran')!.text).toContain('no steps');
    expect(chain.find((s) => s.label === 'Produced')!.text).toContain('Nothing');
    // The deciding link is marked so the eye lands on it.
    expect(chain.find((s) => s.label === 'Therefore')!.tone).toBe('bad');
  });

  test('does not claim shapes were missing when the gate reported none', () => {
    const chain = verdictDerivation(hollowBody(), {});
    const judged = chain.find((s) => s.label === 'Judged by')!.text;
    // Guards the inverted phrasing "found none of them missing", which said the
    // opposite of what the gate meant.
    expect(judged).not.toContain('none of them missing');
    expect(judged).toContain('none of those shapes were produced');
  });

  test('a reached run reports the pool count consistently with the shapes it lists', () => {
    const chain = verdictDerivation(
      {
        status: 'completed',
        reached: true,
        poolShapes: ['fileEditResult', 'codeReplaceResult'],
        poolProvenance: [{ shape: 'fileEditResult', chars: 812 }],
        steps: [{ index: 0 }, { index: 1 }],
        walkLog: [
          '[goal-host-vessel] /run-goal: goal-target inference {"inferred_target_shapes":["fileEditResult"],"confidence":0.9}',
          '[goal-host-vessel] goal-reach(/run-goal) attempt 1/1: REACHED (declarative)',
        ],
        currentStep: '',
      },
      {},
    );
    const produced = chain.find((s) => s.label === 'Produced')!.text;
    // Two shapes named ⇒ the count must say two, and the thinner ledger
    // coverage must be admitted rather than silently disagreeing.
    expect(produced).toContain('2 shapes');
    expect(produced).toContain('Content was captured for 1 of them');
    expect(chain.find((s) => s.label === 'Therefore')!.tone).toBe('ok');
  });

  test('says so plainly when no gate decision was recorded', () => {
    const chain = verdictDerivation(
      { status: 'failed', reached: false, steps: [], poolShapes: [], pendingTargets: ['shellResult'], walkLog: [] },
      {},
    );
    const therefore = chain.find((s) => s.label === 'Therefore')!.text;
    expect(therefore).toContain('no gate decision was recorded');
    expect(therefore).not.toContain('..');
  });
});

describe('learningOutcomeSentence', () => {
  test('names the silence when a run taught the loop nothing', () => {
    const s = learningOutcomeSentence({ alphaBetaDelta: [], gapsFiled: [], oracleLabelWritten: false });
    expect(s).toContain('taught the system nothing');
    // It must also tell the human why their grade is the remedy.
    expect(s).toContain('grade');
  });

  test('summarises what was actually learned', () => {
    const s = learningOutcomeSentence({
      alphaBetaDelta: [{ templateId: 'feature-compose', dAlpha: 1 }],
      gapsFiled: ['gap-1'],
      oracleLabelWritten: true,
    });
    expect(s).toContain('updated the odds on 1 pick');
    expect(s).toContain('filed 1 gap');
    expect(s).toContain('oracle label');
  });

  test('distinguishes absent learning fields from a run that learned nothing', () => {
    expect(learningOutcomeSentence(null)).toContain('Nothing was recorded');
  });
});

describe('hollow passes are named, not narrated as success', () => {
  const hollowGreen = (): Record<string, unknown> => ({
    status: 'completed',
    reached: true,
    poolShapes: [], poolProvenance: [], steps: [],
    walkLog: ['[goal-host-vessel] goal-reach(/run-goal) attempt 1/1: REACHED (declarative)'],
    currentStep: '',
    learning: { alphaBetaDelta: [], gapsFiled: [], oracleLabelWritten: false },
  });

  test('a REACHED gate over an empty pool is reported as a hollow pass', () => {
    const chain = verdictDerivation(hollowGreen(), {});
    const therefore = chain.find((s) => s.label === 'Therefore')!;
    expect(therefore.text).toContain('hollow pass');
    // Must NOT claim the gate verified anything — there was nothing to verify.
    expect(therefore.text).not.toContain('found everything the goal declared it needed');
    // And it must read as a problem, not a success.
    expect(therefore.tone).toBe('bad');
  });

  test('a genuine reach with produced output still reads as a success', () => {
    const chain = verdictDerivation({
      status: 'completed', reached: true,
      poolShapes: ['fileEditResult'], poolProvenance: [{ shape: 'fileEditResult', chars: 10 }],
      steps: [{ index: 0 }],
      walkLog: ['[goal-host-vessel] goal-reach(/run-goal) attempt 1/1: REACHED (declarative)'],
      currentStep: '',
    }, {});
    const therefore = chain.find((s) => s.label === 'Therefore')!;
    expect(therefore.tone).toBe('ok');
    expect(therefore.text).toContain('found everything');
  });

  test('a reach with no gate decision AND no output is also called hollow', () => {
    const chain = verdictDerivation({
      status: 'completed', reached: true, poolShapes: [], steps: [], walkLog: [], currentStep: '',
    }, {});
    const therefore = chain.find((s) => s.label === 'Therefore')!;
    expect(therefore.text).toContain('hollow pass');
    expect(therefore.tone).toBe('bad');
  });
});
