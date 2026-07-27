/**
 * presentation-arms.ts — the three answer-presentation renderers (the bandit's
 * arms). All three present the IDENTICAL answerBody; only structure and
 * affordances differ (one-change discipline, law 12), so posterior separation
 * measures presentation preference, not content. Chrome (header, grounding
 * badge, timestamp, attribution) is the caller's and identical across arms.
 *
 * Affordance clicks report to the grader ONLY when ev.isTrusted — synthetic
 * events from the plugin's own resolvers must not register as attention.
 */
import { MarkdownRenderer, type Component, type App } from 'obsidian';
import type { ArmKey } from './presentation-policy';

export interface ArmRenderHooks {
  armEvent(kind: 'expand' | 'more' | 'copyBtn'): void;
}

/** First paragraph, sentence-bounded, ≤240 chars. Deterministic — no LLM. */
function ledeOf(answer: string): string {
  const firstPara = answer.split(/\n\s*\n/)[0]?.trim() ?? answer.trim();
  const stripped = firstPara.replace(/^#+\s+/, '');
  if (stripped.length <= 240) return stripped;
  const cut = stripped.slice(0, 240);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastStop > 60 ? cut.slice(0, lastStop + 1) : cut).trim() + (lastStop > 60 ? '' : '…');
}

/** Non-empty lines/paragraph leads after the lede, markdown headers flattened. */
function digestLines(answer: string): string[] {
  return answer
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^#+\s+/, '').replace(/^[-*]\s+/, ''))
    .slice(1);
}

export function renderArmBody(
  app: App,
  component: Component,
  host: HTMLElement,
  armKey: ArmKey,
  answer: string,
  grounding: 'grounded' | 'unverified',
  hooks: ArmRenderHooks,
): void {
  host.addClass(`sub-answer--arm-${armKey}`);
  if (armKey === 'a') {
    const textEl = host.createDiv({ cls: 'sub-answer-text' });
    void MarkdownRenderer.render(app, answer, textEl, '/', component);
    return;
  }
  if (armKey === 'b') {
    const ledeEl = host.createDiv({ cls: 'sub-answer-text sub-answer-lede' });
    void MarkdownRenderer.render(app, ledeOf(answer), ledeEl, '/', component);
    const btn = host.createEl('button', { cls: 'sub-arm-btn sub-arm-expand', text: 'show full answer' });
    btn.addEventListener('click', (ev) => {
      if (!ev.isTrusted) return;
      btn.remove();
      const fullEl = host.createDiv({ cls: 'sub-answer-text' });
      void MarkdownRenderer.render(app, answer, fullEl, '/', component);
      hooks.armEvent('expand');
    });
    return;
  }
  // Arm C — structured scan card: pinned lede, tight digest bullets (cap 8,
  // trusted "…more"), explicit copy button, grounding as a left border.
  host.addClass(grounding === 'grounded' ? 'sub-arm-c--grounded' : 'sub-arm-c--unverified');
  host.createDiv({ cls: 'sub-arm-c-lede', text: ledeOf(answer) });
  const lines = digestLines(answer);
  const list = host.createEl('ul', { cls: 'sub-arm-c-digest' });
  const CAP = 8;
  for (const line of lines.slice(0, CAP)) list.createEl('li', { text: line.length > 160 ? line.slice(0, 160) + '…' : line });
  const actions = host.createDiv({ cls: 'sub-arm-c-actions' });
  if (lines.length > CAP) {
    const more = actions.createEl('button', { cls: 'sub-arm-btn sub-arm-more', text: `…more (${lines.length - CAP})` });
    more.addEventListener('click', (ev) => {
      if (!ev.isTrusted) return;
      more.remove();
      for (const line of lines.slice(CAP)) list.createEl('li', { text: line.length > 160 ? line.slice(0, 160) + '…' : line });
      hooks.armEvent('more');
    });
  }
  const copyBtn = actions.createEl('button', { cls: 'sub-arm-btn sub-arm-copy', text: 'copy answer' });
  copyBtn.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    void navigator.clipboard.writeText(answer);
    copyBtn.setText('copied ✓');
    hooks.armEvent('copyBtn');
  });
}
