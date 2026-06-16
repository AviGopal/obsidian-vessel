/**
 * Execution Trace Formatter
 *
 * Converts execution traces to Obsidian-compatible markdown notes.
 */

import type { ExecutionTrace, TaskExecution, ToolCall, StateSnapshot, ComponentChange } from '../types';
import type { MetabobVesselSettings } from '../settings';
import {
  generateFrontmatter,
  buildExecutionFrontmatter,
  type ExecutionFrontmatter,
} from './frontmatter';
import {
  formatDuration,
  formatCost,
  formatTokens,
  formatRelativeTime,
  formatTimestamp,
} from './metrics-formatter';

// =============================================================================
// Field Normalization Helpers
// =============================================================================

/**
 * Get cost from execution trace, handling both cost and cost_usd field names
 */
function getCost(execution: ExecutionTrace): number {
  return execution.cost ?? execution.cost_usd ?? 0;
}

/**
 * Get token usage from execution trace, normalizing various field name formats
 */
function getTokenUsage(execution: ExecutionTrace): { input_tokens: number; output_tokens: number } | null {
  // Check for structured token_usage object first
  if (execution.token_usage) {
    return execution.token_usage;
  }

  // Check for flat fields (tokens_input/tokens_output from backend)
  const inputTokens = execution.tokens_input ?? execution.tokens_in ?? 0;
  const outputTokens = execution.tokens_output ?? execution.tokens_out ?? 0;

  // Only return if we have some token data
  if (inputTokens > 0 || outputTokens > 0) {
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  }

  return null;
}

// =============================================================================
// Execution Formatter
// =============================================================================

export class ExecutionFormatter {
  constructor(private settings: MetabobVesselSettings) {}

  /**
   * Format an execution trace as a complete markdown note.
   * Implements ExecutionFormatter interface from historical-sync.
   */
  formatExecution(execution: ExecutionTrace): string {
    return this.format(execution);
  }

  /**
   * Parse user-added content from an existing note.
   * Looks for content after a "## User Notes" section.
   * Implements ExecutionFormatter interface from historical-sync.
   */
  parseUserContent(content: string): string | null {
    // Look for user notes section
    const userNotesMatch = content.match(/## User Notes\s*\n([\s\S]*?)(?=\n##|$)/);
    if (userNotesMatch && userNotesMatch[1]) {
      const userContent = userNotesMatch[1].trim();
      return userContent.length > 0 ? userContent : null;
    }
    return null;
  }

  /**
   * Format an execution trace as a complete markdown note
   */
  format(execution: ExecutionTrace): string {
    const parts: string[] = [];

    // Frontmatter
    parts.push(this.formatFrontmatter(execution));

    // Header with activity name
    parts.push(`# ${execution.activity_id}`);
    parts.push('');

    // Summary section
    parts.push(this.formatSummary(execution));

    // Tasks section (if present)
    if (execution.tasks?.length) {
      parts.push(this.formatTasks(execution.tasks));
    }

    // Tool calls section (if enabled and present)
    if (this.settings.showToolCalls) {
      const toolCalls = this.extractToolCalls(execution);
      if (toolCalls.length > 0) {
        parts.push(this.formatToolCalls(toolCalls));
      }
    }

    // State changes section (if enabled and present)
    if (this.settings.showCostEstimates && execution.state_snapshot) {
      parts.push(this.formatStateChanges(execution.state_snapshot));
    }

    // Token usage section (if enabled)
    if (this.settings.showTokenUsage && getTokenUsage(execution)) {
      parts.push(this.formatTokenUsage(execution));
    }

    // Error section (if failed)
    if (!execution.success && execution.error_message) {
      parts.push(this.formatError(execution));
    }

    // Component changes section (if present)
    if (execution.component_changes && execution.component_changes.length > 0) {
      parts.push(this.formatComponentChanges(execution.component_changes));
    }

    // Footer with links
    parts.push(this.formatFooter(execution));

    return parts.filter((p) => p).join('\n');
  }

  // ===========================================================================
  // Section Formatters
  // ===========================================================================

  private formatFrontmatter(execution: ExecutionTrace): string {
    const fm: ExecutionFrontmatter = buildExecutionFrontmatter({
      execution_id: execution.execution_id,
      activity_id: execution.activity_id,
      variant_id: execution.variant_id,
      success: execution.success,
      duration_ms: execution.duration_ms,
      cost: getCost(execution),
      executed_at: execution.executed_at,
      vessel_id: execution.vessel_id,
      extraTags: this.getExtraTags(execution),
    });

    return generateFrontmatter(fm as unknown as Record<string, unknown>);
  }

  private formatSummary(execution: ExecutionTrace): string {
    const lines: string[] = [];

    // Status banner
    const statusEmoji = execution.success ? '(/)' : '(x)';
    const statusText = execution.success ? 'Completed Successfully' : 'Failed';
    lines.push(`> [!${execution.success ? 'success' : 'failure'}] ${statusEmoji} ${statusText}`);
    lines.push('');

    // Metrics table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Status | ${statusEmoji} ${execution.success ? 'Success' : 'Failed'} |`);
    lines.push(`| Duration | ${formatDuration(execution.duration_ms)} |`);
    lines.push(`| Cost | ${formatCost(getCost(execution))} |`);
    lines.push(`| Executed | ${formatRelativeTime(execution.executed_at)} |`);

    if (execution.vessel_id) {
      lines.push(`| Vessel | \`${execution.vessel_id}\` |`);
    }

    if (execution.variant_id) {
      lines.push(`| Variant | \`${execution.variant_id}\` |`);
    }

    if (execution.model) {
      lines.push(`| Model | ${execution.model} |`);
    }

    lines.push('');

    // Goal context (if present)
    if (execution.goal_context) {
      lines.push('### Goal Context');
      lines.push('');
      lines.push(execution.goal_context);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatTasks(tasks: TaskExecution[]): string {
    const lines: string[] = [];

    lines.push('## Tasks');
    lines.push('');

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i]!;
      const checkbox = task.success ? '[x]' : '[ ]';
      const statusEmoji = task.success ? '(/)' : '(x)';

      lines.push(`### ${i + 1}. ${task.description}`);
      lines.push('');
      lines.push(`- ${checkbox} ${statusEmoji} **Status**: ${task.success ? 'Completed' : 'Failed'}`);
      lines.push(`- **Duration**: ${formatDuration(task.duration_ms ?? 0)}`);

      if (task.retry_count && task.retry_count > 0) {
        lines.push(`- **Retries**: ${task.retry_count}`);
      }

      if (task.completed_at) {
        lines.push(`- **Completed**: ${formatTimestamp(task.completed_at)}`);
      }

      // Task error (if failed)
      if (!task.success && task.error_message) {
        lines.push('');
        lines.push('> [!warning] Task Error');
        lines.push(`> ${task.error_message}`);
      }

      // Task tool calls (inline, if present and few)
      if (task.tool_calls && task.tool_calls.length > 0 && task.tool_calls.length <= 3) {
        lines.push('');
        lines.push('**Tools used:**');
        for (const call of task.tool_calls) {
          const callStatus = call.success ? '(/)' : '(x)';
          lines.push(`- ${callStatus} \`${call.tool_name}\``);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  private formatToolCalls(toolCalls: ToolCall[]): string {
    const lines: string[] = [];

    const maxCalls = this.settings.maxNodesPerCanvas ?? 50;
    const displayCalls = toolCalls.slice(0, maxCalls);
    const truncated = toolCalls.length > maxCalls;

    lines.push('## Tool Calls');
    lines.push('');

    // Summary stats
    const successCount = toolCalls.filter((c) => c.success).length;
    const failureCount = toolCalls.length - successCount;
    lines.push(`Total: ${toolCalls.length} | Success: ${successCount} | Failed: ${failureCount}`);
    lines.push('');

    for (let i = 0; i < displayCalls.length; i++) {
      const call = displayCalls[i]!;
      const statusEmoji = call.success ? '(/)' : '(x)';

      lines.push(`### ${i + 1}. ${call.tool_name} ${statusEmoji}`);
      lines.push('');

      // Arguments in collapsible section
      if (call.arguments && Object.keys(call.arguments).length > 0) {
        lines.push('<details>');
        lines.push('<summary>Arguments</summary>');
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(call.arguments, null, 2));
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }

      // Result (truncated if long)
      if (call.result) {
        const maxResultLength = 500;
        const resultTruncated = call.result.length > maxResultLength;
        const displayResult = resultTruncated
          ? call.result.substring(0, maxResultLength) + '...'
          : call.result;

        lines.push('<details>');
        lines.push(`<summary>Result${resultTruncated ? ' (truncated)' : ''}</summary>`);
        lines.push('');
        lines.push('```');
        lines.push(displayResult);
        lines.push('```');
        lines.push('</details>');
        lines.push('');
      }

      // Error (if failed)
      if (!call.success && call.error) {
        lines.push('> [!error] Error');
        lines.push(`> ${call.error}`);
        lines.push('');
      }

      // Duration
      if (call.duration_ms !== undefined) {
        lines.push(`*Duration: ${formatDuration(call.duration_ms)}*`);
        lines.push('');
      }
    }

    if (truncated) {
      lines.push(`*... and ${toolCalls.length - maxCalls} more tool calls*`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatStateChanges(snapshot: StateSnapshot): string {
    const lines: string[] = [];

    // Extract file changes from both nested and flat formats
    const filesCreated = snapshot.output_state?.filesCreated ?? snapshot.filesCreated ?? snapshot.files_created ?? [];
    const filesModified = snapshot.output_state?.filesModified ?? snapshot.filesModified ?? snapshot.files_modified ?? [];
    const filesDeleted = snapshot.output_state?.filesDeleted ?? snapshot.filesDeleted ?? snapshot.files_deleted ?? [];
    const workingDir = snapshot.stateTransition?.workingDirectory ?? snapshot.workingDirectory;
    const exitCode = snapshot.output_state?.exitCode;

    const hasChanges =
      filesModified.length > 0 ||
      filesCreated.length > 0 ||
      filesDeleted.length > 0 ||
      exitCode !== undefined;

    if (!hasChanges) {
      return '';
    }

    lines.push('## State Changes');
    lines.push('');

    // Summary stats
    const totalChanges = filesCreated.length + filesModified.length + filesDeleted.length;
    if (totalChanges > 0) {
      lines.push(`**Total Files Changed:** ${totalChanges}`);
      lines.push('');
    }

    if (filesCreated.length > 0) {
      lines.push('### Files Created');
      lines.push('');
      for (const file of filesCreated) {
        lines.push(`- ✚ \`${file}\``);
      }
      lines.push('');
    }

    if (filesModified.length > 0) {
      lines.push('### Files Modified');
      lines.push('');
      for (const file of filesModified) {
        lines.push(`- ✎ \`${file}\``);
      }
      lines.push('');
    }

    if (filesDeleted.length > 0) {
      lines.push('### Files Deleted');
      lines.push('');
      for (const file of filesDeleted) {
        lines.push(`- ✖ \`${file}\``);
      }
      lines.push('');
    }

    // Working directory and exit code
    if (workingDir || exitCode !== undefined) {
      lines.push('### Execution Context');
      lines.push('');
      if (workingDir) {
        lines.push(`- **Working Directory:** \`${workingDir}\``);
      }
      if (exitCode !== undefined) {
        const exitIcon = exitCode === 0 ? '✓' : '✗';
        lines.push(`- **Exit Code:** ${exitIcon} \`${exitCode}\``);
      }
      lines.push('');
    }

    // Input state summary (if available)
    if (snapshot.input_state) {
      const inputFiles = snapshot.input_state.filesAvailable ?? [];
      const inputImpulses = snapshot.input_state.impulses ?? [];
      if (inputFiles.length > 0 || inputImpulses.length > 0) {
        lines.push('<details>');
        lines.push('<summary>Input State</summary>');
        lines.push('');
        if (inputFiles.length > 0) {
          lines.push(`- **Files Available:** ${inputFiles.length}`);
        }
        if (inputImpulses.length > 0) {
          lines.push(`- **Impulses:** ${inputImpulses.length}`);
        }
        lines.push('</details>');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private formatComponentChanges(changes: ComponentChange[]): string {
    const lines: string[] = [];

    lines.push('## Component Changes');
    lines.push('');

    // Group by change type
    const added = changes.filter(c => c.change_type === 'added');
    const modified = changes.filter(c => c.change_type === 'modified');
    const deleted = changes.filter(c => c.change_type === 'deleted');

    lines.push(`**Total:** ${changes.length} components (✚${added.length} ✎${modified.length} ✖${deleted.length})`);
    lines.push('');

    lines.push('| Component | Type | Change | File |');
    lines.push('|-----------|------|--------|------|');

    for (const change of changes) {
      const changeIcon = change.change_type === 'added' ? '✚' :
                         change.change_type === 'modified' ? '✎' : '✖';
      const fileName = change.file_path.split('/').pop() ?? change.file_path;
      lines.push(`| \`${change.component_name}\` | ${change.component_type} | ${changeIcon} ${change.change_type} | \`${fileName}\` |`);
    }

    lines.push('');

    // Show reasons if any
    const withReasons = changes.filter(c => c.reason);
    if (withReasons.length > 0) {
      lines.push('<details>');
      lines.push('<summary>Change Reasons</summary>');
      lines.push('');
      for (const change of withReasons) {
        lines.push(`- **${change.component_name}**: ${change.reason}`);
      }
      lines.push('</details>');
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatTokenUsage(execution: ExecutionTrace): string {
    const tokenUsage = getTokenUsage(execution);
    if (!tokenUsage) {
      return '';
    }

    const lines: string[] = [];

    lines.push('## Token Usage');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    lines.push(`| Input | ${formatTokens(tokenUsage.input_tokens)} |`);
    lines.push(`| Output | ${formatTokens(tokenUsage.output_tokens)} |`);
    lines.push(
      `| Total | ${formatTokens(tokenUsage.input_tokens + tokenUsage.output_tokens)} |`
    );
    lines.push('');

    return lines.join('\n');
  }

  private formatError(execution: ExecutionTrace): string {
    const lines: string[] = [];
    const errorMessage = execution.error_message ?? 'Unknown error';

    lines.push('## Error');
    lines.push('');

    // Error type badge (if available)
    const errorType = execution.error_type ?? 'unknown';
    const errorTypeEmoji = this.getErrorTypeEmoji(errorType);
    lines.push(`> [!error] ${errorTypeEmoji} ${this.formatErrorType(errorType)}`);
    lines.push('>');

    // Handle multi-line error messages
    const errorLines = errorMessage.split('\n');
    for (const line of errorLines) {
      lines.push(`> ${line}`);
    }

    lines.push('');

    // Error metadata table
    lines.push('| Property | Value |');
    lines.push('|----------|-------|');
    lines.push(`| Type | \`${errorType}\` |`);
    if (execution.failed_task_id) {
      lines.push(`| Failed Task | \`${execution.failed_task_id}\` |`);
    }
    // Exit code from output_state
    const exitCode = execution.state_snapshot?.output_state?.exitCode;
    if (exitCode !== undefined && exitCode !== 0) {
      lines.push(`| Exit Code | \`${exitCode}\` |`);
    }
    lines.push('');

    // Stderr (if available)
    const stderr = execution.state_snapshot?.output_state?.stderr;
    if (stderr && stderr.length > 0) {
      lines.push('<details>');
      lines.push('<summary>Standard Error Output</summary>');
      lines.push('');
      lines.push('```');
      lines.push(stderr.length > 1000 ? stderr.substring(0, 1000) + '...' : stderr);
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    // Add code block for technical details
    if (errorMessage.length > 100) {
      lines.push('<details>');
      lines.push('<summary>Full Error Details</summary>');
      lines.push('');
      lines.push('```');
      lines.push(errorMessage);
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    return lines.join('\n');
  }

  private getErrorTypeEmoji(errorType: string): string {
    const emojiMap: Record<string, string> = {
      'tool_error': '(🔧)',
      'validation_error': '(❌)',
      'timeout': '(⏱️)',
      'llm_error': '(🤖)',
      'permission_error': '(🔒)',
      'network_error': '(🌐)',
      'resource_error': '(📦)',
      'unknown': '(❓)',
    };
    return emojiMap[errorType] ?? '(❓)';
  }

  private formatErrorType(errorType: string): string {
    // Convert snake_case to Title Case
    return errorType
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private formatFooter(execution: ExecutionTrace): string {
    const lines: string[] = [];

    lines.push('---');
    lines.push('');

    // Links
    const links: string[] = [];
    links.push(`[[${execution.activity_id}|Activity Template]]`);

    // Input impulses (check both field names: input_impulses and impulses_used)
    const inputImpulses = execution.input_impulses ?? execution.impulses_used ?? [];
    if (inputImpulses.length > 0) {
      lines.push('### Input Impulses');
      lines.push('');
      for (const impulse of inputImpulses) {
        lines.push(`- \`${impulse}\``);
      }
      lines.push('');
    }

    // Input impulse shapes (from edge learning)
    if (execution.input_impulse_shapes && execution.input_impulse_shapes.length > 0) {
      lines.push('### Input Shapes');
      lines.push('');
      for (const shape of execution.input_impulse_shapes) {
        lines.push(`- \`${shape}\``);
      }
      lines.push('');
    }

    // Output impulses
    if (execution.output_impulses && execution.output_impulses.length > 0) {
      lines.push('### Output Impulses');
      lines.push('');
      for (const impulse of execution.output_impulses) {
        lines.push(`- \`${impulse}\``);
      }
      lines.push('');
    }

    // Output impulse shapes (from edge learning)
    if (execution.output_impulse_shapes && execution.output_impulse_shapes.length > 0) {
      lines.push('### Output Shapes');
      lines.push('');
      for (const shape of execution.output_impulse_shapes) {
        lines.push(`- \`${shape}\``);
      }
      lines.push('');
    }

    // Provenance info (if available)
    if (execution.improvisation) {
      lines.push('> [!info] Improvisation');
      lines.push('> This execution was improvised (no matching activity template).');
      lines.push('');
    }

    // Metadata
    lines.push('*Generated by Metabob Vessel Plugin*');
    lines.push('');

    return lines.join('\n');
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private extractToolCalls(execution: ExecutionTrace): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    if (execution.tasks) {
      for (const task of execution.tasks) {
        if (task.tool_calls) {
          toolCalls.push(...task.tool_calls);
        }
      }
    }

    return toolCalls;
  }

  private getExtraTags(execution: ExecutionTrace): string[] {
    const tags: string[] = [];

    // Add category-based tags if we can infer them
    if (execution.activity_id.includes('bugfix')) {
      tags.push('bugfix');
    } else if (execution.activity_id.includes('feature')) {
      tags.push('feature');
    } else if (execution.activity_id.includes('refactor')) {
      tags.push('refactor');
    }

    // Add vessel tag
    if (execution.vessel_id) {
      tags.push(`vessel/${execution.vessel_id}`);
    }

    return tags;
  }
}

// =============================================================================
// Standalone Formatting Functions
// =============================================================================

/**
 * Format execution as a minimal one-line summary
 */
export function formatExecutionOneLiner(execution: ExecutionTrace): string {
  const status = execution.success ? '(/)' : '(x)';
  return `${status} ${execution.activity_id} | ${formatDuration(execution.duration_ms)} | ${formatCost(getCost(execution))} | ${formatRelativeTime(execution.executed_at)}`;
}

/**
 * Format execution for Dataview table row
 */
export function formatExecutionForDataview(execution: ExecutionTrace): Record<string, unknown> {
  return {
    file: `[[${execution.execution_id}]]`,
    activity: execution.activity_id,
    success: execution.success,
    duration: formatDuration(execution.duration_ms),
    cost: formatCost(getCost(execution)),
    date: execution.executed_at,
  };
}
