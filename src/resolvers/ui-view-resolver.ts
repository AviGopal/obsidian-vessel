/**
 * Resolver — `obsidian:ui_view`
 *
 * Read-only structural report of what the Obsidian UI currently looks like
 * (no pixels): the active file, the workspace leaves, and the state of the
 * goal-dispatch panel (event lines, verdict line, hollow marker) so UI
 * changes become verifiable through the vessel itself.
 */

import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';
import { registerResolver } from './index';
import { SUB_TOKEN_WHITELIST } from '../views/theme-token-override';

const GOAL_DISPATCH_VIEW_TYPE = 'obsidian-goal-dispatch';

async function resolveUiView(_pointer: ImpulsePointer, app: App): Promise<ResolverResult> {
  const activeFile = app.workspace.getActiveFile()?.path ?? null;
  const layout: Array<{ viewType: string; displayText: string }> = [];
  app.workspace.iterateAllLeaves((leaf) => {
    const viewType = leaf.view?.getViewType?.() ?? 'unknown';
    const displayText = leaf.view?.getDisplayText?.() ?? '';
    layout.push({ viewType, displayText });
  });

  const goalLeaves = app.workspace.getLeavesOfType(GOAL_DISPATCH_VIEW_TYPE);
  const goalLeaf = goalLeaves.length > 0 ? goalLeaves[0] : null;

  let goal_dispatch: Record<string, unknown> = { open: false };
  if (goalLeaf) {
    const container = goalLeaf.view.containerEl;
    const scroll = container.querySelector('.sub-scroll');
    const output = container.querySelector('.sub-feed');
    const lineEls = output ? Array.from(output.children) : [];
    const allLines = lineEls
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t.length > 0);
    const event_lines = allLines.slice(-20);
    const msgEls = output ? Array.from(output.querySelectorAll('.sub-feed-msg')) : [];
    let verdict_line: string | null = null;
    for (const el of msgEls) {
      const t = (el.textContent ?? '').trim();
      if (t.startsWith('reached:')) verdict_line = t;
    }
    const hollow = scroll ? scroll.classList.contains('sub-hollow') : false;
    // Effective design tokens on the panel root (inline overrides from
    // Substrate/theme-tokens.md included via computed style) — the read
    // surface for the legibility audit tick and for verifying token
    // round-trips without a screenshot.
    const rootEl = container.querySelector('.obsidian-goal-dispatch-view') as HTMLElement | null;
    const effective_tokens: Record<string, string> = {};
    if (rootEl) {
      const cs = window.getComputedStyle(rootEl);
      for (const key of SUB_TOKEN_WHITELIST) {
        const v = cs.getPropertyValue(key).trim();
        if (v) effective_tokens[key] = v;
      }
    }
    goal_dispatch = { open: true, event_lines, verdict_line, hollow, effective_tokens };
  }

  const report = { activeFile, layout, goal_dispatch };
  return {
    content: JSON.stringify(report),
    metadata: {
      shape: 'obsidian:ui_view',
      summary: 'structural UI view: ' + String(layout.length) + ' leaves, goal-dispatch ' + (goalLeaf ? 'open' : 'closed') + ', active file ' + (activeFile ?? '(none)'),
      producedBy: 'obsidian-vessel',
    },
  };
}

registerResolver('obsidian:ui_view', resolveUiView);
