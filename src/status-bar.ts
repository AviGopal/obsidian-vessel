/**
 * Status Bar Manager
 *
 * Manages the plugin's status bar item in Obsidian's footer.
 * Shows connection status, sync progress, and quick actions.
 */

import type MetabobVesselPlugin from './main';

/**
 * Status indicator icons (using Unicode symbols for compatibility)
 */
const ICONS = {
  connected: '\u25CF', // filled circle
  disconnected: '\u25CB', // empty circle
  syncing: '\u21BB', // clockwise arrow
  error: '\u26A0', // warning sign
  success: '\u2713', // check mark
};

/**
 * StatusBarManager handles the display and updates
 * of the vessel status in Obsidian's status bar.
 */
export class StatusBarManager {
  private plugin: MetabobVesselPlugin;
  private statusBarEl: HTMLElement;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;
  private clickHandler: (() => void) | null = null;

  constructor(plugin: MetabobVesselPlugin, statusBarEl: HTMLElement) {
    this.plugin = plugin;
    this.statusBarEl = statusBarEl;
    this.statusBarEl.addClass('metabob-status-bar');

    // Set up click handler
    this.clickHandler = () => {
      this.plugin.app.commands.executeCommandById('metabob-vessel-status');
    };
    this.statusBarEl.addEventListener('click', this.clickHandler);

    // Add clickable styling
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.style.cursor = 'pointer';
  }

  /**
   * Start updating the status bar
   *
   * @param intervalMs - Update interval in milliseconds (default: 5000)
   */
  start(intervalMs: number = 5000): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Initial update
    this.update();

    // Schedule periodic updates
    this.updateInterval = setInterval(() => {
      this.update();
    }, intervalMs);

    console.log('[StatusBarManager] Started with interval:', intervalMs);
  }

  /**
   * Stop updating the status bar
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.clickHandler) {
      this.statusBarEl.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }

    this.isRunning = false;
    console.log('[StatusBarManager] Stopped');
  }

  /**
   * Update the status bar display
   */
  private update(): void {
    const status = this.plugin.getStatus();

    let icon: string;
    let text: string;
    let tooltip: string;

    if (status.syncing) {
      icon = ICONS.syncing;
      text = 'Syncing...';
      tooltip = 'Metabob: Sync in progress';
    } else if (status.apiConnected) {
      icon = ICONS.connected;
      text = `${status.syncedCount}`;
      tooltip = this.buildTooltip(status);
    } else {
      icon = ICONS.disconnected;
      text = 'Offline';
      tooltip = 'Metabob: Not connected to API\nClick to view status';
    }

    this.statusBarEl.innerHTML = `${icon} Metabob: ${text}`;
    this.statusBarEl.setAttribute('aria-label', tooltip);
    this.statusBarEl.setAttribute('title', tooltip);
  }

  /**
   * Build detailed tooltip text
   */
  private buildTooltip(status: ReturnType<typeof this.plugin.getStatus>): string {
    const lines = [
      'Metabob Vessel',
      '---',
      `API: ${status.apiConnected ? 'Connected' : 'Disconnected'}`,
      `Server: ${status.serverRunning ? 'Running' : 'Stopped'}`,
      `Synced: ${status.syncedCount}`,
      `Resolutions: ${status.resolutionCount}`,
    ];

    if (status.lastSyncedAt) {
      const lastSync = new Date(status.lastSyncedAt);
      lines.push(`Last sync: ${lastSync.toLocaleTimeString()}`);
    }

    lines.push('---');
    lines.push('Click to view details');

    return lines.join('\n');
  }

  /**
   * Force an immediate update
   */
  forceUpdate(): void {
    this.update();
  }

  /**
   * Show a temporary message
   *
   * @param message - Message to display
   * @param durationMs - Duration to show message (default: 3000)
   */
  showMessage(message: string, durationMs: number = 3000): void {
    const originalContent = this.statusBarEl.innerHTML;

    this.statusBarEl.innerHTML = message;

    setTimeout(() => {
      // Only restore if we haven't started a sync or something
      if (!this.plugin.getStatus().syncing) {
        this.statusBarEl.innerHTML = originalContent;
      }
    }, durationMs);
  }

  /**
   * Show a progress message in the status bar
   */
  showProgress(message: string): void {
    this.statusBarEl.innerHTML = `${ICONS.syncing} MB: ${message}`;
    this.statusBarEl.addClass('syncing');
  }

  /**
   * Show an error state in the status bar
   */
  showError(message: string): void {
    this.statusBarEl.innerHTML = `${ICONS.error} MB: ${message}`;
    this.statusBarEl.addClass('error');

    // Reset to normal after 5 seconds
    setTimeout(() => {
      this.statusBarEl.removeClass('error');
      this.update();
    }, 5000);
  }

  /**
   * Show a success notification briefly
   */
  showSuccess(message: string): void {
    this.statusBarEl.innerHTML = `${ICONS.success} MB: ${message}`;
    this.statusBarEl.addClass('success');

    // Reset to normal after 3 seconds
    setTimeout(() => {
      this.statusBarEl.removeClass('success');
      this.update();
    }, 3000);
  }
}
