/**
 * Sync State Management
 *
 * Manages persistent sync state for the Obsidian vessel plugin.
 * Tracks which execution traces have been synced and maintains
 * pagination cursors for incremental syncs.
 */

import type { Plugin } from 'obsidian';

/**
 * Sync state persisted across sessions
 */
export interface SyncState {
  /** ISO timestamp of last successful sync */
  lastSyncedAt: string | null;
  /** Cursor for paginated API requests */
  cursor: string | null;
  /** Set of execution trace IDs that have been synced */
  syncedTraceIds: Set<string>;
  /** Map of note path to content hash for idempotency */
  contentHashes: Map<string, string>;
}

/**
 * Serializable version of SyncState for persistence
 */
interface SerializedSyncState {
  lastSyncedAt: string | null;
  cursor: string | null;
  syncedTraceIds: string[];
  contentHashes: Record<string, string>;
}

/**
 * Manages sync state persistence and operations
 */
export class SyncStateManager {
  private state: SyncState;
  private plugin: Plugin;
  private stateKey = 'metabob-sync-state';
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDebounceMs = 1000;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.state = {
      lastSyncedAt: null,
      cursor: null,
      syncedTraceIds: new Set(),
      contentHashes: new Map(),
    };
  }

  /**
   * Load sync state from plugin data storage
   */
  async load(): Promise<void> {
    try {
      const data = await this.plugin.loadData();
      if (data && data[this.stateKey]) {
        const serialized = data[this.stateKey] as SerializedSyncState;
        this.state = {
          lastSyncedAt: serialized.lastSyncedAt,
          cursor: serialized.cursor,
          syncedTraceIds: new Set(serialized.syncedTraceIds || []),
          contentHashes: new Map(Object.entries(serialized.contentHashes || {})),
        };
        console.log('[SyncState] Loaded state:', {
          lastSyncedAt: this.state.lastSyncedAt,
          syncedCount: this.state.syncedTraceIds.size,
          hashCount: this.state.contentHashes.size,
        });
      }
    } catch (error) {
      console.error('[SyncState] Failed to load state:', error);
      // Keep default empty state on error
    }
  }

  /**
   * Save sync state to plugin data storage
   */
  async save(): Promise<void> {
    try {
      const serialized: SerializedSyncState = {
        lastSyncedAt: this.state.lastSyncedAt,
        cursor: this.state.cursor,
        syncedTraceIds: Array.from(this.state.syncedTraceIds),
        contentHashes: Object.fromEntries(this.state.contentHashes),
      };

      const data = (await this.plugin.loadData()) || {};
      data[this.stateKey] = serialized;
      await this.plugin.saveData(data);

      console.log('[SyncState] Saved state:', {
        lastSyncedAt: this.state.lastSyncedAt,
        syncedCount: this.state.syncedTraceIds.size,
      });
    } catch (error) {
      console.error('[SyncState] Failed to save state:', error);
      throw error;
    }
  }

  /**
   * Debounced save - coalesces rapid updates
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.save().catch(console.error);
      this.saveDebounceTimer = null;
    }, this.saveDebounceMs);
  }

  /**
   * Mark an execution trace as synced
   */
  markSynced(traceId: string, notePath: string, contentHash: string): void {
    this.state.syncedTraceIds.add(traceId);
    this.state.contentHashes.set(notePath, contentHash);
    this.state.lastSyncedAt = new Date().toISOString();
    this.scheduleSave();
  }

  /**
   * Check if a trace has already been synced
   */
  isSynced(traceId: string): boolean {
    return this.state.syncedTraceIds.has(traceId);
  }

  /**
   * Check if note content has changed
   * Returns true if the note needs to be updated
   */
  hasContentChanged(notePath: string, newHash: string): boolean {
    const existingHash = this.state.contentHashes.get(notePath);
    return existingHash !== newHash;
  }

  /**
   * Get the stored content hash for a note path
   */
  getContentHash(notePath: string): string | undefined {
    return this.state.contentHashes.get(notePath);
  }

  /**
   * Update pagination cursor
   */
  updateCursor(cursor: string): void {
    this.state.cursor = cursor;
    this.scheduleSave();
  }

  /**
   * Get current cursor
   */
  getCursor(): string | null {
    return this.state.cursor;
  }

  /**
   * Clear cursor (start fresh pagination)
   */
  clearCursor(): void {
    this.state.cursor = null;
    this.scheduleSave();
  }

  /**
   * Get timestamp of last sync
   */
  getLastSyncedAt(): string | null {
    return this.state.lastSyncedAt;
  }

  /**
   * Get count of synced traces
   */
  getSyncedCount(): number {
    return this.state.syncedTraceIds.size;
  }

  /**
   * Remove a trace from synced set (for re-sync)
   */
  removeSynced(traceId: string): void {
    this.state.syncedTraceIds.delete(traceId);
    this.scheduleSave();
  }

  /**
   * Remove content hash for a path (for re-sync)
   */
  removeContentHash(notePath: string): void {
    this.state.contentHashes.delete(notePath);
    this.scheduleSave();
  }

  /**
   * Clear all sync state (full reset)
   */
  async reset(): Promise<void> {
    this.state = {
      lastSyncedAt: null,
      cursor: null,
      syncedTraceIds: new Set(),
      contentHashes: new Map(),
    };
    await this.save();
    console.log('[SyncState] State reset');
  }

  /**
   * Get state summary for status display
   */
  getStatus(): {
    lastSyncedAt: string | null;
    syncedCount: number;
    hasMorePages: boolean;
  } {
    return {
      lastSyncedAt: this.state.lastSyncedAt,
      syncedCount: this.state.syncedTraceIds.size,
      hasMorePages: this.state.cursor !== null,
    };
  }

  /**
   * Flush any pending saves immediately
   */
  async flush(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
      await this.save();
    }
  }
}
