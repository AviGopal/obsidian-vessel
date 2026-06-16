/**
 * Settings Tab for Metabob Vessel Plugin
 *
 * Provides the UI for configuring the plugin in Obsidian's settings.
 * Organized into sections: Connection, Sync, HTTP Server, Note Formatting, and Canvas.
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type MetabobVesselPlugin from './main';
import { DEFAULT_SETTINGS, validateSettings, generateVesselId } from './settings';

/**
 * Settings tab for the Metabob Vessel plugin
 */
export class MetabobVesselSettingTab extends PluginSettingTab {
  plugin: MetabobVesselPlugin;

  constructor(app: App, plugin: MetabobVesselPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    containerEl.createEl('h1', { text: 'Metabob Vessel Settings' });

    // Create all sections
    this.createConnectionSection(containerEl);
    this.createSyncSection(containerEl);
    this.createHttpServerSection(containerEl);
    this.createNoteFormattingSection(containerEl);
    this.createCanvasSection(containerEl);
    this.createConceptDbSection(containerEl);
    this.createStatusSection(containerEl);
    this.createActionsSection(containerEl);
  }

  /**
   * Concept-DB frontend section. See proposal
   * 2026-05-30-obsidian-vessel-concept-db-frontend.
   */
  private createConceptDbSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Concept-DB Frontend' });
    containerEl.createEl('p', {
      text:
        'Mirror concept-db into the vault. When enabled, concepts ' +
        'materialize as notes under the sync root; edges render as ' +
        'wikilinks. Writeback (opt-in) propagates vault edits back to ' +
        'concept-db.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Enable concept-db sync')
      .setDesc('Pull concepts from concept-db into the vault.')
      .addToggle(t =>
        t
          .setValue(this.plugin.settings.enableConceptDbSync)
          .onChange(async (v) => {
            this.plugin.settings.enableConceptDbSync = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Concept-DB endpoint')
      .setDesc('HTTP URL for concept-db (default: local substrate host port).')
      .addText(t =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.conceptDbEndpoint)
          .setValue(this.plugin.settings.conceptDbEndpoint)
          .onChange(async (v) => {
            this.plugin.settings.conceptDbEndpoint = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Concept-DB API key')
      .setDesc('Leave blank to reuse the Activity API key.')
      .addText(t =>
        t
          .setPlaceholder('(uses Activity API key if blank)')
          .setValue(this.plugin.settings.conceptDbApiKey)
          .onChange(async (v) => {
            this.plugin.settings.conceptDbApiKey = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sync root folder')
      .setDesc('Vault folder where concept notes live.')
      .addText(t =>
        t
          .setPlaceholder(DEFAULT_SETTINGS.conceptDbSyncRoot)
          .setValue(this.plugin.settings.conceptDbSyncRoot)
          .onChange(async (v) => {
            this.plugin.settings.conceptDbSyncRoot = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Sync interval (seconds)')
      .setDesc('How often to pull concept-db (default 300).')
      .addText(t =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.conceptDbSyncIntervalSec))
          .setValue(String(this.plugin.settings.conceptDbSyncIntervalSec))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.conceptDbSyncIntervalSec = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName('Source types (comma-separated)')
      .setDesc(
        'Restrict sync to these source_types. Empty = all except ' +
          'impulse_signature (which would dominate the vault).',
      )
      .addText(t =>
        t
          .setPlaceholder('(all except impulse_signature)')
          .setValue(this.plugin.settings.conceptDbSyncSourceTypes.join(','))
          .onChange(async (v) => {
            this.plugin.settings.conceptDbSyncSourceTypes = v
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Enable writeback')
      .setDesc(
        'Propagate vault edits back to concept-db on save. Requires ' +
          'Enable concept-db sync.',
      )
      .addToggle(t =>
        t
          .setValue(this.plugin.settings.enableConceptDbWriteback)
          .onChange(async (v) => {
            this.plugin.settings.enableConceptDbWriteback = v;
            await this.plugin.saveSettings();
          }),
      );
  }

  /**
   * Connection settings section
   */
  private createConnectionSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Connection' });
    containerEl.createEl('p', {
      text: 'Configure the connection to the Metabob Activity API.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Activity API URL')
      .setDesc('URL of the metabob-activity-api server')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.activityApiUrl)
        .setValue(this.plugin.settings.activityApiUrl)
        .onChange(async (value) => {
          this.plugin.settings.activityApiUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Authentication key for the Activity API')
      .addText(text => {
        text
          .setPlaceholder('Enter API key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(containerEl)
      .setName('Organization ID')
      .setDesc('Your organization ID for multi-tenant isolation')
      .addText(text => text
        .setPlaceholder('Enter organization ID')
        .setValue(this.plugin.settings.orgId)
        .onChange(async (value) => {
          this.plugin.settings.orgId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify connection to the Activity API')
      .addButton(button => button
        .setButtonText('Test')
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Testing...');

          try {
            const response = await fetch(`${this.plugin.settings.activityApiUrl}/health`);
            if (response.ok) {
              new Notice('Connection successful!');
            } else {
              new Notice(`Connection failed: HTTP ${response.status}`);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Connection failed: ${message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText('Test');
          }
        }));
  }

  /**
   * Sync preferences section
   */
  private createSyncSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Sync Preferences' });
    containerEl.createEl('p', {
      text: 'Configure how and when execution data is synchronized.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Execution Notes Folder')
      .setDesc('Folder where execution trace notes will be created')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.executionNotesFolder)
        .setValue(this.plugin.settings.executionNotesFolder)
        .onChange(async (value) => {
          this.plugin.settings.executionNotesFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Activity Templates Folder')
      .setDesc('Folder where activity template notes will be created')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.activityTemplatesFolder)
        .setValue(this.plugin.settings.activityTemplatesFolder)
        .onChange(async (value) => {
          this.plugin.settings.activityTemplatesFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Canvas Folder')
      .setDesc('Folder where generated canvases will be stored')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.canvasFolder)
        .setValue(this.plugin.settings.canvasFolder)
        .onChange(async (value) => {
          this.plugin.settings.canvasFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync on Start')
      .setDesc('Automatically sync execution data when Obsidian starts')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnStart)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStart = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Historical Sync Limit')
      .setDesc('Maximum number of historical executions to sync (10-1000)')
      .addSlider(slider => slider
        .setLimits(10, 1000, 10)
        .setValue(this.plugin.settings.historicalSyncLimit)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.historicalSyncLimit = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Sync Interval')
      .setDesc('Minutes between automatic syncs (1-60)')
      .addSlider(slider => slider
        .setLimits(1, 60, 1)
        .setValue(this.plugin.settings.syncIntervalMinutes)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.syncIntervalMinutes = value;
          await this.plugin.saveSettings();
        }));
  }

  /**
   * HTTP Server settings section
   */
  private createHttpServerSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'HTTP Server' });
    containerEl.createEl('p', {
      text: 'Configure the local HTTP server for impulse resolution requests.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Enable HTTP Server')
      .setDesc('Run a local HTTP server to handle impulse resolution requests')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.serverEnabled)
        .onChange(async (value) => {
          this.plugin.settings.serverEnabled = value;
          await this.plugin.saveSettings();
          if (value) {
            new Notice('HTTP server will start on next reload');
          } else {
            new Notice('HTTP server will stop on next reload');
          }
        }));

    new Setting(containerEl)
      .setName('Server Port')
      .setDesc('Port number for the HTTP server (1024-65535)')
      .addText(text => text
        .setPlaceholder(String(DEFAULT_SETTINGS.serverPort))
        .setValue(String(this.plugin.settings.serverPort))
        .onChange(async (value) => {
          const port = parseInt(value, 10);
          if (!isNaN(port) && port >= 1024 && port <= 65535) {
            this.plugin.settings.serverPort = port;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Allowed Origins')
      .setDesc('CORS origins allowed to access the server (comma-separated, supports wildcards)')
      .addTextArea(text => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.allowedOrigins.join(', '))
          .setValue(this.plugin.settings.allowedOrigins.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.allowedOrigins = value
              .split(',')
              .map(s => s.trim())
              .filter(s => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 2;
      });

    // Vessel Registration subsection
    containerEl.createEl('h3', { text: 'Vessel Registration' });

    new Setting(containerEl)
      .setName('Vessel ID')
      .setDesc('Unique identifier for this vessel instance')
      .addText(text => text
        .setPlaceholder('Auto-generated if empty')
        .setValue(this.plugin.settings.vesselId)
        .onChange(async (value) => {
          this.plugin.settings.vesselId = value;
          await this.plugin.saveSettings();
        }))
      .addButton(button => button
        .setButtonText('Generate')
        .onClick(async () => {
          this.plugin.settings.vesselId = generateVesselId();
          await this.plugin.saveSettings();
          this.display();
          new Notice('New vessel ID generated');
        }));

    new Setting(containerEl)
      .setName('Vessel Name')
      .setDesc('Human-readable name for this vessel')
      .addText(text => text
        .setPlaceholder(DEFAULT_SETTINGS.vesselName)
        .setValue(this.plugin.settings.vesselName)
        .onChange(async (value) => {
          this.plugin.settings.vesselName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Supported Shapes')
      .setDesc('Impulse shapes this vessel can resolve (comma-separated)')
      .addTextArea(text => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.shapes.join(', '))
          .setValue(this.plugin.settings.shapes.join(', '))
          .onChange(async (value) => {
            this.plugin.settings.shapes = value
              .split(',')
              .map(s => s.trim())
              .filter(s => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 3;
      });
  }

  /**
   * Note formatting settings section
   */
  private createNoteFormattingSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Note Formatting' });
    containerEl.createEl('p', {
      text: 'Configure how execution notes are formatted.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Note Template')
      .setDesc('Template style for execution notes')
      .addDropdown(dropdown => dropdown
        .addOption('detailed', 'Detailed - Full execution information')
        .addOption('compact', 'Compact - Summary only')
        .addOption('custom', 'Custom - Use custom template')
        .setValue(this.plugin.settings.noteTemplate)
        .onChange(async (value) => {
          this.plugin.settings.noteTemplate = value as 'detailed' | 'compact' | 'custom';
          await this.plugin.saveSettings();
          this.display(); // Refresh to show/hide custom template
        }));

    // Show custom template input only when 'custom' is selected
    if (this.plugin.settings.noteTemplate === 'custom') {
      new Setting(containerEl)
        .setName('Custom Template')
        .setDesc('Custom template string using Handlebars-like syntax. Available variables: {{execution_id}}, {{activity_id}}, {{success}}, {{duration_ms}}, {{cost}}, {{executed_at}}, {{tasks}}, {{tool_calls}}')
        .addTextArea(text => {
          text
            .setPlaceholder('# {{activity_id}}\n\n**Status:** {{#if success}}Success{{else}}Failed{{/if}}\n**Duration:** {{duration_ms}}ms')
            .setValue(this.plugin.settings.customTemplate)
            .onChange(async (value) => {
              this.plugin.settings.customTemplate = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 10;
          text.inputEl.style.width = '100%';
          text.inputEl.style.fontFamily = 'monospace';
        });
    }

    new Setting(containerEl)
      .setName('Include Tool Calls')
      .setDesc('Include detailed tool call information in execution notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeToolCalls)
        .onChange(async (value) => {
          this.plugin.settings.includeToolCalls = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Include Diffs')
      .setDesc('Include file diffs and state changes in execution notes')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeDiffs)
        .onChange(async (value) => {
          this.plugin.settings.includeDiffs = value;
          await this.plugin.saveSettings();
        }));
  }

  /**
   * Canvas settings section
   */
  private createCanvasSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Canvas' });
    containerEl.createEl('p', {
      text: 'Configure canvas generation and layout options.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Auto-Update Canvas')
      .setDesc('Automatically update canvases when new executions are synced')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.canvasAutoUpdate)
        .onChange(async (value) => {
          this.plugin.settings.canvasAutoUpdate = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Canvas Layout')
      .setDesc('Layout algorithm for activity canvases')
      .addDropdown(dropdown => dropdown
        .addOption('hierarchical', 'Hierarchical - Tree-based layout')
        .addOption('force-directed', 'Force-Directed - Physics-based layout')
        .addOption('timeline', 'Timeline - Chronological layout')
        .setValue(this.plugin.settings.canvasLayout)
        .onChange(async (value) => {
          this.plugin.settings.canvasLayout = value as 'hierarchical' | 'force-directed' | 'timeline';
          await this.plugin.saveSettings();
        }));
  }

  /**
   * Status display section
   */
  private createStatusSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Status' });

    // Try to get status from plugin if available
    let status: { apiConnected?: boolean; serverRunning?: boolean; syncedCount?: number; lastSyncedAt?: string | null } = {};
    if (typeof this.plugin.getStatus === 'function') {
      try {
        status = this.plugin.getStatus();
      } catch {
        // Plugin may not have getStatus implemented yet
      }
    }

    const statusContainer = containerEl.createDiv({ cls: 'setting-item' });
    statusContainer.createEl('div', { cls: 'setting-item-info' }, (el) => {
      el.createEl('div', { cls: 'setting-item-name', text: 'Current Status' });
      el.createEl('div', { cls: 'setting-item-description' }, (desc) => {
        desc.createEl('div', {
          text: `API: ${status.apiConnected ? 'Connected' : 'Disconnected'}`
        });
        desc.createEl('div', {
          text: `Server: ${status.serverRunning ? `Running on port ${this.plugin.settings.serverPort}` : 'Stopped'}`
        });
        if (status.syncedCount !== undefined) {
          desc.createEl('div', {
            text: `Synced: ${status.syncedCount} executions`
          });
        }
        if (status.lastSyncedAt) {
          desc.createEl('div', {
            text: `Last sync: ${new Date(status.lastSyncedAt).toLocaleString()}`
          });
        }
      });
    });

    // Registered shapes display
    const shapesContainer = containerEl.createDiv({ cls: 'setting-item' });
    shapesContainer.createEl('div', { cls: 'setting-item-info' }, (el) => {
      el.createEl('div', { cls: 'setting-item-name', text: 'Registered Impulse Shapes' });
      el.createEl('div', { cls: 'setting-item-description' }, (desc) => {
        const shapes = this.plugin.settings.shapes;
        if (shapes.length === 0) {
          desc.createEl('div', { text: 'No shapes registered' });
        } else {
          const list = desc.createEl('ul');
          for (const shape of shapes) {
            list.createEl('li', { text: shape });
          }
        }
      });
    });
  }

  /**
   * Actions section
   */
  private createActionsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Actions' });

    new Setting(containerEl)
      .setName('Validate Settings')
      .setDesc('Check settings for errors')
      .addButton(button => button
        .setButtonText('Validate')
        .onClick(() => {
          const errors = validateSettings(this.plugin.settings);
          if (errors.length === 0) {
            new Notice('All settings are valid!');
          } else {
            new Notice(`Settings errors:\n${errors.join('\n')}`);
          }
        }));

    new Setting(containerEl)
      .setName('Sync Now')
      .setDesc('Manually trigger a sync with the Activity API')
      .addButton(button => button
        .setButtonText('Sync')
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Syncing...');

          try {
            if (typeof this.plugin.triggerSync === 'function') {
              await this.plugin.triggerSync();
              new Notice('Sync completed');
              this.display();
            } else {
              new Notice('Sync not available');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Sync failed: ${message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText('Sync');
          }
        }));

    new Setting(containerEl)
      .setName('Restart Server')
      .setDesc('Restart the impulse resolution HTTP server')
      .addButton(button => button
        .setButtonText('Restart')
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Restarting...');

          try {
            if (typeof this.plugin.restartServer === 'function') {
              await this.plugin.restartServer();
              new Notice('Server restarted');
              this.display();
            } else {
              new Notice('Server restart not available');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Restart failed: ${message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText('Restart');
          }
        }));

    new Setting(containerEl)
      .setName('Reset to Defaults')
      .setDesc('Reset all settings to their default values')
      .addButton(button => button
        .setButtonText('Reset')
        .setWarning()
        .onClick(async () => {
          // Preserve vessel ID on reset
          const currentVesselId = this.plugin.settings.vesselId;
          this.plugin.settings = {
            ...DEFAULT_SETTINGS,
            vesselId: currentVesselId || generateVesselId(),
          };
          await this.plugin.saveSettings();
          this.display();
          new Notice('Settings reset to defaults');
        }));
  }
}
