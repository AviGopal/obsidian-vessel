/**
 * Sync Services Index
 *
 * Re-exports all sync-related classes and types for the
 * Obsidian vessel plugin.
 */

// State management
export { SyncStateManager } from './sync-state';
export type { SyncState } from './sync-state';

// Historical sync
export { HistoricalSyncService } from './historical-sync';
export type {
  ExecutionTrace,
  ActivityAPIClient,
  ExecutionFormatter,
  MetabobVesselSettings,
} from './historical-sync';

// Real-time sync
export { RealtimeSyncService } from './realtime-sync';
export type {
  WebSocketMessage,
  ExecutionStartedMessage,
  ExecutionCompletedMessage,
  ConnectionState,
  ExecutionCallback,
  StatusCallback,
} from './realtime-sync';

// Main orchestration
export { SyncService } from './sync-service';
export type {
  SyncStatus,
  SyncProgressCallback,
  StatusChangeCallback,
} from './sync-service';
