/**
 * Tests for resolution-path detection — which of the five mechanisms resolved a
 * goal, and what the reader is told about it.
 *
 * This decides what the run view shows. Getting it wrong is not cosmetic: a
 * satisfier resolve labelled as a walk gets a "decision tree" for deliberation
 * that never happened, and a direct code edit gets shape-flow chips instead of
 * its commit. The panel must also cope with records written before goal-host
 * carried the classification, and must never present a fallback guess as fact.
 */

import { describe, expect, test } from 'bun:test';
import {
  resolutionPath,
  resolvedBySentence,
  resolvedByLabel,
  featureComposeOutcome,
} from '../../src/views/panel-narrative';

describe('resolutionPath', () => {
  test('prefers the classification goal-host recorded', () => {
    const v = resolutionPath({ executionPath: 'universal_tool_fallback', steps: [{}, {}] });
    expect(v.path).toBe('universal_tool_fallback');
    expect(v.basis).toBe('stated');
  });

  test('ignores a junk executionPath rather than trusting it', () => {
    const v = resolutionPath({ executionPath: 'nonsense', steps: [] });
    expect(v.path).not.toBe('nonsense');
    expect(v.basis).toBe('inferred');
  });

  test('infers a direct edit from the execution id on legacy records', () => {
    const v = resolutionPath({ executionId: 'feature_compose:3611665cd8523d6a01d5ddf1b43e90c3a81a6a7a' });
    expect(v.path).toBe('feature_compose');
    expect(v.basis).toBe('inferred');
    expect(v.evidence).toContain('feature_compose');
  });

  test('infers the tool-loop floor from its execution id prefix', () => {
    expect(resolutionPath({ executionId: 'universal-tool-fallback:abc123' }).path)
      .toBe('universal_tool_fallback');
  });

  test('a run whose every step was a direct vessel resolve is a satisfier, not a walk', () => {
    const v = resolutionPath({
      steps: [
        { selected: { source: 'satisfier', templateId: 'satisfier:codeReadResult' } },
      ],
    });
    expect(v.path).toBe('satisfier');
  });

  test('a run with a thompson pick is a fresh derivation', () => {
    const v = resolutionPath({
      steps: [
        { selected: { source: 'satisfier', templateId: 'satisfier:x' } },
        { selected: { source: 'thompson', templateId: 'bridge-shellResult' } },
      ],
    });
    expect(v.path).toBe('fresh_derivation');
    expect(v.evidence).toContain('2 walk steps');
  });

  test('recognises goal-host\'s learned_pathway instead of relabelling it', () => {
    // Regression: the panel's vocabulary omitted learned_pathway entirely, so a
    // run goal-host had explicitly classified fell through to inference and was
    // confidently reported as "derived from scratch" — the exact opposite claim.
    const v = resolutionPath({ executionPath: 'learned_pathway', steps: [{}, {}] });
    expect(v.path).toBe('learned_pathway');
    expect(v.basis).toBe('stated');
    expect(resolvedByLabel(v.path)).toContain('learned');
  });

  test('an unattributable run says so instead of guessing', () => {
    const v = resolutionPath({ steps: [], poolShapes: [] });
    expect(v.path).toBe('unknown');
    expect(resolvedBySentence(v)).toContain('never recorded');
  });
});

describe('featureComposeOutcome', () => {
  test('reads a landed commit out of the execution id', () => {
    const o = featureComposeOutcome('feature_compose:3611665cd8523d6a01d5ddf1b43e90c3a81a6a7a')!;
    expect(o.landed).toBe(true);
    expect(o.sha).toBe('3611665cd8523d6a01d5ddf1b43e90c3a81a6a7a');
  });

  test('reads a rejection', () => {
    const o = featureComposeOutcome('feature_compose:rejected:c057bcbc:93')!;
    expect(o.landed).toBe(false);
    expect(o.rejectedTag).toBe('c057bcbc:93');
  });

  test('is null for anything that is not a direct edit', () => {
    expect(featureComposeOutcome('universal-tool-fallback:x')).toBeNull();
    expect(featureComposeOutcome('')).toBeNull();
  });
});

describe('resolvedBySentence', () => {
  test('a direct edit names its commit and explains the absence of walk steps', () => {
    const s = resolvedBySentence(
      { path: 'feature_compose', basis: 'stated', evidence: '' },
      { executionId: 'feature_compose:3611665cd8523d6a01d5ddf1b43e90c3a81a6a7a' },
    );
    expect(s).toContain('before any walk');
    expect(s).toContain('3611665cd8');
  });

  test('a direct edit does NOT claim there were no walk steps when there were', () => {
    // The prose used to assert "it never entered the shape-graph walk" flatly.
    // If steps exist that is a false statement made to the reader's face.
    const s = resolvedBySentence(
      { path: 'feature_compose', basis: 'stated', evidence: '' },
      { executionId: 'feature_compose:rejected:aa:1', steps: [{}, {}] },
    );
    expect(s).not.toContain('no walk steps');
    expect(s).toContain('2 walk steps were also recorded');
  });

  test('a satisfier with recorded steps does not claim nothing executed', () => {
    const s = resolvedBySentence(
      { path: 'satisfier', basis: 'stated', evidence: '' },
      { steps: [{}] },
    );
    expect(s).not.toContain('nothing executed');
    expect(s).toContain('1 recorded step');
  });

  test('a satisfier explains that no decision existed to inspect', () => {
    const s = resolvedBySentence({ path: 'satisfier', basis: 'stated', evidence: '' });
    expect(s).toContain('nothing executed');
    expect(s).toContain('no decision was needed');
  });

  test('the floor is described as a floor, not as an achievement', () => {
    const s = resolvedBySentence({ path: 'universal_tool_fallback', basis: 'stated', evidence: '' });
    expect(s).toContain('had nothing better');
  });

  test('every path has a label', () => {
    for (const p of ['feature_compose', 'learned_pathway', 'satisfier', 'fresh_derivation', 'universal_tool_fallback', 'unknown'] as const) {
      expect(resolvedByLabel(p).length).toBeGreaterThan(0);
    }
  });
});
