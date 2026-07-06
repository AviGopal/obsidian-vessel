/**
 * Runtime design-token override.
 *
 * The plugin reads an optional vault note `Substrate/theme-tokens.md`
 * (frontmatter or fenced block or plain lines of `--sub-*: value` pairs),
 * validates keys against the whitelist of tokens defined in styles.css, and
 * applies them as inline custom properties on the goal-dispatch panel root.
 *
 * This is the load-bearing hook for the uiFeedback loop: the substrate can
 * adjust token VALUES (via obsidian:write_note, which is already restricted
 * to the Substrate/ prefix) without a plugin rebuild. Invalid or unknown
 * keys are ignored and logged.
 */

export const THEME_TOKENS_NOTE_PATH = 'Substrate/theme-tokens.md';

/** Whitelist — must mirror the --sub-* tokens declared in styles.css. */
export const SUB_TOKEN_WHITELIST: ReadonlySet<string> = new Set([
  '--sub-font-s',
  '--sub-font-m',
  '--sub-font-l',
  '--sub-space-1',
  '--sub-space-2',
  '--sub-space-3',
  '--sub-radius-s',
  '--sub-radius-m',
  '--sub-text',
  '--sub-text-muted',
  '--sub-text-faint',
  '--sub-accent',
  '--sub-error',
  '--sub-ok',
  '--sub-fail',
  '--sub-warn',
  '--sub-run',
  '--sub-info',
  '--sub-concept',
  '--sub-provenance-substrate',
  '--sub-provenance-operator',
  '--sub-border',
  '--sub-bg',
  '--sub-bg-alt',
  '--sub-bg-card',
  '--sub-bg-hover',
]);

/** Reject CSS-injection-shaped values; allow lengths, colors, var() refs. */
const VALUE_SAFE = /^[a-zA-Z0-9#%(),.\s\/*+-]+$/;
const VALUE_FORBIDDEN = /url\s*\(|expression|;|\{|\}|@|\\/i;

export interface ParsedTokens {
  applied: Record<string, string>;
  ignored: string[];
}

/**
 * Parse `--sub-x: value` pairs out of the note text. Matches pairs anywhere
 * in the document (frontmatter, fenced blocks, plain lines) so the substrate
 * does not need to know one exact format.
 */
export function parseThemeTokens(text: string): ParsedTokens {
  const applied: Record<string, string> = {};
  const ignored: string[] = [];
  const re = /^\s*["']?(--sub-[a-z0-9-]+)["']?\s*:\s*["']?([^\n"']+?)["']?\s*;?\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].trim();
    const value = m[2].trim();
    if (!SUB_TOKEN_WHITELIST.has(key)) {
      ignored.push(`${key} (unknown token)`);
      continue;
    }
    if (!value || !VALUE_SAFE.test(value) || VALUE_FORBIDDEN.test(value)) {
      ignored.push(`${key} (unsafe value: ${value.slice(0, 40)})`);
      continue;
    }
    applied[key] = value;
  }
  return { applied, ignored };
}

/**
 * Apply parsed tokens as inline custom properties on a panel root element,
 * clearing any previously applied whitelist tokens first so removals in the
 * note take effect.
 */
export function applyThemeTokens(root: HTMLElement, tokens: Record<string, string>): void {
  for (const key of SUB_TOKEN_WHITELIST) {
    root.style.removeProperty(key);
  }
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}
