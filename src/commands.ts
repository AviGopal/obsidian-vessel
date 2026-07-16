/**
 * Command Registration for Obsidian Vessel Plugin
 *
 * Registers all plugin commands with Obsidian's command palette.
 */

import { Notice, Plugin } from 'obsidian';
import type ObsidianVesselPlugin from './main';
import { sidecarResolveBody } from './sidecar-manager';

export function registerCommands(plugin: ObsidianVesselPlugin): void {

  // Reconnect to API
  plugin.addCommand({
    id: 'obsidian-reconnect',
    name: 'Obsidian: Reconnect to API',
    icon: 'plug',
    callback: async () => {
      const notice = new Notice('Reconnecting...', 0);
      try {
        await plugin.reconnect();
        notice.setMessage('Reconnected successfully');
        setTimeout(() => notice.hide(), 3000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        notice.setMessage(`Reconnection failed: ${errorMessage}`);
        setTimeout(() => notice.hide(), 5000);
      }
    }
  });

  // Concept Graph: Open Here
  // Reads concept_id from the active note's frontmatter, fetches a
  // 2-hop neighborhood from concept-db, writes a canvas under the
  // configured canvas folder, and opens it.
  plugin.addCommand({
    id: 'obsidian-concept-graph-open-here',
    name: 'Concept Graph: Open Here',
    icon: 'network',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file) return false;
      const cache = plugin.app.metadataCache.getFileCache(file);
      const conceptId = cache?.frontmatter?.concept_id;
      if (!conceptId) return false;
      if (checking) return true;
      void (async () => {
        if (!plugin.conceptCanvasBuilder || !plugin.conceptDbClient) {
          new Notice('Concept-DB frontend not initialized. Enable it in settings.');
          return;
        }
        const notice = new Notice('Building concept canvas...', 0);
        try {
          const path = await plugin.conceptCanvasBuilder.buildConceptCanvas(
            plugin.conceptDbClient,
            String(conceptId),
            { hops: 2, maxNodes: 25 },
          );
          await plugin.app.workspace.openLinkText(path, '', true);
          notice.setMessage('Concept canvas opened');
          setTimeout(() => notice.hide(), 2000);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          notice.setMessage(`Concept canvas failed: ${msg}`);
          setTimeout(() => notice.hide(), 5000);
        }
      })();
      return true;
    },
  });

  // Show Substrate Expectation
  plugin.addCommand({
    id: 'obsidian-vessel-show-expectation',
    name: 'Obsidian Vessel: Show substrate expectation',
    icon: 'sparkles',
    callback: async () => {
      // Sole path: shaped resolve through the federation sidecar (overlay-capable).
      const viaSidecar = await sidecarResolveBody({ type: 'implicitVesselReport' }, 5000);
      if (viaSidecar !== null) {
        new Notice(JSON.stringify(viaSidecar).slice(0, 300));
        return;
      }
      new Notice('Substrate expectation unavailable');
    },
  });

  // Open Settings
  plugin.addCommand({
    id: 'obsidian-open-settings',
    name: 'Obsidian: Open settings',
    icon: 'settings',
    callback: () => {
      // Open the plugin settings tab
      const setting = (plugin.app as any).setting;
      if (setting) {
        setting.open();
        setting.openTabById(plugin.manifest.id);
      }
    }
  });
}
