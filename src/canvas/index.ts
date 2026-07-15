/**
 * Canvas Visualization Module for Obsidian Vessel
 *
 * Provides canvas generation and management for visualizing:
 * - Execution traces
 * - Activity metrics
 * - System status
 * - Learning progress
 *
 * @example
 * ```typescript
 * import { CanvasManager, ExecutionCanvasBuilder, StatusCanvasBuilder } from './canvas';
 *
 * // Create canvas manager
 * const canvasManager = new CanvasManager(app, settings);
 *
 * // Build execution canvas
 * const execBuilder = new ExecutionCanvasBuilder(app, settings);
 * await execBuilder.buildExecutionCanvas(executions, 'my-executions');
 *
 * // Build status canvas
 * const statusBuilder = new StatusCanvasBuilder(app, settings);
 * await statusBuilder.buildStatusCanvas(systemStatus);
 * ```
 */

import type { App } from 'obsidian';
import type { CanvasData } from '../types/canvas';
import type { ObsidianVesselSettings } from '../settings';

// Core canvas management
export { CanvasManager } from './canvas-manager';

/**
 * Canvas color presets for consistent theming.
 */
export const CANVAS_COLORS = {
  success: '4',       // Green
  error: '1',         // Red
  warning: '3',       // Yellow
  info: '5',          // Cyan
  pending: '2',       // Orange
  neutral: '6'        // Purple
} as const;

/**
 * Standard node dimensions.
 */
export const NODE_DIMENSIONS = {
  small: { width: 200, height: 100 },
  medium: { width: 400, height: 200 },
  large: { width: 600, height: 300 },
  execution: { width: 400, height: 200 },
  summary: { width: 400, height: 250 },
  status: { width: 250, height: 150 }
} as const;

/**
 * Standard spacing values.
 */
export const SPACING = {
  horizontalGap: 100,
  verticalGap: 150,
  groupPadding: 40,
  canvasPadding: 50
} as const;
