/**
 * UI Screenshot Resolver - Resolve obsidian:ui_screenshot pointers
 *
 * Captures the Obsidian UI via Electron capturePage. Default: the main
 * window (this plugin's webContents). pointer.scope === 'all' captures
 * EVERY visible BrowserWindow (pop-out panels live in their own windows),
 * returning one entry per window with its title. No top-level side effects.
 */
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';

interface CapturedImage {
  toPNG(): { toString(enc: string): string };
  getSize(): { width: number; height: number };
}
interface WebContentsLike {
  capturePage?: () => Promise<CapturedImage>;
}

export async function resolveUiScreenshot(pointer: ImpulsePointer, _app: App): Promise<ResolverResult> {
  try {
    const req0 = (window as unknown as { require?: (m: string) => unknown }).require;
    const remote = (req0 ? req0('@electron/remote') : null) as {
      getCurrentWebContents?: () => WebContentsLike;
      BrowserWindow?: { getAllWindows(): Array<{ getTitle(): string; isVisible(): boolean; webContents: WebContentsLike }> };
    } | null;
    const scope = (pointer as unknown as { scope?: string }).scope;
    if (scope === 'all') {
      const wins = remote?.BrowserWindow?.getAllWindows?.() ?? [];
      const windows: Array<Record<string, unknown>> = [];
      for (const w of wins) {
        try {
          if (!w.isVisible() || typeof w.webContents.capturePage !== 'function') continue;
          const image = await w.webContents.capturePage!();
          const { width, height } = image.getSize();
          windows.push({ title: w.getTitle(), media_type: 'image/png', data: image.toPNG().toString('base64'), width, height });
        } catch {
          /* skip windows that refuse capture */
        }
      }
      if (windows.length === 0) {
        return JSON.stringify({ shape: 'obsidian:ui_screenshot', error: 'no capturable windows (BrowserWindow unavailable?)' });
      }
      return JSON.stringify({ shape: 'obsidian:ui_screenshot', scope: 'all', windows, captured_at: new Date().toISOString() });
    }
    const wc = remote?.getCurrentWebContents?.();
    if (!wc || typeof wc.capturePage !== 'function') {
      return JSON.stringify({ shape: 'obsidian:ui_screenshot', error: 'capturePage unavailable in this environment' });
    }
    const image = await wc.capturePage!();
    const data = image.toPNG().toString('base64');
    const { width, height } = image.getSize();
    return JSON.stringify({ shape: 'obsidian:ui_screenshot', media_type: 'image/png', data, width, height, captured_at: new Date().toISOString() });
  } catch (err) {
    return JSON.stringify({ shape: 'obsidian:ui_screenshot', error: err instanceof Error ? err.message : String(err) });
  }
}
