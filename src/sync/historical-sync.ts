/**
 * Historical Sync Service
 *
 * Syncs historical execution traces from the Activity API
 * to Obsidian notes. Handles pagination, idempotency,
 * and content preservation for existing notes.
 */

import { App, TFile, TFolder } from 'obsidian';
import type { SyncStateManager } from './sync-state';
import type { ExecutionTrace } from '../types/execution-trace';
import type { MetabobVesselSettings } from '../settings';

// Re-export for consumers
export type { ExecutionTrace } from '../types/execution-trace';
export type { MetabobVesselSettings } from '../settings';

/**
 * API client interface for execution traces
 */
export interface ActivityAPIClient {
  listExecutionTraces(params: {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    success?: boolean;
  }): Promise<{
    executions: ExecutionTrace[];
    total: number;
    limit: number;
    offset: number;
  }>;

  getExecutionTrace(executionId: string): Promise<ExecutionTrace | null>;
}

/**
 * Formatter interface for converting executions to markdown
 */
export interface ExecutionFormatter {
  formatExecution(execution: ExecutionTrace): string;
  parseUserContent(content: string): string | null;
}

/**
 * Additional sync configuration (extensions to MetabobVesselSettings)
 */
export interface SyncConfig {
  syncBatchSize?: number;
  preserveUserContent?: boolean;
}

/**
 * Service for syncing historical execution traces
 */
export class HistoricalSyncService {
  constructor(
    private app: App,
    private settings: MetabobVesselSettings,
    private apiClient: ActivityAPIClient,
    private stateManager: SyncStateManager,
    private formatter: ExecutionFormatter
  ) {}

  /**
   * Perform historical sync
   * @param onProgress Progress callback (current, total)
   * @returns Number of notes synced
   */
  async sync(onProgress?: (current: number, total: number) => void): Promise<number> {
    let synced = 0;
    let offset = 0;
    let total = 0;
    const batchSize = this.settings.syncBatchSize || 50;
    const startDate = this.stateManager.getLastSyncedAt();

    console.log('[HistoricalSync] Starting sync', {
      startDate,
      batchSize,
      folder: this.settings.executionNotesFolder,
    });

    try {
      // Fetch first page to get total count
      const firstPage = await this.apiClient.listExecutionTraces({
        limit: batchSize,
        offset: 0,
        start_date: startDate || undefined,
      });

      total = firstPage.total;
      console.log('[HistoricalSync] Total executions to sync:', total);

      if (total === 0) {
        onProgress?.(0, 0);
        return 0;
      }

      // Process first page
      for (const execution of firstPage.executions) {
        const wasSynced = await this.syncExecution(execution);
        if (wasSynced) {
          synced++;
        }
        onProgress?.(synced, total);
      }

      offset += firstPage.executions.length;

      // Fetch remaining pages
      while (offset < total) {
        const page = await this.apiClient.listExecutionTraces({
          limit: batchSize,
          offset,
          start_date: startDate || undefined,
        });

        if (page.executions.length === 0) {
          break;
        }

        for (const execution of page.executions) {
          const wasSynced = await this.syncExecution(execution);
          if (wasSynced) {
            synced++;
          }
          onProgress?.(synced, total);
        }

        offset += page.executions.length;

        // Update cursor for resumable sync
        this.stateManager.updateCursor(String(offset));
      }

      // Clear cursor on completion
      this.stateManager.clearCursor();
      await this.stateManager.flush();

      console.log('[HistoricalSync] Sync complete', { synced, total });
      return synced;

    } catch (error) {
      console.error('[HistoricalSync] Sync failed:', error);
      throw error;
    }
  }

  /**
   * Sync a single execution trace
   * @returns true if note was created/updated
   */
  private async syncExecution(execution: ExecutionTrace): Promise<boolean> {
    // Skip if already synced (idempotency check)
    if (this.stateManager.isSynced(execution.execution_id)) {
      console.log('[HistoricalSync] Skipping already synced:', execution.execution_id);
      return false;
    }

    const notePath = this.getNotePath(execution);
    const content = this.formatter.formatExecution(execution);
    const contentHash = this.computeHash(content);

    // Ensure parent folders exist
    await this.ensureFolderExists(notePath);

    const existingFile = this.app.vault.getAbstractFileByPath(notePath);

    if (this.isFile(existingFile)) {
      // File exists - check if update is needed
      if (!this.stateManager.hasContentChanged(notePath, contentHash)) {
        // Content unchanged, just mark as synced
        this.stateManager.markSynced(execution.execution_id, notePath, contentHash);
        return false;
      }

      // Update existing note
      await this.updateNote(existingFile, execution);
      this.stateManager.markSynced(execution.execution_id, notePath, contentHash);
      return true;

    } else {
      // Create new note
      await this.createNote(execution, notePath, content);
      this.stateManager.markSynced(execution.execution_id, notePath, contentHash);
      return true;
    }
  }

  /**
   * Check if an abstract file is a TFile
   */
  private isFile(file: any): file is TFile {
    return file instanceof TFile;
  }

  /**
   * Generate note path for an execution
   * Format: Metabob/Executions/YYYY-MM-DD/execution_id.md
   */
  private getNotePath(execution: ExecutionTrace): string {
    const date = new Date(execution.executed_at);
    const dateFolder = date.toISOString().split('T')[0];
    const safeId = execution.execution_id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.settings.executionNotesFolder}/${dateFolder}/${safeId}.md`;
  }

  /**
   * Ensure all parent folders exist for a file path
   */
  private async ensureFolderExists(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename
    const folderPath = parts.join('/');

    if (!folderPath) {
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (this.isFolder(folder)) {
      return; // Folder exists
    }

    // Create folder recursively
    await this.createFolderRecursive(folderPath);
  }

  /**
   * Check if an abstract file is a TFolder
   */
  private isFolder(file: any): file is TFolder {
    return file instanceof TFolder;
  }

  /**
   * Create folder and all parent folders
   */
  private async createFolderRecursive(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);

      if (!folder) {
        try {
          await this.app.vault.createFolder(currentPath);
          console.log('[HistoricalSync] Created folder:', currentPath);
        } catch (error: any) {
          // Ignore "folder already exists" errors (race condition)
          if (!error.message?.includes('already exists')) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Create a new note for an execution
   */
  private async createNote(
    execution: ExecutionTrace,
    notePath: string,
    content: string
  ): Promise<void> {
    try {
      await this.app.vault.create(notePath, content);
      console.log('[HistoricalSync] Created note:', notePath);
    } catch (error: any) {
      // Handle race condition - file was created between check and create
      if (error.message?.includes('already exists')) {
        console.log('[HistoricalSync] Note already exists (race condition):', notePath);
        return;
      }
      throw error;
    }
  }

  /**
   * Update an existing note while preserving user content
   */
  private async updateNote(file: TFile, execution: ExecutionTrace): Promise<void> {
    const existingContent = await this.app.vault.read(file);
    const newContent = this.formatter.formatExecution(execution);

    let finalContent: string;

    if (this.settings.preserveUserContent) {
      // Extract user-added content from existing note
      const userContent = this.formatter.parseUserContent(existingContent);

      if (userContent) {
        // Append user content after the auto-generated content
        finalContent = newContent + '\n\n---\n\n## User Notes\n\n' + userContent;
      } else {
        finalContent = newContent;
      }
    } else {
      finalContent = newContent;
    }

    await this.app.vault.modify(file, finalContent);
    console.log('[HistoricalSync] Updated note:', file.path);
  }

  /**
   * Compute a simple hash for content comparison
   * Uses djb2 algorithm for speed
   */
  private computeHash(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash) + content.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  /**
   * Sync a single execution by ID
   */
  async syncById(executionId: string): Promise<boolean> {
    try {
      const execution = await this.apiClient.getExecutionTrace(executionId);
      if (!execution) {
        console.warn('[HistoricalSync] Execution not found:', executionId);
        return false;
      }
      return await this.syncExecution(execution);
    } catch (error) {
      console.error('[HistoricalSync] Failed to sync execution:', executionId, error);
      throw error;
    }
  }

  /**
   * Force re-sync an execution (ignores idempotency check)
   */
  async forceSyncById(executionId: string): Promise<boolean> {
    // Remove from synced set to force re-sync
    this.stateManager.removeSynced(executionId);
    return await this.syncById(executionId);
  }
}
