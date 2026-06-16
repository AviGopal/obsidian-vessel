/**
 * Execution Search Modal
 *
 * Search and browse execution traces with filtering options.
 */

import { App, Modal, Setting, Notice, debounce } from 'obsidian';
import type MetabobVesselPlugin from '../main';
import type { ExecutionTrace } from '../types';

export interface ExecutionSearchOptions {
  recent?: boolean;
  filter?: 'all' | 'successful' | 'failed';
  activityId?: string;
}

export class ExecutionSearchModal extends Modal {
  private plugin: MetabobVesselPlugin;
  private options: ExecutionSearchOptions;
  private results: ExecutionTrace[] = [];
  private resultsEl: HTMLElement | null = null;
  private searchQuery: string = '';
  private statusFilter: 'all' | 'successful' | 'failed' = 'all';
  private loading: boolean = false;

  constructor(app: App, plugin: MetabobVesselPlugin, options: ExecutionSearchOptions = {}) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.statusFilter = options.filter || 'all';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('metabob-search-modal');

    const title = this.options.recent
      ? 'Recent Executions'
      : this.options.filter === 'failed'
        ? 'Failed Executions'
        : 'Search Executions';

    contentEl.createEl('h2', { text: title });

    // Search controls
    const controlsDiv = contentEl.createDiv('search-controls');

    // Activity ID filter
    new Setting(controlsDiv)
      .setName('Activity ID')
      .setDesc('Filter by activity template')
      .addText(text => {
        text
          .setPlaceholder('Filter by activity...')
          .setValue(this.options.activityId || '')
          .onChange(debounce(async (value) => {
            this.searchQuery = value.trim();
            await this.search();
          }, 300, true));
      });

    // Status filter (only show if not pre-filtered)
    if (!this.options.filter) {
      new Setting(controlsDiv)
        .setName('Status')
        .setDesc('Filter by execution status')
        .addDropdown(dropdown => {
          dropdown
            .addOption('all', 'All')
            .addOption('successful', 'Successful')
            .addOption('failed', 'Failed')
            .setValue(this.statusFilter)
            .onChange(async (value) => {
              this.statusFilter = value as 'all' | 'successful' | 'failed';
              await this.search();
            });
        });
    }

    // Results container
    this.resultsEl = contentEl.createDiv('search-results');

    // Load initial results
    this.search();
  }

  private async search() {
    if (!this.resultsEl) return;
    if (!this.plugin.apiClient) {
      this.renderError('API client not initialized');
      return;
    }

    this.loading = true;
    this.renderLoading();

    try {
      const params: Record<string, unknown> = {
        limit: 50
      };

      if (this.searchQuery) {
        params.activityId = this.searchQuery;
      }

      if (this.statusFilter !== 'all') {
        params.success = this.statusFilter === 'successful';
      }

      if (this.options.recent) {
        const since = new Date();
        since.setDate(since.getDate() - 1); // Last 24 hours
        params.since = since.toISOString();
      }

      const response = await this.plugin.apiClient.listExecutionTraces(params);
      // Handle both 'executions' and 'traces' property names for compatibility
      this.results = (response as any).executions || (response as any).traces || [];
      this.renderResults();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Search failed: ${errorMessage}`);
      this.renderError(errorMessage);
    } finally {
      this.loading = false;
    }
  }

  private renderLoading() {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    const loadingDiv = this.resultsEl.createDiv('loading-indicator');
    loadingDiv.createSpan({ cls: 'spinner' });
    loadingDiv.createSpan({ text: ' Searching...' });
  }

  private renderError(message: string) {
    if (!this.resultsEl) return;
    this.resultsEl.empty();
    this.resultsEl.createEl('p', {
      text: `Error: ${message}`,
      cls: 'error-text'
    });
  }

  private renderResults() {
    if (!this.resultsEl) return;
    this.resultsEl.empty();

    if (this.results.length === 0) {
      const emptyDiv = this.resultsEl.createDiv('empty-results');
      emptyDiv.createEl('p', { text: 'No executions found' });
      if (this.searchQuery) {
        emptyDiv.createEl('p', {
          text: 'Try a different search term',
          cls: 'hint-text'
        });
      }
      return;
    }

    // Results count
    this.resultsEl.createEl('p', {
      text: `Found ${this.results.length} execution${this.results.length === 1 ? '' : 's'}`,
      cls: 'results-count'
    });

    // Results list
    const listEl = this.resultsEl.createDiv('results-list');

    for (const exec of this.results) {
      const item = listEl.createDiv('search-result-item');
      item.setAttribute('data-execution-id', exec.execution_id);

      // Header row
      const headerRow = item.createDiv('result-header');

      // Status indicator
      const statusIcon = exec.success ? '✓' : '✗';
      const statusCls = exec.success ? 'success' : 'failure';
      headerRow.createSpan({
        text: statusIcon,
        cls: `status-icon ${statusCls}`
      });

      // Activity ID
      headerRow.createEl('strong', {
        text: exec.activity_id || exec.template_id || 'Unknown Activity',
        cls: 'activity-name'
      });

      // Metadata row
      const metaRow = item.createDiv('result-meta');

      // Date
      metaRow.createSpan({
        text: this.formatDate(exec.executed_at),
        cls: 'execution-date'
      });

      // Duration
      if (exec.duration_ms !== undefined) {
        metaRow.createSpan({
          text: ` | ${this.formatDuration(exec.duration_ms)}`,
          cls: 'execution-duration'
        });
      }

      // Cost
      if (exec.cost !== undefined && exec.cost > 0) {
        metaRow.createSpan({
          text: ` | $${exec.cost.toFixed(4)}`,
          cls: 'execution-cost'
        });
      }

      // Error message preview (for failed executions)
      if (!exec.success && exec.error_message) {
        const errorPreview = item.createDiv('error-preview');
        errorPreview.createSpan({
          text: this.truncate(exec.error_message, 100),
          cls: 'error-text'
        });
      }

      // Click handler
      item.onclick = async () => {
        try {
          await this.plugin.createNoteFromExecution(exec.execution_id);
          this.close();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          new Notice(`Failed to create note: ${errorMessage}`);
        }
      };

      // Hover state
      item.onmouseenter = () => item.addClass('hovered');
      item.onmouseleave = () => item.removeClass('hovered');
    }
  }

  private formatDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;

      return date.toLocaleDateString();
    } catch {
      return dateStr;
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  onClose() {
    this.contentEl.empty();
  }
}
