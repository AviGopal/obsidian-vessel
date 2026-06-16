/**
 * Regression tests for the concept-writeback envelope strip.
 *
 * After the fm-57 redesign, `renderConceptNote` emits a data-shaped
 * note:
 *
 *   # {title}
 *
 *   {summary one-liner}
 *
 *   {optional user prose}
 *
 *   ---
 *   *Source: [[path|§ section]]*
 *
 * Writeback must strip the formatter-emitted wrapper so the next pull
 * does not accumulate echoes into `concept.content`. The load-bearing
 * invariant is:
 *
 *   stripWritebackEnvelope(render(c, ""))  === ""
 *   stripWritebackEnvelope(render(c, "P")) === "P"
 *
 * The strip also tolerates the LEGACY pre-fm-57 wrapper (heading +
 * `[!abstract]` / `[!info]` / `[!quote]` callouts + trailing `##
 * Related`) so vault notes written by the old formatter still
 * round-trip cleanly until the next pull rewrites them.
 *
 * Cites concept_kxeA7gRK7NEW (writeback_echo_loop) and
 * concept_HqdWDywYZzK3 (round_trip_idempotence_contract).
 */

import { describe, expect, test } from 'bun:test';
import {
  stripRenderedWrap,
  stripSourceFooter,
  stripWritebackEnvelope,
} from '../../src/sync/concept-writeback-strip';

describe('stripRenderedWrap (new data-shaped format)', () => {
  test('strips heading + summary line + leaves user body', () => {
    const rendered = [
      '# Api Contract Validation Failure',
      '',
      'A short summary line.',
      '',
      'This is the user-authored body.',
      '',
      'A second paragraph.',
    ].join('\n');

    expect(stripRenderedWrap(rendered)).toBe(
      'This is the user-authored body.\n\nA second paragraph.',
    );
  });

  test('strips heading + summary when there is no user body', () => {
    const rendered = ['# Title', '', 'A summary one-liner.'].join('\n');
    expect(stripRenderedWrap(rendered)).toBe('');
  });

  test('is idempotent: running twice equals running once', () => {
    const rendered = [
      '# Title',
      '',
      'Summary line.',
      '',
      'Body paragraph.',
    ].join('\n');
    const once = stripRenderedWrap(rendered);
    const twice = stripRenderedWrap(once);
    expect(twice).toBe(once);
    expect(once).toBe('Body paragraph.');
  });

  test('preserves a body that starts with `## SubHeading` (no `# ` wrap)', () => {
    const body = ['## SubHeading', '', 'Some content.'].join('\n');
    expect(stripRenderedWrap(body)).toBe(body);
  });

  test('empty input returns empty', () => {
    expect(stripRenderedWrap('')).toBe('');
    expect(stripRenderedWrap('\n\n\n')).toBe('');
  });

  test('preserves user [!warning] callout at top (not stripped as summary)', () => {
    // After the heading is stripped, the next line is a callout —
    // user-owned, so the summary-stripping step skips it.
    const body = [
      '# Title',
      '',
      '> [!warning]',
      '> Heads up.',
      '',
      'Paragraph.',
    ].join('\n');
    expect(stripRenderedWrap(body)).toBe(
      ['> [!warning]', '> Heads up.', '', 'Paragraph.'].join('\n'),
    );
  });

  test('does not strip deeper headings (## or ###)', () => {
    const body = ['## Section', '', 'Body.'].join('\n');
    expect(stripRenderedWrap(body)).toBe(body);
  });
});

describe('stripRenderedWrap (legacy pre-fm-57 format back-compat)', () => {
  test('strips heading + all three callouts + leaves user body', () => {
    const rendered = [
      '# Api Contract Validation Failure',
      '',
      '> [!abstract] Summary',
      '> A short summary line.',
      '',
      '> [!info] Stats',
      '> relevance 0.42 · loaded 3',
      '',
      '> [!quote] Source',
      '> `src/foo.ts` § bar',
      '',
      'This is the user-authored body.',
      '',
      'A second paragraph.',
    ].join('\n');

    expect(stripRenderedWrap(rendered)).toBe(
      'This is the user-authored body.\n\nA second paragraph.',
    );
  });

  test('preserves a user [!note] callout that appears after the legacy wrap', () => {
    const rendered = [
      '# Title',
      '',
      '> [!abstract] Summary',
      '> Summary line.',
      '',
      '> [!note]',
      '> A user-authored note callout.',
      '',
      'Body text.',
    ].join('\n');

    const stripped = stripRenderedWrap(rendered);
    expect(stripped).toContain('> [!note]');
    expect(stripped).toContain('A user-authored note callout.');
    expect(stripped).toContain('Body text.');
    expect(stripped).not.toContain('# Title');
    expect(stripped).not.toContain('[!abstract]');
  });
});

describe('stripSourceFooter', () => {
  test('strips trailing `---` + `*Source: ...*` footer', () => {
    const body = [
      'Body content.',
      '',
      '---',
      '*Source: [[path/to/file.md|§ section]]*',
    ].join('\n');
    expect(stripSourceFooter(body)).toBe('Body content.');
  });

  test('strips operator-session footer variant', () => {
    const body = [
      'Body.',
      '',
      '---',
      '*Source: operator session · 2026-06-01*',
    ].join('\n');
    expect(stripSourceFooter(body)).toBe('Body.');
  });

  test('does not strip a `---` horizontal rule in the middle of the body', () => {
    const body = ['Above.', '', '---', '', 'Below.'].join('\n');
    expect(stripSourceFooter(body)).toBe(body);
  });

  test('does not strip a non-source italic line at the end', () => {
    const body = ['Body.', '', '---', '*Some user note.*'].join('\n');
    expect(stripSourceFooter(body)).toBe(body);
  });

  test('empty input returns empty', () => {
    expect(stripSourceFooter('')).toBe('');
  });
});

describe('stripWritebackEnvelope (combined leading + trailing strips)', () => {
  test('new format: heading + summary + body + source footer round-trips', () => {
    const rendered = [
      '# Api Contract Validation Failure',
      '',
      'A short summary.',
      '',
      'Body paragraph.',
      '',
      '---',
      '*Source: [[src/foo.ts]]*',
    ].join('\n');

    expect(stripWritebackEnvelope(rendered)).toBe('Body paragraph.');
  });

  test('new format empty-prose: render of empty body strips back to empty', () => {
    const rendered = [
      '# Title',
      '',
      'summary only',
      '',
      '---',
      '*Source: [[path]]*',
    ].join('\n');
    expect(stripWritebackEnvelope(rendered)).toBe('');
  });

  test('idempotence under the composed envelope strip', () => {
    const rendered = [
      '# T',
      '',
      's',
      '',
      'Body.',
      '',
      '---',
      '*Source: [[x]]*',
    ].join('\n');
    const once = stripWritebackEnvelope(rendered);
    const twice = stripWritebackEnvelope(once);
    expect(twice).toBe(once);
    expect(once).toBe('Body.');
  });

  test('legacy back-compat: heading + 3 callouts + body + ## Related strips cleanly', () => {
    const rendered = [
      '# Api Contract Validation Failure',
      '',
      '> [!abstract] Summary',
      '> A short summary.',
      '',
      '> [!info] Stats',
      '> relevance 0.4',
      '',
      '> [!quote] Source',
      '> `src/foo.ts`',
      '',
      'Body paragraph.',
      '',
      '## Related',
      '### related_to',
      '- [[concept_abc]]',
    ].join('\n');

    expect(stripWritebackEnvelope(rendered)).toBe('Body paragraph.');
  });

  test('legacy empty-prose round-trip: callout-only wrap + Related strips to empty', () => {
    const rendered = [
      '# Title',
      '',
      '> [!abstract] Summary',
      '> summary only',
      '',
      '## Related',
      '- [[x]]',
    ].join('\n');
    expect(stripWritebackEnvelope(rendered)).toBe('');
  });
});
