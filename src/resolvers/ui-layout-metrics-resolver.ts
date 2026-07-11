/**
 * UI Layout Metrics Resolver - Resolve obsidian:ui_layout_metrics pointers
 *
 * Deterministic DOM measurement of the rendered workspace: pane boxes,
 * sibling spacing gaps, truncation and overlap detection. No LLM, no
 * screenshot - precise numbers the substrate judges against its design
 * expectations (Substrate/theme-tokens.md). Measurement happens only when
 * the resolver is invoked; no top-level side effects.
 */
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';

function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 4 && cur !== document.body) {
    const cls = typeof cur.className === 'string' && cur.className.trim() ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    parts.unshift(cur.tagName.toLowerCase() + cls);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

export async function resolveUiLayoutMetrics(_pointer: ImpulsePointer, _app: App): Promise<ResolverResult> {
  try {
    const leaves = Array.from(document.querySelectorAll<HTMLElement>('.workspace-leaf'));
    const panes = leaves.map((el) => {
      const r = el.getBoundingClientRect();
      return { path: cssPath(el), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const overlaps: Array<{ a: string; b: string; area: number }> = [];
    for (let i = 0; i < panes.length; i++) {
      for (let j = i + 1; j < panes.length; j++) {
        const a = panes[i]!, b = panes[j]!;
        const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        if (ox > 1 && oy > 1) overlaps.push({ a: a.path, b: b.path, area: ox * oy });
      }
    }
    const truncated: Array<{ path: string; scroll_w: number; client_w: number; text: string }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.workspace *'))) {
      if (truncated.length >= 40) break;
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
        const st = getComputedStyle(el);
        if (st.textOverflow === 'ellipsis' || st.overflow === 'hidden' || st.overflowX === 'hidden') {
          truncated.push({ path: cssPath(el), scroll_w: el.scrollWidth, client_w: el.clientWidth, text: (el.textContent || '').trim().slice(0, 60) });
        }
      }
    }
    const spacing_samples: Array<{ container: string; vertical_gaps: number[] }> = [];
    for (const container of Array.from(document.querySelectorAll<HTMLElement>('.workspace-leaf-content, .nav-files-container, .status-bar')).slice(0, 12)) {
      const kids = Array.from(container.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.offsetHeight > 0);
      const gaps: number[] = [];
      for (let i = 1; i < kids.length && gaps.length < 20; i++) {
        const prev = kids[i - 1]!.getBoundingClientRect();
        const cur = kids[i]!.getBoundingClientRect();
        const gap = Math.round(cur.top - prev.bottom);
        if (Number.isFinite(gap)) gaps.push(gap);
      }
      if (gaps.length) spacing_samples.push({ container: cssPath(container), vertical_gaps: gaps });
    }
    return JSON.stringify({
      shape: 'obsidian:ui_layout_metrics',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      pane_count: panes.length,
      panes,
      overlaps,
      truncated_count: truncated.length,
      truncated,
      spacing_samples,
      measured_at: new Date().toISOString(),
    });
  } catch (err) {
    return JSON.stringify({ shape: 'obsidian:ui_layout_metrics', error: err instanceof Error ? err.message : String(err) });
  }
}
