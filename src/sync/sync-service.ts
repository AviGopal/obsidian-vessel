/**
 * Sync Service
 *
 * Main orchestration service for syncing execution traces
 * from the Activity API to Obsidian notes. Combines
 * historical sync with real-time WebSocket sync.
 */

import { App, TFile } from 'obsidian';
import type { Plugin } from 'obsidian';
import { SyncStateManager } from './sync-state';
import { HistoricalSyncService, type ActivityAPIClient, type ExecutionFormatter, type ExecutionTrace, type MetabobVesselSettings } from './historical-sync';
import { RealtimeSyncService, type ConnectionState } from './realtime-sync';

/**
 * Sync status for UI display
 */
export interface SyncStatus {
  /** ISO timestamp of last successful sync */
  lastSyncedAt: string | null;
  /** Number of traces synced in current session */
  syncedCount: number;
  /** Whether realtime WebSocket is connected */
  realtimeConnected: boolean;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Whether a sync operation is in progress */
  isSyncing: boolean;
  /** Current sync progress (0-100) */
  syncProgress: number;
  /** Error message if any */
  lastError: string | null;
}

/**
 * Progress callback for sync operations
 */
export type SyncProgressCallback = (current: number, total: number) => void;

/**
 * Status change callback
 */
export type StatusChangeCallback = (status: SyncStatus) => void;

/**
 * Main sync orchestration service
 */
export class SyncService {
  private historicalSync: HistoricalSyncService;
  private realtimeSync: RealtimeSyncService;
  private stateManager: SyncStateManager;
  private formatter: ExecutionFormatter;
  private periodicSyncInterval: ReturnType<typeof setInterval> | null = null;
  private isSyncing: boolean = false;
  private syncProgress: number = 0;
  private lastError: string | null = null;
  private statusListeners: StatusChangeCallback[] = [];

  constructor(
    private app: App,
    private settings: MetabobVesselSettings,
    private apiClient: ActivityAPIClient,
    private plugin: Plugin,
    formatter: ExecutionFormatter
  ) {
    this.formatter = formatter;

    // Initialize state manager
    this.stateManager = new SyncStateManager(plugin);

    // Initialize historical sync
    this.historicalSync = new HistoricalSyncService(
      app,
      settings,
      apiClient,
      this.stateManager,
      formatter
    );

    // Initialize realtime sync
    this.realtimeSync = new RealtimeSyncService(
      app,
      settings,
      this.handleRealtimeExecution.bind(this),
      this.handleConnectionStatusChange.bind(this)
    );
  }

  /**
   * Initialize the sync service
   * Loads state and optionally connects to realtime sync
   */
  async initialize(): Promise<void> {
    console.log('[SyncService] Initializing');

    try {
      // Load persisted state
      await this.stateManager.load();

      // Connect to realtime if enabled (can be a setting)
      if (this.settings.apiKey) {
        await this.realtimeSync.connect();
      }

      this.notifyStatusChange();
      console.log('[SyncService] Initialized successfully');

    } catch (error) {
      console.error('[SyncService] Initialization failed:', error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyStatusChange();
    }
  }

  /**
   * Perform historical sync
   * @param onProgress Optional progress callback
   * @returns Number of notes synced
   */
  async syncHistorical(onProgress?: SyncProgressCallback): Promise<number> {
    if (this.isSyncing) {
      console.warn('[SyncService] Sync already in progress');
      return 0;
    }

    this.isSyncing = true;
    this.syncProgress = 0;
    this.lastError = null;
    this.notifyStatusChange();

    try {
      const count = await this.historicalSync.sync((current, total) => {
        this.syncProgress = total > 0 ? Math.round((current / total) * 100) : 0;
        this.notifyStatusChange();
        onProgress?.(current, total);
      });

      console.log('[SyncService] Historical sync complete:', count);
      return count;

    } catch (error) {
      console.error('[SyncService] Historical sync failed:', error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyStatusChange();
      throw error;

    } finally {
      this.isSyncing = false;
      this.syncProgress = 100;
      this.notifyStatusChange();
    }
  }

  /**
   * Sync a single execution by ID
   */
  async syncSingleExecution(executionId: string): Promise<void> {
    console.log('[SyncService] Syncing single execution:', executionId);

    try {
      await this.historicalSync.syncById(executionId);
      this.notifyStatusChange();
    } catch (error) {
      console.error('[SyncService] Failed to sync execution:', executionId, error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * Force re-sync an execution
   */
  async forceResyncExecution(executionId: string): Promise<void> {
    console.log('[SyncService] Force re-syncing execution:', executionId);

    try {
      await this.historicalSync.forceSyncById(executionId);
      this.notifyStatusChange();
    } catch (error) {
      console.error('[SyncService] Failed to re-sync execution:', executionId, error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyStatusChange();
      throw error;
    }
  }

  /**
   * Start periodic sync at specified interval
   */
  startPeriodicSync(intervalMinutes: number): void {
    this.stopPeriodicSync();

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log('[SyncService] Starting periodic sync', { intervalMinutes, intervalMs });

    this.periodicSyncInterval = setInterval(async () => {
      console.log('[SyncService] Running periodic sync');
      try {
        await this.syncHistorical();
      } catch (error) {
        console.error('[SyncService] Periodic sync failed:', error);
      }
    }, intervalMs);
  }

  /**
   * Stop periodic sync
   */
  stopPeriodicSync(): void {
    if (this.periodicSyncInterval) {
      clearInterval(this.periodicSyncInterval);
      this.periodicSyncInterval = null;
      console.log('[SyncService] Stopped periodic sync');
    }
  }

  /**
   * Connect to realtime sync
   */
  async connectRealtime(): Promise<void> {
    await this.realtimeSync.connect();
  }

  /**
   * Disconnect from realtime sync
   */
  disconnectRealtime(): void {
    this.realtimeSync.disconnect();
  }

  /**
   * Reconnect realtime sync
   */
  async reconnectRealtime(): Promise<void> {
    await this.realtimeSync.reconnect();
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    console.log('[SyncService] Cleaning up');

    // Stop periodic sync
    this.stopPeriodicSync();

    // Disconnect realtime
    this.realtimeSync.disconnect();

    // Flush state
    await this.stateManager.flush();

    // Clear listeners
    this.statusListeners = [];

    console.log('[SyncService] Cleanup complete');
  }

  /**
   * Reset all sync state
   */
  async reset(): Promise<void> {
    console.log('[SyncService] Resetting sync state');
    await this.stateManager.reset();
    this.lastError = null;
    this.syncProgress = 0;
    this.notifyStatusChange();
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    const stateStatus = this.stateManager.getStatus();
    return {
      lastSyncedAt: stateStatus.lastSyncedAt,
      syncedCount: stateStatus.syncedCount,
      realtimeConnected: this.realtimeSync.isConnected(),
      connectionState: this.realtimeSync.getConnectionState(),
      isSyncing: this.isSyncing,
      syncProgress: this.syncProgress,
      lastError: this.lastError,
    };
  }

  /**
   * Add status change listener
   */
  onStatusChange(callback: StatusChangeCallback): () => void {
    this.statusListeners.push(callback);
    return () => {
      const index = this.statusListeners.indexOf(callback);
      if (index >= 0) {
        this.statusListeners.splice(index, 1);
      }
    };
  }

  /**
   * Handle execution from realtime sync
   */
  private async handleRealtimeExecution(execution: ExecutionTrace): Promise<void> {
    console.log('[SyncService] Processing realtime execution:', execution.execution_id);

    try {
      // Use historical sync to create/update note
      // This ensures consistent handling and state management
      const notePath = this.getNotePath(execution);
      const content = this.formatter.formatExecution(execution);
      const contentHash = this.computeHash(content);

      // Ensure folder exists
      await this.ensureFolderExists(notePath);

      // Create or update note
      const existingFile = this.app.vault.getAbstractFileByPath(notePath);

      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, content);
        console.log('[SyncService] Updated note from realtime:', notePath);
      } else {
        await this.app.vault.create(notePath, content);
        console.log('[SyncService] Created note from realtime:', notePath);
      }

      // Mark as synced
      this.stateManager.markSynced(execution.execution_id, notePath, contentHash);
      this.notifyStatusChange();

    } catch (error) {
      console.error('[SyncService] Failed to process realtime execution:', error);
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyStatusChange();
    }
  }

  /**
   * Handle connection status changes from realtime sync
   */
  private handleConnectionStatusChange(connected: boolean, state: ConnectionState): void {
    console.log('[SyncService] Connection status changed:', { connected, state });
    this.notifyStatusChange();
  }

  /**
   * Notify all status listeners
   */
  private notifyStatusChange(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        console.error('[SyncService] Status listener error:', error);
      }
    }
  }

  /**
   * Generate note path for an execution
   */
  private getNotePath(execution: ExecutionTrace): string {
    const date = new Date(execution.executed_at);
    const dateFolder = date.toISOString().split('T')[0];
    const safeId = execution.execution_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.settings.executionNotesFolder}/${dateFolder}/${safeId}.md`;
  }

  /**
   * Ensure folder exists
   */
  private async ensureFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop();
    const folderPath = parts.join('/');

    if (!folderPath) return;

    let currentPath = '';
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);

      if (!folder) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (error: any) {
          if (!error.message?.includes('already exists')) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Compute content hash
   */
  private computeHash(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * Get the state manager (for advanced operations)
   */
  getStateManager(): SyncStateManager {
    return this.stateManager;
  }

  /**
   * Get the historical sync service (for advanced operations)
   */
  getHistoricalSync(): HistoricalSyncService {
    return this.historicalSync;
  }

  /**
   * Get the realtime sync service (for advanced operations)
   */
  getRealtimeSync(): RealtimeSyncService {
    return this.realtimeSync;
  }
}
