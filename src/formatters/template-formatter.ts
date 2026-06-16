/**
 * Template Formatter
 *
 * Converts activity templates to Obsidian-compatible markdown notes.
 */

import type { ActivityTemplate, TaskDefinition } from '../types';
import {
  generateFrontmatter,
  buildTemplateFrontmatter,
  type TemplateFrontmatter,
} from './frontmatter';
import { formatDuration, formatCost, formatPercentage } from './metrics-formatter';

// =============================================================================
// Template Formatter
// =============================================================================

export class TemplateFormatter {
  /**
   * Format an activity template as a complete markdown note
   */
  format(template: ActivityTemplate): string {
    const parts: string[] = [];

    // Frontmatter
    parts.push(this.formatFrontmatter(template));

    // Header
    parts.push(`# ${template.name}`);
    parts.push('');

    // Description
    if (template.description) {
      parts.push(template.description);
      parts.push('');
    }

    // Metadata table
    parts.push(this.formatMetadataTable(template));

    // Performance metrics (if available)
    if (this.hasPerformanceMetrics(template)) {
      parts.push(this.formatPerformanceMetrics(template));
    }

    // Input/Output shapes
    parts.push(this.formatShapes(template));

    // Tasks
    if (template.tasks?.length) {
      parts.push(this.formatTasks(template.tasks));
    }

    // Footer
    parts.push(this.formatFooter(template));

    return parts.filter((p) => p).join('\n');
  }

  // ===========================================================================
  // Section Formatters
  // ===========================================================================

  private formatFrontmatter(template: ActivityTemplate): string {
    const fm: TemplateFrontmatter = buildTemplateFrontmatter({
      activity_id: template.activity_id || template.id,
      name: template.name,
      category: template.category,
      execution_type: template.execution_type,
      input_shapes: template.input_shapes,
      output_shapes: template.output_shapes,
      created_at: template.created_at,
    });

    return generateFrontmatter(fm as unknown as Record<string, unknown>);
  }

  private formatMetadataTable(template: ActivityTemplate): string {
    const lines: string[] = [];

    lines.push('## Metadata');
    lines.push('');
    lines.push('| Property | Value |');
    lines.push('|----------|-------|');
    lines.push(`| ID | \`${template.activity_id}\` |`);

    if (template.category) {
      const categoryEmoji = this.getCategoryEmoji(template.category);
      lines.push(`| Category | ${categoryEmoji} ${this.formatCategory(template.category)} |`);
    }

    lines.push(`| Execution Type | ${this.formatExecutionType(template.execution_type)} |`);

    if (template.version) {
      lines.push(`| Version | ${template.version} |`);
    }

    lines.push(`| Created | ${template.created_at} |`);

    if (template.updated_at) {
      lines.push(`| Updated | ${template.updated_at} |`);
    }

    lines.push('');

    return lines.join('\n');
  }

  private formatPerformanceMetrics(template: ActivityTemplate): string {
    const lines: string[] = [];

    lines.push('## Performance Metrics');
    lines.push('');

    // Success rate indicator
    if (template.success_rate !== undefined) {
      const rate = template.success_rate;
      const indicator = this.getSuccessRateIndicator(rate);
      lines.push(`> [!${indicator.type}] Success Rate: ${formatPercentage(rate)}`);
      lines.push(`> ${indicator.message}`);
      lines.push('');
    }

    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');

    if (template.execution_count !== undefined) {
      lines.push(`| Executions | ${template.execution_count} |`);
    }

    if (template.success_rate !== undefined) {
      lines.push(`| Success Rate | ${formatPercentage(template.success_rate)} |`);
    }

    if (template.avg_duration_ms !== undefined) {
      lines.push(`| Avg Duration | ${formatDuration(template.avg_duration_ms)} |`);
    }

    if (template.avg_cost_usd !== undefined) {
      lines.push(`| Avg Cost | ${formatCost(template.avg_cost_usd)} |`);
    }

    lines.push('');

    return lines.join('\n');
  }

  private formatShapes(template: ActivityTemplate): string {
    const lines: string[] = [];

    const hasInputs = template.input_shapes && template.input_shapes.length > 0;
    const hasOutputs = template.output_shapes && template.output_shapes.length > 0;

    if (!hasInputs && !hasOutputs) {
      return '';
    }

    lines.push('## Shapes');
    lines.push('');

    if (hasInputs) {
      lines.push('### Input Shapes');
      lines.push('');
      lines.push('These impulse shapes are expected as input:');
      lines.push('');
      for (const shape of template.input_shapes!) {
        lines.push(`- \`${shape}\``);
      }
      lines.push('');
    }

    if (hasOutputs) {
      lines.push('### Output Shapes');
      lines.push('');
      lines.push('These impulse shapes may be produced:');
      lines.push('');
      for (const shape of template.output_shapes!) {
        lines.push(`- \`${shape}\``);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatTasks(tasks: TaskDefinition[]): string {
    const lines: string[] = [];

    lines.push('## Tasks');
    lines.push('');
    lines.push(`This activity consists of ${tasks.length} task(s):`);
    lines.push('');

    // Sort tasks by order if available
    const sortedTasks = [...tasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (let i = 0; i < sortedTasks.length; i++) {
      const task = sortedTasks[i]!;

      lines.push(`### ${i + 1}. ${task.id}`);
      lines.push('');
      lines.push(task.description);
      lines.push('');

      // Prompt template
      if (task.prompt) {
        lines.push('**Prompt Template:**');
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>View prompt template</summary>');
        lines.push('');
        lines.push('```');
        lines.push(task.prompt.template);
        lines.push('```');
        lines.push('');

        if (task.prompt.variables && task.prompt.variables.length > 0) {
          lines.push('**Variables:**');
          lines.push('');
          for (const variable of task.prompt.variables) {
            const required = variable.required ? ' (required)' : '';
            const defaultVal = variable.default ? ` = "${variable.default}"` : '';
            lines.push(`- \`${variable.name}\`${required}${defaultVal}`);
            if (variable.description) {
              lines.push(`  - ${variable.description}`);
            }
          }
          lines.push('');
        }

        lines.push('</details>');
        lines.push('');
      }

      // Validation rules
      if (task.validation) {
        lines.push('**Validation:**');
        lines.push('');

        if (task.validation.requiredFiles && task.validation.requiredFiles.length > 0) {
          lines.push('- Required files:');
          for (const file of task.validation.requiredFiles) {
            lines.push(`  - \`${file}\``);
          }
        }

        if (task.validation.requiredPatterns && task.validation.requiredPatterns.length > 0) {
          lines.push('- Required patterns:');
          for (const pattern of task.validation.requiredPatterns) {
            lines.push(`  - \`${pattern}\``);
          }
        }

        if (task.validation.forbiddenPatterns && task.validation.forbiddenPatterns.length > 0) {
          lines.push('- Forbidden patterns:');
          for (const pattern of task.validation.forbiddenPatterns) {
            lines.push(`  - \`${pattern}\``);
          }
        }

        lines.push('');
      }

      // Retry configuration
      if (task.retry) {
        lines.push(
          `**Retry:** Max ${task.retry.maxAttempts} attempts, ${task.retry.strategy} strategy`
        );
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private formatFooter(template: ActivityTemplate): string {
    const lines: string[] = [];

    lines.push('---');
    lines.push('');

    // Dataview query example
    lines.push('## Related Executions');
    lines.push('');
    lines.push('```dataview');
    lines.push('TABLE success, duration_ms as "Duration", cost as "Cost", executed_at as "Date"');
    lines.push(`FROM "Metabob/Executions"`);
    lines.push(`WHERE activity_id = "${template.activity_id}"`);
    lines.push('SORT executed_at DESC');
    lines.push('LIMIT 10');
    lines.push('```');
    lines.push('');

    // Metadata
    lines.push('*Generated by Metabob Vessel Plugin*');
    lines.push('');

    return lines.join('\n');
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private hasPerformanceMetrics(template: ActivityTemplate): boolean {
    return (
      template.execution_count !== undefined ||
      template.success_rate !== undefined ||
      template.avg_duration_ms !== undefined ||
      template.avg_cost_usd !== undefined
    );
  }

  private getCategoryEmoji(
    category: 'feature' | 'bugfix' | 'refactor' | 'tool' | 'infrastructure' | 'documentation' | 'meta'
  ): string {
    switch (category) {
      case 'feature':
        return '(+)';
      case 'bugfix':
        return '(!)';
      case 'refactor':
        return '(~)';
      case 'tool':
        return '(#)';
      case 'infrastructure':
        return '(@)';
      case 'documentation':
        return '(d)';
      case 'meta':
        return '(*)';
      default:
        return '(?)';
    }
  }

  private formatCategory(
    category: 'feature' | 'bugfix' | 'refactor' | 'tool' | 'infrastructure' | 'documentation' | 'meta'
  ): string {
    return category.charAt(0).toUpperCase() + category.slice(1);
  }

  private formatExecutionType(
    type: 'llm' | 'deterministic' | 'hybrid' | 'template' | 'tool' | 'composition' | 'vessel_function'
  ): string {
    switch (type) {
      case 'llm':
        return 'LLM-driven';
      case 'deterministic':
        return 'Deterministic';
      case 'hybrid':
        return 'Hybrid (LLM + Deterministic)';
      case 'template':
        return 'Template';
      case 'tool':
        return 'Tool-based';
      case 'composition':
        return 'Composition';
      case 'vessel_function':
        return 'Vessel Function';
      default:
        return type;
    }
  }

  private getSuccessRateIndicator(rate: number): { type: string; message: string } {
    if (rate >= 0.9) {
      return { type: 'success', message: 'This activity has excellent reliability.' };
    }
    if (rate >= 0.7) {
      return { type: 'info', message: 'This activity has good reliability.' };
    }
    if (rate >= 0.5) {
      return { type: 'warning', message: 'This activity may need optimization.' };
    }
    return { type: 'danger', message: 'This activity has low reliability and needs attention.' };
  }
}

// =============================================================================
// Standalone Formatting Functions
// =============================================================================

/**
 * Format template as a minimal one-line summary
 */
export function formatTemplateOneLiner(template: ActivityTemplate): string {
  const category = template.category ? `[${template.category}]` : '';
  const rate = template.success_rate !== undefined ? formatPercentage(template.success_rate) : 'N/A';
  return `${category} ${template.name} | ${template.execution_type} | ${rate} success rate`;
}

/**
 * Format template for Dataview table row
 */
export function formatTemplateForDataview(template: ActivityTemplate): Record<string, unknown> {
  return {
    file: `[[${template.activity_id}]]`,
    name: template.name,
    category: template.category ?? 'unknown',
    execution_type: template.execution_type,
    success_rate:
      template.success_rate !== undefined ? formatPercentage(template.success_rate) : 'N/A',
    executions: template.execution_count ?? 0,
  };
}

/**
 * Format a simple template card for embedding
 */
export function formatTemplateCard(template: ActivityTemplate): string {
  const lines: string[] = [];

  lines.push(`**[[${template.activity_id}|${template.name}]]**`);

  if (template.description) {
    const shortDesc =
      template.description.length > 100
        ? template.description.substring(0, 100) + '...'
        : template.description;
    lines.push(shortDesc);
  }

  const meta: string[] = [];
  if (template.category) {
    meta.push(`Category: ${template.category}`);
  }
  if (template.success_rate !== undefined) {
    meta.push(`Success: ${formatPercentage(template.success_rate)}`);
  }
  if (template.execution_count !== undefined) {
    meta.push(`Runs: ${template.execution_count}`);
  }

  if (meta.length > 0) {
    lines.push(`*${meta.join(' | ')}*`);
  }

  return lines.join('\n');
}
