/**
 * Templates Browser Modal
 *
 * Browse and explore activity templates with their metrics.
 */

import { App, Modal, Setting, Notice, debounce } from 'obsidian';
import type MetabobVesselPlugin from '../main';
import type { ActivityTemplate } from '../types';

export class TemplatesBrowserModal extends Modal {
  private plugin: MetabobVesselPlugin;
  private templates: ActivityTemplate[] = [];
  private templatesEl: HTMLElement | null = null;
  private searchQuery: string = '';
  private categoryFilter: string = 'all';
  private sortBy: 'name' | 'success_rate' | 'executions' | 'recent' = 'name';
  private loading: boolean = false;

  constructor(app: App, plugin: MetabobVesselPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('metabob-templates-modal');

    contentEl.createEl('h2', { text: 'Activity Templates' });

    // Search and filter controls
    const controlsDiv = contentEl.createDiv('templates-controls');

    // Search input
    new Setting(controlsDiv)
      .setName('Search')
      .setDesc('Filter templates by name or description')
      .addText(text => {
        text
          .setPlaceholder('Search templates...')
          .onChange(debounce(async (value) => {
            this.searchQuery = value.trim().toLowerCase();
            this.renderTemplates();
          }, 300, true));
      });

    // Category filter
    new Setting(controlsDiv)
      .setName('Category')
      .addDropdown(dropdown => {
        dropdown
          .addOption('all', 'All Categories')
          .addOption('feature', 'Feature')
          .addOption('bugfix', 'Bugfix')
          .addOption('refactor', 'Refactor')
          .addOption('tool', 'Tool')
          .addOption('infrastructure', 'Infrastructure')
          .addOption('meta', 'Meta')
          .setValue(this.categoryFilter)
          .onChange(async (value) => {
            this.categoryFilter = value;
            this.renderTemplates();
          });
      });

    // Sort by
    new Setting(controlsDiv)
      .setName('Sort by')
      .addDropdown(dropdown => {
        dropdown
          .addOption('name', 'Name')
          .addOption('success_rate', 'Success Rate')
          .addOption('executions', 'Executions')
          .addOption('recent', 'Recently Updated')
          .setValue(this.sortBy)
          .onChange(async (value) => {
            this.sortBy = value as typeof this.sortBy;
            this.renderTemplates();
          });
      });

    // Templates container
    this.templatesEl = contentEl.createDiv('templates-list');

    // Load templates
    this.loadTemplates();
  }

  private async loadTemplates() {
    if (!this.templatesEl) return;
    if (!this.plugin.apiClient) {
      this.templatesEl.empty();
      this.templatesEl.createEl('p', {
        text: 'API client not initialized',
        cls: 'error-text'
      });
      return;
    }

    this.loading = true;
    this.templatesEl.empty();
    this.templatesEl.createDiv('loading-indicator').createSpan({ text: 'Loading templates...' });

    try {
      const response = await this.plugin.apiClient.listActivityTemplates({ limit: 100 });
      this.templates = response.templates || [];
      this.renderTemplates();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to load templates: ${errorMessage}`);
      if (this.templatesEl) {
        this.templatesEl.empty();
        this.templatesEl.createEl('p', {
          text: `Error: ${errorMessage}`,
          cls: 'error-text'
        });
      }
    } finally {
      this.loading = false;
    }
  }

  private getFilteredTemplates(): ActivityTemplate[] {
    let filtered = [...this.templates];

    // Apply search filter
    if (this.searchQuery) {
      filtered = filtered.filter(t =>
        t.name.toLowerCase().includes(this.searchQuery) ||
        (t.description && t.description.toLowerCase().includes(this.searchQuery)) ||
        t.activity_id?.toLowerCase().includes(this.searchQuery)
      );
    }

    // Apply category filter
    if (this.categoryFilter !== 'all') {
      filtered = filtered.filter(t => t.category === this.categoryFilter);
    }

    // Apply sorting
    filtered.sort((a, b) => {
      switch (this.sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'success_rate':
          return (b.success_rate || 0) - (a.success_rate || 0);
        case 'executions':
          return (b.execution_count || 0) - (a.execution_count || 0);
        case 'recent':
          return new Date(b.updated_at || b.created_at).getTime() -
            new Date(a.updated_at || a.created_at).getTime();
        default:
          return 0;
      }
    });

    return filtered;
  }

  private renderTemplates() {
    if (!this.templatesEl) return;
    this.templatesEl.empty();

    const filtered = this.getFilteredTemplates();

    if (filtered.length === 0) {
      const emptyDiv = this.templatesEl.createDiv('empty-results');
      emptyDiv.createEl('p', { text: 'No templates found' });
      if (this.searchQuery || this.categoryFilter !== 'all') {
        emptyDiv.createEl('p', {
          text: 'Try adjusting your filters',
          cls: 'hint-text'
        });
      }
      return;
    }

    // Results count
    this.templatesEl.createEl('p', {
      text: `${filtered.length} template${filtered.length === 1 ? '' : 's'}`,
      cls: 'results-count'
    });

    for (const template of filtered) {
      const item = this.templatesEl.createDiv('template-item');

      // Header row
      const headerRow = item.createDiv('template-header');

      // Name
      headerRow.createEl('strong', {
        text: template.name,
        cls: 'template-name'
      });

      // Category badge
      if (template.category) {
        headerRow.createSpan({
          text: template.category,
          cls: `category-badge category-${template.category}`
        });
      }

      // Execution type badge
      if (template.execution_type) {
        headerRow.createSpan({
          text: template.execution_type,
          cls: `type-badge type-${template.execution_type}`
        });
      }

      // Description
      if (template.description) {
        item.createEl('p', {
          text: this.truncate(template.description, 150),
          cls: 'template-desc'
        });
      }

      // Metrics row
      const metricsRow = item.createDiv('template-metrics');

      // Success rate
      if (template.success_rate !== undefined) {
        const rateClass = template.success_rate >= 0.8 ? 'high' :
          template.success_rate >= 0.5 ? 'medium' : 'low';
        metricsRow.createSpan({
          text: `${(template.success_rate * 100).toFixed(0)}% success`,
          cls: `metric-badge success-rate ${rateClass}`
        });
      }

      // Execution count
      if (template.execution_count !== undefined) {
        metricsRow.createSpan({
          text: `${template.execution_count} executions`,
          cls: 'metric-badge'
        });
      }

      // Average duration
      if (template.avg_duration_ms !== undefined) {
        metricsRow.createSpan({
          text: this.formatDuration(template.avg_duration_ms),
          cls: 'metric-badge'
        });
      }

      // Average cost
      if (template.avg_cost_usd !== undefined && template.avg_cost_usd > 0) {
        metricsRow.createSpan({
          text: `$${template.avg_cost_usd.toFixed(4)}/exec`,
          cls: 'metric-badge'
        });
      }

      // Input/Output shapes
      if (template.input_shapes?.length || template.output_shapes?.length) {
        const shapesRow = item.createDiv('template-shapes');

        if (template.input_shapes?.length) {
          shapesRow.createSpan({
            text: `In: ${template.input_shapes.join(', ')}`,
            cls: 'shapes-text input-shapes'
          });
        }

        if (template.output_shapes?.length) {
          shapesRow.createSpan({
            text: `Out: ${template.output_shapes.join(', ')}`,
            cls: 'shapes-text output-shapes'
          });
        }
      }

      // Tasks count
      if (template.tasks?.length) {
        const tasksText = item.createDiv('template-tasks');
        tasksText.createSpan({
          text: `${template.tasks.length} task${template.tasks.length === 1 ? '' : 's'}`,
          cls: 'tasks-count'
        });
      }

      // Click handler
      item.onclick = async () => {
        try {
          await this.plugin.createNoteFromTemplate(template);
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
