/**
 * Concept Formatter — data-shaped redesign (substrate-authored, exec_6hklezdj, fm-57).
 *
 * Frontmatter-rich, minimal-body: all queryable state lives in YAML
 * (typed fields, nested pointer object, related edges as wikilink
 * arrays). The body is reduced to:
 *
 *   # {humanTitle}
 *   {summary}
 *   {optional user prose}
 *   ---
 *   *Source: [[{pointer.path}|§ {pointer.section}]]*
 *
 * Wins over the prior heading + 3-callout wrapper:
 *   - Round-trip identity becomes structurally guaranteed:
 *     stripWritebackEnvelope(render(c, "")) === ""  (fm-50 echo loop closed).
 *   - Stats become queryable by Dataview / Bases / graph filters
 *     because they are typed YAML, not prose callouts.
 *   - Relationships are YAML wikilink arrays grouped by edge_type so
 *     Obsidian's graph view picks them up as first-class edges.
 *   - Body holds only what the operator owns: optional user prose.
 *
 * Cites concept_kxeA7gRK7NEW (writeback_echo_loop),
 * concept_HqdWDywYZzK3 (round_trip_idempotence_contract),
 * concept_lzKXyoYYwEBR.
 */

import type { ConceptRecord, ConceptNeighbor } from '../concept-db-client';
import { shortConceptId } from '../concept-db-client';

const BRIDGE_NOISE_DESCRIPTION = 'Auto-discovered relationship';

const EDGE_EMOJI: Record<string, string> = {
  derived_from: '🌱',
  description_of: '📖',
  contradicts: '⚠️',
  related_to: '🔗',
  example_of: '🎯',
  sequence_next: '➡️',
  sequence_prev: '⬅️',
  resolves_to: '🪝',
};

// Pin a sensible order so the most semantically-loaded edges appear
// first when the related section has several types.
const EDGE_ORDER = [
  'derived_from',
  'description_of',
  'contradicts',
  'example_of',
  'resolves_to',
  'sequence_next',
  'sequence_prev',
  'related_to',
];

export function slugifyShape(input: string, maxLen: number = 60): string {
  const s = (input || 'concept')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Strip filesystem-unsafe characters from a string for use in a
 * filename. Obsidian rejects `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`,
 * `|`. Leading/trailing whitespace + periods are also stripped (some
 * filesystems treat trailing `.` as namespace boundaries). Collapses
 * internal whitespace runs to single spaces.
 */
export function safeBaseName(input: string, maxLen: number = 120): string {
  let s = (input || 'Untitled')
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) s = 'Untitled';
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s;
}

/**
 * Compute the canonical title for a concept — the humanized shape,
 * filesystem-safe. This is the basename of the note file (without
 * `.md` and without any disambiguator suffix).
 */
export function conceptTitle(concept: ConceptRecord): string {
  const shape = concept.shape || concept.source_type || 'Concept';
  return safeBaseName(humanizeShape(shape));
}

/**
 * Build the vault-relative path for a concept's note.
 *
 *   <syncRoot>/<source_type>/<Title Case>.md
 *
 * When two concepts share both source_type and title (genuine
 * duplicates the dedup management activity should catch), the caller
 * passes a `collisions` map from `${sourceType}/${title}` → list of
 * concept ids encountered in the current pull. If the concept's
 * `(sourceType, title)` key collides, we append a 5-char short_id
 * disambiguator with the middle-dot separator: `Overview · y-CPp.md`.
 *
 * Without a collisions map we don't disambiguate — bare titles only.
 * The single-concept materialize path (e.g. writeback after a vault
 * edit) uses this fallback.
 */
export function conceptNotePath(
  concept: ConceptRecord,
  syncRoot: string,
  collisions?: Map<string, string[]>,
): string {
  const sourceType = concept.source_type || 'uncategorized';
  const title = conceptTitle(concept);
  let basename = title;
  if (collisions) {
    const key = `${sourceType}/${title}`;
    const conflicts = collisions.get(key);
    if (conflicts && conflicts.length > 1) {
      basename = `${title} · ${disambigSlice(concept.id)}`;
    }
  }
  return `${syncRoot}/${sourceType}/${basename}.md`;
}

/**
 * Pick a 5-char disambiguator slice from the concept id. We strip the
 * `concept_` prefix that every substrate-minted id carries — otherwise
 * the first 5 chars are always "conce" and the disambiguator is
 * useless. Falls back to the bare shortConceptId for ids that don't
 * follow the convention.
 */
function disambigSlice(id: string): string {
  const short = shortConceptId(id);
  const stripped = short.startsWith('concept_') ? short.slice('concept_'.length) : short;
  return stripped.slice(0, 5);
}

/**
 * Pre-scan a batch of concepts to build the collision index for
 * `conceptNotePath`. Returns a map from `<source_type>/<title>` to
 * the list of concept ids that would collide on that path.
 */
export function buildCollisionMap(concepts: ConceptRecord[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of concepts) {
    const sourceType = c.source_type || 'uncategorized';
    const title = conceptTitle(c);
    const key = `${sourceType}/${title}`;
    const arr = map.get(key) ?? [];
    arr.push(c.id);
    map.set(key, arr);
  }
  return map;
}

interface RenderOptions {
  pulledAt?: string;
}

function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

export function humanizeShape(shape: string): string {
  return (shape || 'Concept')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function humanizeEdgeType(edgeType: string): string {
  const t = edgeType.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function neighborDisplay(n: ConceptNeighbor): string {
  if (n.shape) return humanizeShape(n.shape);
  if (n.summary) return n.summary.replace(/\n+/g, ' ').slice(0, 80).trim();
  return shortConceptId(n.id);
}

/**
 * Compute the wikilink target for a neighbor. We want Obsidian's primary
 * filename-match resolver to succeed (rather than rely on the slower
 * alias-index fallback, which doesn't always fire reliably for
 * programmatically-created files until the metadataCache is fully
 * built).
 *
 * Filenames are `<Title Case>.md` within `<source_type>/` folders.
 * The neighbor record carries `shape` and (often) `source_type` so we
 * can reconstruct the title. We don't know if the neighbor's title
 * collides with another concept in its source_type folder — if it
 * does, the link will resolve to one of them (Obsidian's picker
 * surfaces the choice on click). The aliases short_id in the target's
 * frontmatter remains the safety net.
 *
 * Falls back to bare short_id when shape is missing — those neighbors
 * are usually concept-bridge-minted with no metadata and the alias
 * path is the only option.
 */
function neighborLinkTarget(n: ConceptNeighbor): string {
  if (!n.shape) return shortConceptId(n.id);
  return safeBaseName(humanizeShape(n.shape));
}

/**
 * Render a 7-character weight bar using block characters.
 * Each position represents 1/7 ≈ 14.3% of the weight.
 * Full blocks: █, partial: ▓, empty: ░
 */
function renderWeightBar(weight: number): string {
  const clamped = Math.max(0, Math.min(1, weight));
  const total = 7;
  const filled = clamped * total;
  const fullBlocks = Math.floor(filled);
  const partial = filled - fullBlocks;
  let bar = '█'.repeat(fullBlocks);
  if (partial >= 0.5 && fullBlocks < total) bar += '▓';
  else if (fullBlocks < total) bar += '';
  bar = bar.padEnd(total, '░');
  return bar;
}

/**
 * Render a single neighbor line with weight badge and visual bar.
 *
 * Format: - [[target|Display]] `w:0.85` ████▓░░ — description
 */
function renderNeighborLine(n: ConceptNeighbor): string {
  const target = neighborLinkTarget(n);
  const display = neighborDisplay(n);
  const weightParts: string[] = [];
  if (typeof n.edge_weight === 'number') {
    weightParts.push(`\`w:${n.edge_weight.toFixed(2)}\` ${renderWeightBar(n.edge_weight)}`);
  }
  const weightStr = weightParts.length ? ` ${weightParts.join('')}` : '';
  const tail = n.edge_description
    ? ` — ${n.edge_description.replace(/\n+/g, ' ').slice(0, 200)}`
    : '';
  return `- [[${target}|${display}]]${weightStr}${tail}`;
}

/**
 * Dedupe neighbors by (short_id, edge_type). Concept-db sometimes
 * returns the same edge twice when neighbor walks pick it up from
 * both directions.
 */
function dedupeNeighbors(neighbors: ConceptNeighbor[]): ConceptNeighbor[] {
  const seen = new Set<string>();
  const out: ConceptNeighbor[] = [];
  for (const n of neighbors) {
    const key = `${shortConceptId(n.id)}::${n.edge_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

function isBridgeNoise(n: ConceptNeighbor): boolean {
  return (n.edge_description || '').trim() === BRIDGE_NOISE_DESCRIPTION;
}

function compareEdgeTypes(a: string, b: string): number {
  const ai = EDGE_ORDER.indexOf(a);
  const bi = EDGE_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/**
 * Render the learning signal confidence callout.
 *
 * Callout type depends on success rate:
 *   [!success]  ≥ 66%
 *   [!warning]  33–66%
 *   [!danger]   < 33% with any loads
 *   [!tip]      never loaded (cold)
 *
 * Bar: 5 Unicode block chars, each = 20% of success rate.
 * Label: never validated / converging / reliable / confirmed
 */
function renderSignalCallout(concept: ConceptRecord): string {
  const loaded = concept.times_loaded ?? 0;
  const succeeded = concept.times_succeeded ?? 0;
  const rate = loaded > 0 ? succeeded / loaded : 0;
  const pct = Math.round(rate * 100);

  let calloutType: string;
  let label: string;
  if (loaded === 0) {
    calloutType = 'tip';
    label = 'never validated';
  } else if (rate >= 0.66) {
    calloutType = 'success';
    label = rate >= 0.9 ? 'confirmed' : 'reliable';
  } else if (rate >= 0.33) {
    calloutType = 'warning';
    label = 'converging';
  } else {
    calloutType = 'danger';
    label = 'converging';
  }

  // 5-char bar: each █ = 20%
  const filled = Math.round(rate * 5);
  const bar = '█'.repeat(filled) + '░'.repeat(5 - filled);

  return `> [!${calloutType}] Signal  ${bar}  ${pct}% · loaded ${loaded} · ${label}`;
}

/**
 * Render the Mermaid graph block for high-confidence edges (weight ≥ 0.6).
 * Limits to max 6 edges. Returns empty string if no qualifying edges.
 */
function renderMermaidGraph(concept: ConceptRecord, neighbors: ConceptNeighbor[]): string {
  const highConf = neighbors
    .filter((n) => typeof n.edge_weight === 'number' && n.edge_weight >= 0.6 && !isBridgeNoise(n))
    .sort((a, b) => (b.edge_weight ?? 0) - (a.edge_weight ?? 0))
    .slice(0, 6);
  if (highConf.length === 0) return '';

  const centerLabel = humanizeShape(concept.shape || concept.source_type || 'Concept');
  const lines: string[] = ['## Graph', '', '```mermaid', 'graph LR'];
  lines.push(`  this["${centerLabel}"]`);
  for (const n of highConf) {
    const display = neighborDisplay(n);
    const edgeType = n.edge_type || 'related_to';
    const w = (n.edge_weight ?? 0).toFixed(2);
    const safe = display.replace(/"/g, "'");
    lines.push(`  this -->|"${edgeType} ${w}"| n${shortConceptId(n.id).replace(/[^a-z0-9]/gi, '')}["${safe}"]`);
  }
  lines.push('```', '');
  return lines.join('\n');
}

/**
 * Render the `## Related` section. Substantive edges render as Title
 * Case subheadings with an emoji prefix; bridge-noise edges collapse
 * under a single `<details>` block at the bottom.
 */
export function renderRelatedSection(rawNeighbors: ConceptNeighbor[]): string {
  if (!rawNeighbors.length) return '';
  const neighbors = dedupeNeighbors(rawNeighbors);
  const signal: ConceptNeighbor[] = [];
  const noise: ConceptNeighbor[] = [];
  for (const n of neighbors) {
    (isBridgeNoise(n) ? noise : signal).push(n);
  }

  const groups = new Map<string, ConceptNeighbor[]>();
  for (const n of signal) {
    const key = n.edge_type || 'related_to';
    const arr = groups.get(key) ?? [];
    arr.push(n);
    groups.set(key, arr);
  }

  const parts: string[] = [];
  const hasSignal = groups.size > 0;
  if (hasSignal) {
    parts.push('## Related', '');
    const keys = Array.from(groups.keys()).sort(compareEdgeTypes);
    for (const key of keys) {
      const emoji = EDGE_EMOJI[key] || '🔗';
      parts.push(`### ${emoji} ${humanizeEdgeType(key)}`);
      const sorted = (groups.get(key)!).slice().sort(
        (a, b) => (b.edge_weight ?? 0) - (a.edge_weight ?? 0),
      );
      for (const n of sorted) parts.push(renderNeighborLine(n));
      parts.push('');
    }
  }

  if (noise.length) {
    if (!hasSignal) parts.push('## Related', '');
    parts.push('<details>');
    parts.push(`<summary>Auto-discovered (${noise.length})</summary>`);
    parts.push('');
    for (const n of noise) parts.push(renderNeighborLine(n));
    parts.push('');
    parts.push('</details>');
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Extract structured pointer fields. Returns a typed view; missing
 * fields are simply absent. We surface the three load-bearing fields
 * (type, path, section) — everything else stays inside `metadata` on
 * the concept record and is not re-emitted to YAML to keep the
 * pointer object compact and predictable.
 */
function pointerView(pointer: Record<string, unknown> | undefined): {
  type?: string;
  path?: string;
  section?: string;
  session_date?: string;
} {
  if (!pointer || typeof pointer !== 'object') return {};
  const out: { type?: string; path?: string; section?: string; session_date?: string } = {};
  if (typeof pointer.type === 'string') out.type = pointer.type;
  if (typeof pointer.path === 'string') out.path = pointer.path;
  if (typeof pointer.section === 'string') out.section = pointer.section;
  if (typeof pointer.session_date === 'string') out.session_date = pointer.session_date;
  return out;
}

/**
 * Group neighbors by edge_type and produce a YAML `related:` map whose
 * values are arrays of `"[[short_id]]"` wikilinks. The wikilink uses
 * the short id (not the humanized shape) so that Obsidian's filename
 * resolver doesn't fight with display titles — the short id is
 * registered as an alias on every concept note. Buckets with zero
 * neighbors are omitted.
 *
 * Returns the YAML-string lines (each pre-indented as a top-level
 * `related:` block), or null if there are no neighbors at all.
 */
function renderRelatedYaml(neighbors: ConceptNeighbor[]): string[] | null {
  if (!neighbors.length) return null;
  const deduped = dedupeNeighbors(neighbors);
  if (!deduped.length) return null;

  const buckets = new Map<string, ConceptNeighbor[]>();
  for (const n of deduped) {
    const key = n.edge_type || 'related_to';
    const arr = buckets.get(key) ?? [];
    arr.push(n);
    buckets.set(key, arr);
  }
  if (buckets.size === 0) return null;

  const lines: string[] = ['related:'];
  const keys = Array.from(buckets.keys()).sort(compareEdgeTypes);
  for (const key of keys) {
    const arr = buckets.get(key)!;
    lines.push(`  ${key}:`);
    for (const n of arr) {
      lines.push(`    - ${yamlQuote(`[[${shortConceptId(n.id)}]]`)}`);
    }
  }
  return lines;
}

/**
 * Render the `edges:` YAML block for a concept note. This is a parallel
 * structure to `related:` that adds weight and description metadata so
 * Dataview queries and downstream activities can rank relationships
 * without parsing prose.
 *
 * Format:
 *   edges:
 *     derived_from:
 *       - target: "[[short_id]]"
 *         weight: 0.90
 *         description: "…up to 120 chars…"
 *
 * Only emits entries that carry at least one of: a non-trivial weight
 * (>0) or a non-bridge-noise description. Returns null if there is
 * nothing meaningful to emit.
 */
function renderEdgesYaml(neighbors: ConceptNeighbor[]): string[] | null {
  if (!neighbors.length) return null;
  const deduped = dedupeNeighbors(neighbors);

  // Only emit entries with weight or meaningful description
  const interesting = deduped.filter(
    (n) =>
      (typeof n.edge_weight === 'number' && n.edge_weight > 0) ||
      (n.edge_description && !isBridgeNoise(n)),
  );
  if (!interesting.length) return null;

  const buckets = new Map<string, ConceptNeighbor[]>();
  for (const n of interesting) {
    const key = n.edge_type || 'related_to';
    const arr = buckets.get(key) ?? [];
    arr.push(n);
    buckets.set(key, arr);
  }

  const lines: string[] = ['edges:'];
  const keys = Array.from(buckets.keys()).sort(compareEdgeTypes);
  for (const key of keys) {
    lines.push(`  ${key}:`);
    for (const n of buckets.get(key)!) {
      const target = yamlQuote(`[[${shortConceptId(n.id)}]]`);
      lines.push(`    - target: ${target}`);
      if (typeof n.edge_weight === 'number') {
        lines.push(`      weight: ${n.edge_weight.toFixed(2)}`);
      }
      if (n.edge_description && !isBridgeNoise(n)) {
        const desc = n.edge_description
          .replace(/\n+/g, ' ')
          .trim()
          .slice(0, 120);
        lines.push(`      description: ${yamlQuote(desc)}`);
      }
    }
  }
  return lines;
}

/**
 * Render the data-shaped concept note.
 *
 * Frontmatter holds all queryable state (typed fields, nested pointer,
 * related as edge_type → wikilink-array map). Body holds only:
 *
 *   # {humanTitle}
 *
 *   {summary}
 *
 *   {optional user-edited prose — preserved through writeback}
 *
 *   ---
 *   *Source: [[{pointer.path}|§ {pointer.section}]]*
 *
 * The summary line + source footer are emitted by the formatter; the
 * strip path (concept-writeback-strip.ts) removes exactly those so
 * round-trip identity holds: stripWritebackEnvelope(render(c, "")) === "".
 */
export function renderConceptNote(
  concept: ConceptRecord,
  neighbors: ConceptNeighbor[] = [],
  options: RenderOptions = {},
): string {
  const pulledAt = options.pulledAt || new Date().toISOString();
  const shortId = shortConceptId(concept.id);
  const summary = (concept.summary || '').replace(/\n+/g, ' ').trim();
  const titleHuman = humanizeShape(concept.shape || concept.source_type || 'Concept');
  const ptr = pointerView(concept.pointer);

  // ─── Frontmatter ─────────────────────────────────────────────────────
  const fm: string[] = ['---'];
  fm.push(`concept_id: ${shortId}`);
  if (concept.shape) fm.push(`shape: ${concept.shape}`);
  if (concept.source_type) fm.push(`source_type: ${concept.source_type}`);
  if (summary) fm.push(`summary: ${yamlQuote(summary)}`);
  if (concept.relevance !== undefined) fm.push(`relevance: ${concept.relevance}`);
  // Numeric stats use the canonical (queryable) names. Counters that
  // are explicitly zero stay in the frontmatter so Dataview queries
  // can group "succeeded == 0" rows cleanly.
  if (concept.times_loaded !== undefined) fm.push(`loaded: ${concept.times_loaded}`);
  if (concept.times_succeeded !== undefined) fm.push(`succeeded: ${concept.times_succeeded}`);
  if (concept.times_failed !== undefined) fm.push(`failed: ${concept.times_failed}`);
  if (concept.updated_at) fm.push(`updated_at: ${concept.updated_at}`);
  fm.push(`last_substrate_pull_at: ${pulledAt}`);
  fm.push('pending_sync: false');
  fm.push('concept-db: true');

  // Pointer as a nested YAML object — typed fields the operator and
  // Dataview can both query without unpacking a free-form callout.
  if (ptr.type || ptr.path || ptr.section || ptr.session_date) {
    fm.push('pointer:');
    if (ptr.type) fm.push(`  type: ${ptr.type}`);
    if (ptr.path) fm.push(`  path: ${yamlQuote(ptr.path)}`);
    if (ptr.section) fm.push(`  section: ${yamlQuote(ptr.section)}`);
    if (ptr.session_date) fm.push(`  session_date: ${ptr.session_date}`);
  }

  // Relationships as a YAML map of edge_type -> [[wikilink]] arrays.
  // Obsidian's graph view picks these up as first-class edges.
  const relatedLines = renderRelatedYaml(neighbors);
  if (relatedLines) fm.push(...relatedLines);

  // Edge weights/descriptions as a structured YAML block so Dataview
  // and downstream activities can query weight-ranked relationships
  // without parsing prose. Grouped by edge_type; each entry carries
  // target wikilink, weight (2 dp), and description (≤120 chars).
  const edgesLines = renderEdgesYaml(neighbors);
  if (edgesLines) fm.push(...edgesLines);

  // Tags for Obsidian's tag pane. Nested form `concept/<source>` and
  // `shape/<slug>` lets the operator filter the whole vault by category
  // with a single click.
  const tags: string[] = [];
  if (concept.source_type) tags.push(`concept/${slugifyShape(concept.source_type)}`);
  if (concept.shape) tags.push(`shape/${slugifyShape(concept.shape)}`);
  if (tags.length) {
    fm.push('tags:');
    for (const t of tags) fm.push(`  - ${t}`);
  }

  fm.push('aliases:');
  fm.push(`  - ${shortId}`);
  if (concept.shape) {
    fm.push(`  - ${yamlQuote(titleHuman)}`);
    fm.push(`  - ${concept.shape}`);
  }
  fm.push('---');

  // ─── Body (minimal) ──────────────────────────────────────────────────
  // # title + summary one-liner + optional user prose + footer source.
  //
  // The user-prose region is whatever sits in `concept.content` that
  // is NOT just an echo of `summary`. Writeback strips the exact same
  // wrapper so this round-trips cleanly.
  let userProse = (concept.content || '').trim();
  if (summary && userProse === summary) userProse = '';

  const sourceFooter = renderSourceFooter(ptr);

  const signalCallout = renderSignalCallout(concept);
  const mermaidGraph = renderMermaidGraph(concept, neighbors);
  const relatedSection = renderRelatedSection(neighbors);

  const sections: string[] = [fm.join('\n'), '', `# ${titleHuman}`, ''];
  sections.push(signalCallout, '');
  if (summary) sections.push(summary, '');
  if (userProse) sections.push(userProse, '');
  if (relatedSection) sections.push(relatedSection);
  if (mermaidGraph) sections.push(mermaidGraph);
  if (sourceFooter) sections.push('---', sourceFooter);

  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Render the single-line `*Source: [[path|§ section]]*` footer, or
 * the operator-session variant for human_input pointers. Returns
 * empty string when the pointer carries no location signal — we
 * never emit a hollow `---` separator.
 */
function renderSourceFooter(ptr: ReturnType<typeof pointerView>): string {
  if (ptr.path) {
    const display = ptr.section ? `${ptr.path}|§ ${ptr.section}` : ptr.path;
    return `*Source: [[${display}]]*`;
  }
  if (ptr.type === 'human_input' && ptr.session_date) {
    return `*Source: operator session · ${ptr.session_date}*`;
  }
  return '';
}
