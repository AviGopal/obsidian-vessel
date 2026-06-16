/**
 * Tests for `probe-obsidian-action-effects`.
 *
 * Covers the safety-critical surfaces that don't require a live
 * Obsidian runtime:
 *   - deny-glob filter excludes destructive command namespaces;
 *   - reversibility heuristic returns vocabulary values;
 *   - distribution accumulation produces normalized probabilities.
 *
 * The live `executeCommandById` dispatch path is exercised against a
 * probe vault per the spec's acceptance criteria.
 */

import { describe, expect, test } from 'bun:test';
import {
  accumulateModel,
  classifyReversibility,
} from '../../src/resolvers/probe-obsidian-action-effects';
import {
  DEFAULT_PROBE_DENY_GLOBS,
  isCommandAllowedForProbe,
  matchesDenyGlob,
} from '../../src/resolvers/observation-types';

describe('deny-glob filter', () => {
  test('excludes app:* namespace by default', () => {
    expect(isCommandAllowedForProbe('app:open-vault')).toBe(false);
    expect(isCommandAllowedForProbe('app:reload')).toBe(false);
    expect(isCommandAllowedForProbe('app:any-future-thing')).toBe(false);
  });

  test('excludes editor:focus exactly', () => {
    expect(isCommandAllowedForProbe('editor:focus')).toBe(false);
    // Sibling commands MUST still be allowed.
    expect(isCommandAllowedForProbe('editor:focus-next')).toBe(true);
    expect(isCommandAllowedForProbe('editor:toggle-bold')).toBe(true);
  });

  test('excludes daily-notes:* family', () => {
    expect(isCommandAllowedForProbe('daily-notes:goto-today')).toBe(false);
    expect(isCommandAllowedForProbe('daily-notes:open-prev')).toBe(false);
  });

  test('extra deny globs from caller compose with the defaults', () => {
    expect(isCommandAllowedForProbe('plugin:my-evil-command', ['plugin:*'])).toBe(false);
    expect(isCommandAllowedForProbe('plugin:my-evil-command')).toBe(true);
  });

  test('matchesDenyGlob handles literal patterns without wildcards', () => {
    expect(matchesDenyGlob('editor:focus', 'editor:focus')).toBe(true);
    expect(matchesDenyGlob('editor:focus-next', 'editor:focus')).toBe(false);
  });

  test('all default deny patterns include at least one well-known unsafe command', () => {
    expect(DEFAULT_PROBE_DENY_GLOBS.length).toBeGreaterThan(0);
    expect(DEFAULT_PROBE_DENY_GLOBS).toContain('app:*');
  });
});

describe('classifyReversibility', () => {
  test('text-edit commands → reversible', () => {
    expect(classifyReversibility('editor:toggle-bold')).toBe('reversible');
    expect(classifyReversibility('editor:insert-link')).toBe('reversible');
  });

  test('file-delete-ish commands → soft_irreversible', () => {
    expect(classifyReversibility('app:delete-file')).toBe('soft_irreversible');
    expect(classifyReversibility('workspace:remove-pane')).toBe('soft_irreversible');
  });

  test('plugin disable / reset → hard_irreversible', () => {
    expect(classifyReversibility('app:disable-plugin')).toBe('hard_irreversible');
    expect(classifyReversibility('settings:reset-vault')).toBe('hard_irreversible');
  });

  test('unrecognised commands → unknown', () => {
    expect(classifyReversibility('mystery:abc')).toBe('unknown');
  });
});

describe('accumulateModel', () => {
  test('single observation produces probability = 1.0', () => {
    const m = accumulateModel('editor:toggle-bold', [
      { pre_signature: 'a', post_signature: 'b' },
    ]);
    expect(m.observation_count).toBe(1);
    expect(m.post_signature_distribution).toHaveLength(1);
    expect(m.post_signature_distribution[0].probability).toBeCloseTo(1.0, 9);
  });

  test('multiple observations: probabilities sum to 1.0 within ±1e-6', () => {
    const m = accumulateModel('editor:toggle-bold', [
      { pre_signature: 'a', post_signature: 'p1' },
      { pre_signature: 'a', post_signature: 'p1' },
      { pre_signature: 'a', post_signature: 'p2' },
    ]);
    expect(m.observation_count).toBe(3);
    const sum = m.post_signature_distribution.reduce((s, d) => s + d.probability, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    // Most-frequent post comes first.
    expect(m.post_signature_distribution[0].post_signature).toBe('p1');
  });

  test('reversibility_class is one of the four vocabulary values', () => {
    const m = accumulateModel('editor:toggle-bold', [
      { pre_signature: 'a', post_signature: 'b' },
    ]);
    expect(['reversible', 'soft_irreversible', 'hard_irreversible', 'unknown']).toContain(
      m.reversibility_class,
    );
  });
});
