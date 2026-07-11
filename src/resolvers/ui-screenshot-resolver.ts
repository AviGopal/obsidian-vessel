/**
 * UI Screenshot Resolver - Resolve obsidian:ui_screenshot pointers
 *
 * Captures the current Obsidian window via Electron capturePage.
 * No top-level side effects: Electron access happens only when invoked.
 */
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';

export async function resolveUiScreenshot(_pointer: ImpulsePointer, _app: App): Promise<ResolverResult> {
  try {
    const req0 = (window as unknown as { require?: (m: string) => unknown }).require;
    const remote = (req0 ? req0('@electron/remote') : null) as {
      getCurrentWebContents?: () => {
        capturePage?: () => Promise<{
          toPNG(): { toString(enc: string): string };
          getSize(): { width: number; height: number };
        }>;
      };
    } | null;
    const wc = remote?.getCurrentWebContents?.();
    if (!wc || typeof wc.capturePage !== 'function') {
      return JSON.stringify({ shape: 'obsidian:ui_screenshot', error: 'capturePage unavailable in this environment' });
    }
    const image = await wc.capturePage();
    const data = image.toPNG().toString('base64');
    const { width, height } = image.getSize();
    return JSON.stringify({ shape: 'obsidian:ui_screenshot', media_type: 'image/png', data, width, height, captured_at: new Date().toISOString() });
  } catch (err) {
    return JSON.stringify({ shape: 'obsidian:ui_screenshot', error: err instanceof Error ? err.message : String(err) });
  }
}
