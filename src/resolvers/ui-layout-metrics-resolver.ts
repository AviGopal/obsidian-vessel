/**
 * UI Layout Metrics Resolver - Resolve obsidian:ui_layout_metrics pointers
 *
 * Deterministic DOM measurement of the rendered workspace across ALL windows
 * (main + pop-outs, discovered via the documents that host workspace leaves):
 * pane boxes, sibling spacing gaps, truncation and overlap detection -
 * including the substrate panel's own sub-sections. Output format is
 * backward-compatible: flat arrays with a per-entry `win` label. No LLM, no
 * screenshot; measurement happens only when invoked.
 */
import type { App, WorkspaceLeaf } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';

function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 4 && cur.tagName.toLowerCase() !== 'body') {
    const cls = typeof cur.className === 'string' && cur.className.trim() ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    parts.unshift(cur.tagName.toLowerCase() + cls);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

interface PaneBox { win: string; path: string; x: number; y: number; w: number; h: number; }

function measureDoc(doc: Document, win: string, out: {
  panes: PaneBox[];
  overlaps: Array<{ win: string; a: string; b: string; area: number }>;
  truncated: Array<{ win: string; path: string; scroll_w: number; client_w: number; text: string }>;
  spacing_samples: Array<{ win: string; container: string; vertical_gaps: number[] }>;
}): void {
  const view = doc.defaultView;
  if (!view) return;
  const leaves = Array.from(doc.querySelectorAll<HTMLElement>('.workspace-leaf'));
  const panes: PaneBox[] = leaves.map((el) => {
    const r = el.getBoundingClientRect();
    return { win, path: cssPath(el), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  out.panes.push(...panes);
  for (let i = 0; i < panes.length; i++) {
    for (let j = i + 1; j < panes.length; j++) {
      const a = panes[i]!, b = panes[j]!;
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      if (ox > 1 && oy > 1) out.overlaps.push({ win, a: a.path, b: b.path, area: ox * oy });
    }
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.workspace *, .sub-section *'))) {
    if (out.truncated.length >= 40) break;
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      const st = view.getComputedStyle(el);
      if (st.textOverflow === 'ellipsis' || st.overflow === 'hidden' || st.overflowX === 'hidden') {
        out.truncated.push({ win, path: cssPath(el), scroll_w: el.scrollWidth, client_w: el.clientWidth, text: (el.textContent || '').trim().slice(0, 60) });
      }
    }
  }
  for (const container of Array.from(doc.querySelectorAll<HTMLElement>('.workspace-leaf-content, .nav-files-container, .status-bar, .sub-section, .sub-pulse-row')).slice(0, 20)) {
    const kids = Array.from(container.children).filter((c): c is HTMLElement => c instanceof view.HTMLElement && c.offsetHeight > 0);
    const gaps: number[] = [];
    for (let i = 1; i < kids.length && gaps.length < 20; i++) {
      const prev = kids[i - 1]!.getBoundingClientRect();
      const cur = kids[i]!.getBoundingClientRect();
      const gap = Math.round(cur.top - prev.bottom);
      if (Number.isFinite(gap)) gaps.push(gap);
    }
    if (gaps.length) out.spacing_samples.push({ win, container: cssPath(container), vertical_gaps: gaps });
  }
}

export async function resolveUiLayoutMetrics(_pointer: ImpulsePointer, app: App): Promise<ResolverResult> {
  try {
    const docs = new Map<Document, string>();
    docs.set(document, 'main');
    let popoutIndex = 0;
    app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const doc = (leaf as unknown as { view?: { containerEl?: HTMLElement } }).view?.containerEl?.ownerDocument;
      if (doc && !docs.has(doc)) {
        popoutIndex += 1;
        docs.set(doc, `popout-${popoutIndex}`);
      }
    });
    const out = {
      panes: [] as PaneBox[],
      overlaps: [] as Array<{ win: string; a: string; b: string; area: number }>,
      truncated: [] as Array<{ win: string; path: string; scroll_w: number; client_w: number; text: string }>,
      spacing_samples: [] as Array<{ win: string; container: string; vertical_gaps: number[] }>,
    };
    for (const [doc, label] of docs) measureDoc(doc, label, out);
    return JSON.stringify({
      shape: 'obsidian:ui_layout_metrics',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      window_count: docs.size,
      pane_count: out.panes.length,
      panes: out.panes,
      overlaps: out.overlaps,
      truncated_count: out.truncated.length,
      truncated: out.truncated,
      spacing_samples: out.spacing_samples,
      measured_at: new Date().toISOString(),
    });
  } catch (err) {
    return JSON.stringify({ shape: 'obsidian:ui_layout_metrics', error: err instanceof Error ? err.message : String(err) });
  }
}
