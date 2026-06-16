/**
 * Vessel Status Modal
 *
 * Displays the current connection and sync status of the Metabob vessel.
 */

import { App, Modal } from 'obsidian';
import type MetabobVesselPlugin from '../main';

export class VesselStatusModal extends Modal {
  private plugin: MetabobVesselPlugin;
  private refreshInterval: number | null = null;

  constructor(app: App, plugin: MetabobVesselPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    this.renderContent();

    // Auto-refresh every 5 seconds
    this.refreshInterval = window.setInterval(() => {
      this.renderContent();
    }, 5000);
  }

  private renderContent() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('metabob-status-modal');

    contentEl.createEl('h2', { text: 'Metabob Vessel Status' });

    const status = this.plugin.getStatus();

    // Connection status section
    const connSection = contentEl.createDiv('status-section');
    connSection.createEl('h3', { text: 'Connection' });
    this.createStatusRow(connSection, 'API Connected', status.apiConnected);
    this.createStatusRow(connSection, 'Realtime Connected', status.realtimeConnected);
    this.createStatusRow(connSection, 'HTTP Server', status.serverRunning);

    // Sync status section
    const syncSection = contentEl.createDiv('status-section');
    syncSection.createEl('h3', { text: 'Sync' });
    this.createInfoRow(syncSection, 'Last Synced', this.formatDate(status.lastSyncedAt));
    this.createInfoRow(syncSection, 'Synced Notes', String(status.syncedCount));
    this.createInfoRow(syncSection, 'Resolutions', String(status.resolutionCount));

    if (status.syncing) {
      const syncingIndicator = syncSection.createDiv('syncing-indicator');
      syncingIndicator.createSpan({ cls: 'spinner' });
      syncingIndicator.createSpan({ text: ' Syncing in progress...' });
    }

    // API Configuration section
    const configSection = contentEl.createDiv('status-section');
    configSection.createEl('h3', { text: 'Configuration' });
    this.createInfoRow(configSection, 'API Endpoint', this.plugin.settings.activityApiUrl || 'Not configured');
    this.createInfoRow(configSection, 'API Key', this.plugin.settings.apiKey ? '********' : 'Not set');
    this.createInfoRow(configSection, 'Sync Interval', `${this.plugin.settings.syncInterval} minutes`);

    // Actions section
    const actionsSection = contentEl.createDiv('status-actions');

    const syncBtn = actionsSection.createEl('button', { text: 'Force Sync' });
    syncBtn.addClass('mod-cta');
    syncBtn.onclick = () => {
      this.app.commands.executeCommandById('metabob-force-sync');
      this.close();
    };

    const reconnectBtn = actionsSection.createEl('button', { text: 'Reconnect' });
    reconnectBtn.onclick = async () => {
      reconnectBtn.disabled = true;
      reconnectBtn.textContent = 'Reconnecting...';
      try {
        await this.plugin.reconnect();
        this.renderContent();
      } catch (error) {
        console.error('Reconnection failed:', error);
      }
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = 'Reconnect';
    };

    const settingsBtn = actionsSection.createEl('button', { text: 'Settings' });
    settingsBtn.onclick = () => {
      this.close();
      this.app.commands.executeCommandById('metabob-open-settings');
    };

    // Health details (expandable)
    if (status.apiConnected) {
      const healthSection = contentEl.createDiv('status-section collapsible');
      const healthHeader = healthSection.createEl('h3', { text: 'Health Details' });
      healthHeader.addClass('collapsible-header');
      healthHeader.onclick = () => healthSection.toggleClass('expanded', !healthSection.hasClass('expanded'));

      const healthContent = healthSection.createDiv('collapsible-content');
      this.loadHealthDetails(healthContent);
    }
  }

  private createStatusRow(container: HTMLElement, label: string, connected: boolean) {
    const row = container.createDiv('status-row');
    row.createSpan({ text: label, cls: 'status-label' });
    const indicator = row.createSpan({
      cls: `status-indicator ${connected ? 'connected' : 'disconnected'}`
    });
    indicator.setText(connected ? 'Connected' : 'Disconnected');
  }

  private createInfoRow(container: HTMLElement, label: string, value: string) {
    const row = container.createDiv('status-row');
    row.createSpan({ text: label, cls: 'status-label' });
    row.createSpan({ text: value, cls: 'status-value' });
  }

  private formatDate(dateStr: string | null): string {
    if (!dateStr) return 'Never';
    try {
      const date = new Date(dateStr);
      return date.toLocaleString();
    } catch {
      return dateStr;
    }
  }

  private async loadHealthDetails(container: HTMLElement) {
    if (!this.plugin.apiClient) {
      container.createEl('p', {
        text: 'API client not initialized',
        cls: 'error-text'
      });
      return;
    }

    try {
      const health = await this.plugin.apiClient.getHealth();
      if (health) {
        this.createInfoRow(container, 'Status', health.status || 'unknown');
        if (health.version) {
          this.createInfoRow(container, 'Version', health.version);
        }
        if (health.uptime) {
          this.createInfoRow(container, 'Uptime', this.formatUptime(health.uptime));
        }
      }
    } catch (error) {
      container.createEl('p', {
        text: 'Failed to load health details',
        cls: 'error-text'
      });
    }
  }

  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  onClose() {
    if (this.refreshInterval) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.contentEl.empty();
  }
}
