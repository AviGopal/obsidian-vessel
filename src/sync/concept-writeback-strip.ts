/**
 * Pure body-envelope strip functions for concept-writeback.
 *
 * Kept in a separate module from `concept-writeback.ts` so that tests
 * can import them without dragging in the `obsidian` runtime (which is
 * only available inside the Obsidian process).
 *
 * After the data-shaped formatter redesign (substrate-authored,
 * exec_6hklezdj, fm-57), `renderConceptNote` emits:
 *
 *   # {humanTitle}
 *
 *   {summary one-liner}
 *
 *   {optional user prose — what the operator owns}
 *
 *   ---
 *   *Source: [[path|§ section]]*
 *
 * Writeback must strip exactly the formatter-emitted wrapper so the
 * next pull does not accumulate echoes into `concept.content`. The
 * load-bearing invariant is:
 *
 *   stripWritebackEnvelope(render(c, ""))  === ""
 *   stripWritebackEnvelope(render(c, "P")) === "P"
 *
 * Cites concept_kxeA7gRK7NEW (writeback_echo_loop) and
 * concept_HqdWDywYZzK3 (round_trip_idempotence_contract).
 */

/**
 * Strip the trailing source footer: a `---` separator followed by a
 * single italic `*Source: …*` line (and optional trailing blanks).
 * Anything else after the separator is preserved (user prose can
 * include `---` horizontal rules above their own content).
 */
export function stripSourceFooter(body: string): string {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end >= 2) {
    const last = lines[end - 1].trim();
    const sep = lines[end - 2].trim();
    if (sep === '---' && /^\*Source:\s.*\*$/.test(last)) {
      end -= 2;
    }
  }
  return lines.slice(0, end).join('\n').trim();
}

/**
 * Strip the trailing `## Related` block. The old (pre-fm-57) formatter
 * appended a `## Related` section to the body; the new formatter does
 * not — relationships now live in YAML frontmatter. We keep this strip
 * so that vault notes rendered by the old formatter and edited by the
 * operator still writeback cleanly (one-shot migration: next pull
 * re-renders in the new shape).
 */
export function stripRelated(body: string): string {
  const relIdx = body.search(/^##\s+Related\s*$/m);
  if (relIdx < 0) return body.trim();
  return body.slice(0, relIdx).trim();
}

/**
 * Strip the data-shaped leading wrap:
 *   1. one `# <title>` heading line (only the renderer's H1; deeper
 *      headings starting with `## ` are preserved as user content);
 *   2. the next non-empty line, which is the rendered `summary`
 *      one-liner.
 *
 * Then leave the rest as user prose. Blank lines between each piece
 * are absorbed.
 *
 * Backward-compat: if the body still carries the OLD-formatter
 * wrap (a contiguous run of `[!abstract]` / `[!info]` / `[!quote]`
 * callouts after the heading), absorb that too so legacy vault notes
 * round-trip cleanly until the next pull rewrites them.
 *
 * Idempotent: a second pass over the result is a no-op.
 */
export function stripRenderedWrap(body: string): string {
  const lines = body.split('\n');
  let i = 0;

  const skipBlanks = () => {
    while (i < lines.length && lines[i].trim() === '') i++;
  };

  skipBlanks();

  // (1) Optional single `# <title>` line — only the renderer's H1.
  // We strip the summary line only if there WAS a heading, because
  // the heading is the structural anchor that tells us "the next
  // plain line is the formatter-emitted summary." Without that anchor
  // the next line might be load-bearing user prose, and the strip
  // would not be idempotent (each pass would eat one more line).
  let strippedHeading = false;
  if (i < lines.length && /^#\s+\S/.test(lines[i]) && !/^##/.test(lines[i])) {
    i++;
    strippedHeading = true;
    skipBlanks();
  }

  // (2a) Legacy contiguous run of rendered callouts (old formatter).
  // If we absorb any, treat the summary as having lived inside the
  // `[!abstract]` callout — do NOT also strip a following plain line.
  const renderedCalloutHead = /^>\s*\[!(abstract|info|quote)\]/;
  let absorbedLegacyCallouts = false;
  while (i < lines.length && renderedCalloutHead.test(lines[i])) {
    absorbedLegacyCallouts = true;
    while (i < lines.length && /^>/.test(lines[i])) i++;
    skipBlanks();
  }

  // (2b) New-formatter summary line: only when we previously stripped
  // a `# Heading` and did NOT absorb a legacy abstract callout. The
  // next single non-empty line that is NOT a heading and NOT a
  // callout is the summary one-liner. Without a preceding heading the
  // input has no formatter anchor, so we leave it alone — that
  // guarantees idempotence (a second pass is a no-op).
  if (strippedHeading && !absorbedLegacyCallouts && i < lines.length) {
    const next = lines[i];
    const isHeading = /^#{1,6}\s/.test(next);
    const isCallout = /^>\s*\[!/.test(next);
    if (!isHeading && !isCallout && next.trim() !== '') {
      i++;
      skipBlanks();
    }
  }

  return lines.slice(i).join('\n').trim();
}

/**
 * Compose all three strips: trailing source footer, trailing legacy
 * `## Related` (back-compat), and leading wrap. Result is the pure
 * user-owned prose that should be POSTed back to concept-db as
 * `concept.content`.
 */
export function stripWritebackEnvelope(body: string): string {
  return stripRenderedWrap(stripRelated(stripSourceFooter(body)));
}
