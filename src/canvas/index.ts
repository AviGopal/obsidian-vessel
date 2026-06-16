/**
 * Canvas Visualization Module for Metabob Vessel
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
import type { MetabobVesselSettings } from '../settings';

// Core canvas management
export { CanvasManager } from './canvas-manager';

// Canvas builders
export { ExecutionCanvasBuilder } from './execution-canvas';
export { StatusCanvasBuilder, type RecentActivityData } from './status-canvas';

// Layout engines
export {
  // Types
  type Position,
  type Dimensions,
  type LayoutOptions,
  type LayoutResult,
  type LayoutEngine,

  // Constants
  DEFAULT_LAYOUT_OPTIONS,

  // Utilities
  calculateBounds,

  // Implementations
  HierarchicalLayout,
  TimelineLayout,
  RadialLayout,
  ForceDirectedLayout
} from './layout-engines';

/**
 * Create all standard canvases for a new vault setup.
 */
export async function initializeCanvases(
  app: App,
  settings: MetabobVesselSettings
): Promise<void> {
  const { CanvasManager } = await import('./canvas-manager');
  const canvasManager = new CanvasManager(app, settings);

  // Create empty placeholder canvases
  const emptyExecutions: CanvasData = {
    nodes: [{
      id: 'welcome',
      type: 'text',
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      text: `# Welcome to Metabob Vessel

## Getting Started

1. Configure your API key in settings
2. Connect to the activity API
3. Run some activities

## Canvas Views

- **Executions**: View all execution traces
- **Activities**: Grouped by activity type
- **Dashboard**: System status overview

---
*This canvas will auto-update when executions are synced*`,
      color: '5'
    }],
    edges: []
  };

  await canvasManager.createOrUpdateCanvas('executions', emptyExecutions);

  // Create system status placeholder
  const emptyStatus: CanvasData = {
    nodes: [{
      id: 'status-placeholder',
      type: 'text',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      text: `# System Status

## Not Connected

Configure your connection settings to see system status.

1. Open Settings
2. Enter Activity API URL
3. Enter API Key
4. Enable connection`,
      color: '3'
    }],
    edges: []
  };

  await canvasManager.createOrUpdateCanvas('system-status', emptyStatus);
}

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
