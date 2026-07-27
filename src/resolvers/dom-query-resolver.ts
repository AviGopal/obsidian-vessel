/**
 * Resolver — `obsidian:dom_query`
 *
 * READ-ONLY, parameterized DOM read. Generalizes the hardcoded per-surface
 * readers (e.g. `obsidian:ui_view`, which knows the goal-dispatch panel's class
 * names) into ONE queryable shape: give it a CSS selector and any leaf, plugin
 * view, or DOM node in the workspace becomes observable. This is the observe-side
 * analogue of `obsidian:execute_command` collapsing the per-command plane — a
 * single generic reader replaces N bespoke readers.
 *
 * STRICTLY READ-ONLY. It only measures/serializes the DOM: querySelectorAll +
 * textContent/getBoundingClientRect. It NEVER writes innerHTML, never `.click()`,
 * never dispatchEvent, never eval/new Function. There is no mutating path.
 *
 * PRIVACY FLOOR — raw note/editor body is off-limits by default. The vessel
 * deliberately refuses raw editor text elsewhere (see observe-obsidian-events.ts,
 * which hashes the editor payload and NEVER inspects the body). To honor that same
 * floor, this resolver treats these regions as protected note-content:
 * `.cm-editor`, `.cm-content`, `.markdown-source-view` (CodeMirror / source mode)
 * and `.markdown-reading-view`, `.markdown-preview-view` (reading/preview mode).
 * By default (`include_editor` false) it protects that text two ways:
 *   1. Any matched node that IS or is INSIDE a protected region is dropped
 *      entirely (counted in `editor_excluded`).
 *   2. Any matched node that merely CONTAINS a protected region (an ancestor
 *      container whose `textContent` would otherwise fold in the note body) has
 *      its text / text_preview redacted to '' and is flagged `editor_redacted`
 *      (counted in `editor_redacted`). This closes the ancestor-textContent leak
 *      where a broad selector like `.workspace-leaf` would capture the editor body.
 * Geometry mode carries no text, so it is never redacted. Protected text is only
 * serialized when the caller explicitly sets `include_editor:true`, making any
 * capture of note/editor text a conscious, auditable opt-in rather than a silent
 * leak through a generic selector.
 *
 * Pointer:
 *   {
 *     type: 'obsidian:dom_query',
 *     selector: string,            // CSS selector (required)
 *     mode?: 'text'|'structure'|'geometry',  // default 'text'
 *     leaf_view_type?: string,     // scope to leaves of this view type;
 *                                  // else query the whole app document
 *     limit?: number,              // max matched nodes (default 50)
 *     include_editor?: boolean,    // default false — see PRIVACY FLOOR
 *   }
 */
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';
import { registerResolver } from './index';

interface DomQueryPointer {
  type: 'obsidian:dom_query';
  selector: string;
  mode?: 'text' | 'structure' | 'geometry';
  leaf_view_type?: string;
  limit?: number;
  include_editor?: boolean;
}

const DEFAULT_LIMIT = 50;
const PER_NODE_TEXT_CAP = 1500;
const PREVIEW_CAP = 120;
const TOTAL_OUTPUT_CAP = 8000;

// Note-content regions whose raw text is protected by the privacy floor:
// CodeMirror/source-mode surfaces AND reading/preview surfaces (both render the
// note body verbatim).
const EDITOR_GUARD_SELECTOR =
  '.cm-editor, .cm-content, .markdown-source-view, .markdown-reading-view, .markdown-preview-view';

function classesOf(el: Element): string[] {
  const cn = el.className;
  if (typeof cn !== 'string' || !cn.trim()) return [];
  return cn.trim().split(/\s+/).slice(0, 8);
}

// True when the node IS or is INSIDE a protected note-content region.
function isEditorNode(el: Element): boolean {
  return el.closest(EDITOR_GUARD_SELECTOR) !== null;
}

// True when the node CONTAINS a protected note-content region as a descendant —
// its textContent would otherwise fold in the protected body.
function containsEditorRegion(el: Element): boolean {
  return el.querySelector(EDITOR_GUARD_SELECTOR) !== null;
}

function serializeNode(
  el: Element,
  mode: 'text' | 'structure' | 'geometry',
  includeEditor: boolean,
): Record<string, unknown> {
  const tag = el.tagName.toLowerCase();
  const classes = classesOf(el);
  if (mode === 'geometry') {
    const r = (el as HTMLElement).getBoundingClientRect();
    return {
      tag,
      classes,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
    };
  }
  // Privacy floor: redact text for a container that folds in a protected region,
  // unless the caller explicitly opted in.
  const redactText = !includeEditor && containsEditorRegion(el);
  if (mode === 'structure') {
    const preview = redactText ? '' : (el.textContent ?? '').trim().slice(0, PREVIEW_CAP);
    const entry: Record<string, unknown> = {
      tag,
      id: el.id || null,
      classes,
      childCount: el.childElementCount,
      text_preview: preview,
    };
    if (redactText) entry.editor_redacted = true;
    return entry;
  }
  // mode === 'text'
  const text = redactText ? '' : (el.textContent ?? '').trim().slice(0, PER_NODE_TEXT_CAP);
  const entry: Record<string, unknown> = { tag, classes, text };
  if (redactText) entry.editor_redacted = true;
  return entry;
}

async function resolveDomQuery(pointer: ImpulsePointer, app: App): Promise<ResolverResult> {
  const p = pointer as unknown as DomQueryPointer;
  const selector = typeof p.selector === 'string' ? p.selector.trim() : '';
  const mode: 'text' | 'structure' | 'geometry' =
    p.mode === 'structure' || p.mode === 'geometry' ? p.mode : 'text';
  const limit =
    typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : DEFAULT_LIMIT;
  const includeEditor = p.include_editor === true;
  const leafViewType =
    typeof p.leaf_view_type === 'string' && p.leaf_view_type.trim()
      ? p.leaf_view_type.trim()
      : null;

  if (!selector) {
    return {
      content: JSON.stringify({
        shape: 'obsidian:dom_query',
        error: 'pointer.selector is required (a CSS selector string)',
      }),
      metadata: {
        shape: 'obsidian:dom_query',
        summary: 'dom_query error: missing selector',
        producedBy: 'obsidian-vessel',
      },
    };
  }

  // Resolve the query root(s): either each leaf.view.containerEl of the given
  // view type, or the whole app document (same document access ui-layout-metrics
  // uses).
  const roots: Array<{ scope: string; el: ParentNode }> = [];
  if (leafViewType) {
    const leaves = app.workspace.getLeavesOfType(leafViewType);
    for (let i = 0; i < leaves.length; i++) {
      const container = leaves[i]?.view?.containerEl;
      if (container) roots.push({ scope: `${leafViewType}#${i}`, el: container });
    }
  } else {
    roots.push({ scope: 'document', el: document });
  }

  const matches: Array<Record<string, unknown>> = [];
  let matchedTotal = 0;
  let excludedEditor = 0;
  let redactedEditor = 0;
  let selectorError: string | null = null;

  outer: for (const root of roots) {
    let nodes: Element[];
    try {
      nodes = Array.from(root.el.querySelectorAll(selector));
    } catch (err) {
      selectorError = err instanceof Error ? err.message : String(err);
      break;
    }
    for (const node of nodes) {
      if (!includeEditor && isEditorNode(node)) {
        excludedEditor += 1;
        continue;
      }
      matchedTotal += 1;
      if (matches.length >= limit) continue;
      const entry = serializeNode(node, mode, includeEditor);
      if (entry.editor_redacted === true) redactedEditor += 1;
      entry.scope = root.scope;
      matches.push(entry);
      // Cap total serialized output so a broad selector can't flood the trace.
      if (JSON.stringify(matches).length >= TOTAL_OUTPUT_CAP) break outer;
    }
  }

  if (selectorError) {
    return {
      content: JSON.stringify({
        shape: 'obsidian:dom_query',
        error: `invalid selector: ${selectorError}`,
        selector,
      }),
      metadata: {
        shape: 'obsidian:dom_query',
        summary: `dom_query error: invalid selector "${selector}"`,
        producedBy: 'obsidian-vessel',
      },
    };
  }

  const truncated = matchedTotal > matches.length;
  const report = {
    shape: 'obsidian:dom_query',
    selector,
    mode,
    scope: leafViewType ?? 'document',
    root_count: roots.length,
    matched: matchedTotal,
    returned: matches.length,
    truncated,
    editor_excluded: excludedEditor,
    editor_redacted: redactedEditor,
    include_editor: includeEditor,
    nodes: matches,
    measured_at: new Date().toISOString(),
  };

  return {
    content: JSON.stringify(report),
    metadata: {
      shape: 'obsidian:dom_query',
      summary:
        `dom_query "${selector}" (${mode}): ${matches.length}/${matchedTotal} nodes` +
        (leafViewType ? ` in ${leafViewType}` : ' in document') +
        (excludedEditor ? `, ${excludedEditor} editor nodes excluded` : '') +
        (redactedEditor ? `, ${redactedEditor} editor-containing nodes redacted` : ''),
      producedBy: 'obsidian-vessel',
    },
  };
}

registerResolver('obsidian:dom_query', resolveDomQuery);
