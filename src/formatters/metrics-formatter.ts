/**
 * Metrics Formatter
 *
 * Utility functions for formatting various metrics in human-readable form.
 */

// =============================================================================
// Duration Formatting
// =============================================================================

/**
 * Format milliseconds as human-readable duration
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "45.2s", "1m 23s", "2h 15m")
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    return '0ms';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (minutes < 60) {
    if (remainingSeconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours < 24) {
    if (remainingMinutes === 0) {
      return `${hours}h`;
    }
    return `${hours}h ${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (remainingHours === 0) {
    return `${days}d`;
  }
  return `${days}d ${remainingHours}h`;
}

// =============================================================================
// Cost Formatting
// =============================================================================

/**
 * Format USD cost value
 *
 * @param usd - Cost in USD
 * @returns Formatted currency string (e.g., "$0.0234", "$1.50")
 */
export function formatCost(usd: number): string {
  if (usd < 0) {
    return '$0.00';
  }

  if (usd === 0) {
    return '$0.00';
  }

  // For very small values, show more decimal places
  if (usd < 0.0001) {
    return `$${usd.toFixed(6)}`;
  }

  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }

  if (usd < 1) {
    return `$${usd.toFixed(3)}`;
  }

  if (usd < 100) {
    return `$${usd.toFixed(2)}`;
  }

  // For larger values, use comma separators
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// =============================================================================
// Token Formatting
// =============================================================================

/**
 * Format token count with K/M suffix for large numbers
 *
 * @param count - Number of tokens
 * @returns Formatted string (e.g., "1,234", "45.2K", "1.5M")
 */
export function formatTokens(count: number): string {
  if (count < 0) {
    return '0';
  }

  if (count < 1000) {
    return count.toString();
  }

  if (count < 10000) {
    return count.toLocaleString('en-US');
  }

  if (count < 1000000) {
    const k = count / 1000;
    if (k >= 100) {
      return `${Math.round(k)}K`;
    }
    return `${k.toFixed(1)}K`;
  }

  const m = count / 1000000;
  if (m >= 100) {
    return `${Math.round(m)}M`;
  }
  return `${m.toFixed(1)}M`;
}

// =============================================================================
// Timestamp Formatting
// =============================================================================

/**
 * Format ISO timestamp as locale string
 *
 * @param iso - ISO 8601 timestamp string
 * @param options - Intl.DateTimeFormat options
 * @returns Formatted date/time string
 */
export function formatTimestamp(
  iso: string,
  options?: Intl.DateTimeFormatOptions
): string {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
      return iso;
    }

    const defaultOptions: Intl.DateTimeFormatOptions = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...options,
    };

    return date.toLocaleString(undefined, defaultOptions);
  } catch {
    return iso;
  }
}

/**
 * Format ISO timestamp as relative time (e.g., "2 hours ago", "yesterday")
 *
 * @param iso - ISO 8601 timestamp string
 * @returns Relative time string
 */
export function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso);
    if (isNaN(date.getTime())) {
      return iso;
    }

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);
    const diffYears = Math.floor(diffDays / 365);

    // Future dates
    if (diffMs < 0) {
      const absDiffSeconds = Math.abs(diffSeconds);
      const absDiffMinutes = Math.abs(diffMinutes);
      const absDiffHours = Math.abs(diffHours);
      const absDiffDays = Math.abs(diffDays);

      if (absDiffSeconds < 60) {
        return 'in a few seconds';
      }
      if (absDiffMinutes < 60) {
        return absDiffMinutes === 1 ? 'in 1 minute' : `in ${absDiffMinutes} minutes`;
      }
      if (absDiffHours < 24) {
        return absDiffHours === 1 ? 'in 1 hour' : `in ${absDiffHours} hours`;
      }
      if (absDiffDays < 7) {
        return absDiffDays === 1 ? 'tomorrow' : `in ${absDiffDays} days`;
      }
      return formatTimestamp(iso, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    // Past dates
    if (diffSeconds < 30) {
      return 'just now';
    }
    if (diffSeconds < 60) {
      return 'less than a minute ago';
    }
    if (diffMinutes === 1) {
      return '1 minute ago';
    }
    if (diffMinutes < 60) {
      return `${diffMinutes} minutes ago`;
    }
    if (diffHours === 1) {
      return '1 hour ago';
    }
    if (diffHours < 24) {
      return `${diffHours} hours ago`;
    }
    if (diffDays === 1) {
      return 'yesterday';
    }
    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    if (diffWeeks === 1) {
      return '1 week ago';
    }
    if (diffWeeks < 4) {
      return `${diffWeeks} weeks ago`;
    }
    if (diffMonths === 1) {
      return '1 month ago';
    }
    if (diffMonths < 12) {
      return `${diffMonths} months ago`;
    }
    if (diffYears === 1) {
      return '1 year ago';
    }
    return `${diffYears} years ago`;
  } catch {
    return iso;
  }
}

// =============================================================================
// Percentage Formatting
// =============================================================================

/**
 * Format a decimal as percentage
 *
 * @param value - Decimal value (0.0 to 1.0)
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted percentage string (e.g., "85.5%")
 */
export function formatPercentage(value: number, decimals: number = 1): string {
  if (value < 0) {
    return '0%';
  }
  if (value > 1) {
    return '100%';
  }
  return `${(value * 100).toFixed(decimals)}%`;
}

// =============================================================================
// Rate Formatting
// =============================================================================

/**
 * Format success rate with optional count context
 *
 * @param successes - Number of successes
 * @param total - Total attempts
 * @returns Formatted rate string (e.g., "85.0% (17/20)")
 */
export function formatSuccessRate(successes: number, total: number): string {
  if (total === 0) {
    return 'N/A (0 executions)';
  }

  const rate = successes / total;
  return `${formatPercentage(rate)} (${successes}/${total})`;
}

// =============================================================================
// Metrics Formatter Class
// =============================================================================

/**
 * Metrics formatter with configurable options
 */
export class MetricsFormatter {
  private useRelativeTime: boolean;
  private locale: string;

  constructor(options?: { useRelativeTime?: boolean; locale?: string }) {
    this.useRelativeTime = options?.useRelativeTime ?? true;
    this.locale = options?.locale ?? 'en-US';
  }

  formatDuration(ms: number): string {
    return formatDuration(ms);
  }

  formatCost(usd: number): string {
    return formatCost(usd);
  }

  formatTokens(count: number): string {
    return formatTokens(count);
  }

  formatTimestamp(iso: string): string {
    if (this.useRelativeTime) {
      return formatRelativeTime(iso);
    }
    return formatTimestamp(iso);
  }

  formatRelativeTime(iso: string): string {
    return formatRelativeTime(iso);
  }

  formatPercentage(value: number, decimals?: number): string {
    return formatPercentage(value, decimals);
  }

  formatSuccessRate(successes: number, total: number): string {
    return formatSuccessRate(successes, total);
  }

  /**
   * Format a summary line for execution
   */
  formatExecutionSummary(execution: {
    success: boolean;
    duration_ms: number;
    cost: number;
    executed_at: string;
  }): string {
    const status = execution.success ? 'Completed' : 'Failed';
    const statusEmoji = execution.success ? '(/)' : '(x)';
    const duration = this.formatDuration(execution.duration_ms);
    const cost = this.formatCost(execution.cost);
    const time = this.formatTimestamp(execution.executed_at);

    return `${statusEmoji} **${status}** | Duration: ${duration} | Cost: ${cost} | ${time}`;
  }
}
