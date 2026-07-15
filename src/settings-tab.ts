/**
 * Settings Tab for Obsidian Vessel Plugin
 *
 * Provides the UI for configuring the plugin in Obsidian's settings.
 * Organized into sections: Connection, Sync, HTTP Server, Note Formatting, and Canvas.
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ObsidianVesselPlugin from './main';
import { DEFAULT_SETTINGS, validateSettings, generateVesselId } from './settings';

/**
 * Settings tab for the Obsidian Vessel plugin
 */
export class ObsidianVesselSettingTab extends PluginSettingTab {
  plugin: ObsidianVesselPlugin;

  constructor(app: App, plugin: ObsidianVesselPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Header
    containerEl.createEl('h1', { text: 'Obsidian Vessel Settings' });

    // Create all sections
    this.createConnectionSection(containerEl);
    this.createSyncSection(containerEl);
    this.createHttpServerSection(containerEl);
    this.createConceptDbSection(containerEl);
    this.createFederationSidecarSection(containerEl);
    this.createStatusSection(containerEl);
    this.createActionsSection(containerEl);
  }

  /**
   * Federation sidecar section — spawns/supervises the libp2p Circuit Relay
   * v2 passthrough (sidecar/federation-sidecar.ts) as a child process so this
   * plugin becomes reachable from a REMOTE substrate hub, not just the local
   * container. See src/sidecar-manager.ts.
   */
  private createFederationSidecarSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Federation Sidecar (Cross-Host)' });
    containerEl.createEl('p', {
      text:
        'Makes this plugin discoverable and resolvable from a remote substrate ' +
        'over a libp2p Circuit Relay v2 overlay. Set the relay multiaddr (the ' +
        'substrate\'s libp2p peer location) — the discovery URL, hub ingress, ' +
        'and vessel identity are derived automatically, and the API key comes ' +
        'from the Connection section. Requires `bun` on PATH. Changes take ' +
        'effect after "Restart Federation Sidecar" below (or an app reload).',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Relay Multiaddr')
      .setDesc('Circuit Relay v2 multiaddr, e.g. /ip4/<hub-ip>/tcp/30333/p2p/<relay-peer-id>')
      .addText(text => text
        .setPlaceholder('/ip4/203.0.113.10/tcp/30333/p2p/12D3Koo...')
        .setValue(this.plugin.settings.federationRelayMultiaddr)
        .onChange(async (value) => {
          this.plugin.settings.federationRelayMultiaddr = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Restart Federation Sidecar')
      .setDesc('Apply changed settings above by restarting the sidecar process')
      .addButton(button => button
        .setButtonText('Restart')
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText('Restarting...');
          try {
            await this.plugin.restartFederationSidecar();
            new Notice('Federation sidecar restarted');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Federation sidecar restart failed: ${message}`);
          } finally {
            button.setDisabled(false);
            button.setButtonText('Restart');
          }
        }));
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

    // Concept-DB endpoint and API key settings removed

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
      text: 'The API key authenticates every substrate call (it also carries your organization). Endpoints are discovered automatically — locally via the substrate defaults, remotely via the federation sidecar.',
      cls: 'setting-item-description',
    });

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
