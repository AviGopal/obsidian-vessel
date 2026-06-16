/**
 * Command Registration for Metabob Vessel Plugin
 *
 * Registers all plugin commands with Obsidian's command palette.
 */

import { Notice } from 'obsidian';
import type MetabobVesselPlugin from './main';
import { VesselStatusModal } from './modals/vessel-status-modal';
import { ExecutionIdModal } from './modals/execution-id-modal';
import { ExecutionSearchModal } from './modals/execution-search-modal';
import { TemplatesBrowserModal } from './modals/templates-browser-modal';

export function registerCommands(plugin: MetabobVesselPlugin): void {

  // Force Sync Command
  plugin.addCommand({
    id: 'metabob-force-sync',
    name: 'Metabob: Force sync executions',
    icon: 'refresh-cw',
    callback: async () => {
      if (!plugin.syncService) {
        new Notice('Sync service not initialized');
        return;
      }
      const notice = new Notice('Syncing executions...', 0);
      try {
        const count = await plugin.syncService.syncHistorical((current, total) => {
          notice.setMessage(`Syncing ${current}/${total}...`);
        });
        notice.setMessage(`Synced ${count} executions`);
        setTimeout(() => notice.hide(), 3000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        notice.setMessage(`Sync failed: ${errorMessage}`);
        setTimeout(() => notice.hide(), 5000);
      }
    }
  });

  // Open Live Canvas
  plugin.addCommand({
    id: 'metabob-open-live-canvas',
    name: 'Metabob: Open execution canvas',
    icon: 'layout-dashboard',
    callback: async () => {
      await plugin.openExecutionCanvas();
    }
  });

  // Open Composition Graph Canvas
  plugin.addCommand({
    id: 'metabob-open-composition-canvas',
    name: 'Metabob: Show activity composition graph',
    icon: 'network',
    callback: async () => {
      await plugin.openCompositionCanvas();
    }
  });

  // Show Vessel Status
  plugin.addCommand({
    id: 'metabob-vessel-status',
    name: 'Metabob: Show vessel status',
    icon: 'activity',
    callback: () => {
      new VesselStatusModal(plugin.app, plugin).open();
    }
  });

  // Create Note from Execution ID
  plugin.addCommand({
    id: 'metabob-create-execution-note',
    name: 'Metabob: Create note from execution ID',
    icon: 'file-plus',
    callback: async () => {
      new ExecutionIdModal(plugin.app, async (executionId) => {
        await plugin.createNoteFromExecution(executionId);
      }).open();
    }
  });

  // Search Executions
  plugin.addCommand({
    id: 'metabob-search-executions',
    name: 'Metabob: Search executions',
    icon: 'search',
    callback: () => {
      new ExecutionSearchModal(plugin.app, plugin).open();
    }
  });

  // Browse Templates
  plugin.addCommand({
    id: 'metabob-browse-templates',
    name: 'Metabob: Browse activity templates',
    icon: 'layout-template',
    callback: () => {
      new TemplatesBrowserModal(plugin.app, plugin).open();
    }
  });

  // Reconnect to API
  plugin.addCommand({
    id: 'metabob-reconnect',
    name: 'Metabob: Reconnect to API',
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

  // Show Recent Executions
  plugin.addCommand({
    id: 'metabob-recent-executions',
    name: 'Metabob: Show recent executions',
    icon: 'clock',
    callback: () => {
      new ExecutionSearchModal(plugin.app, plugin, { recent: true }).open();
    }
  });

  // Show Failed Executions
  plugin.addCommand({
    id: 'metabob-failed-executions',
    name: 'Metabob: Show failed executions',
    icon: 'alert-circle',
    callback: () => {
      new ExecutionSearchModal(plugin.app, plugin, { filter: 'failed' }).open();
    }
  });

  // Concept Graph: Open Here
  // Reads concept_id from the active note's frontmatter, fetches a
  // 2-hop neighborhood from concept-db, writes a canvas under the
  // configured canvas folder, and opens it.
  plugin.addCommand({
    id: 'metabob-concept-graph-open-here',
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

  // Open Settings
  plugin.addCommand({
    id: 'metabob-open-settings',
    name: 'Metabob: Open settings',
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
