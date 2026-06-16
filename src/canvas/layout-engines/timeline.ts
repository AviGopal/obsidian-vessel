import {
  LayoutEngine,
  Position,
  LayoutOptions,
  LayoutResult,
  DEFAULT_LAYOUT_OPTIONS,
  calculateBounds,
  Dimensions
} from './index';
import { ExecutionTrace } from '../../types';

/**
 * Timeline layout engine.
 * Arranges executions chronologically from left to right.
 * Wraps to new rows after maxNodesPerRow items.
 */
export class TimelineLayout implements LayoutEngine {
  private nodeWidth: number;
  private nodeHeight: number;
  private horizontalGap: number;
  private verticalGap: number;
  private maxNodesPerRow: number;

  constructor(options?: LayoutOptions) {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    this.nodeWidth = opts.nodeWidth;
    this.nodeHeight = opts.nodeHeight;
    this.horizontalGap = opts.horizontalGap;
    this.verticalGap = opts.verticalGap;
    this.maxNodesPerRow = opts.maxNodesPerRow;
  }

  calculate(executions: ExecutionTrace[], options?: LayoutOptions): Map<string, Position> {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const nodeWidth = opts.nodeWidth;
    const nodeHeight = opts.nodeHeight;
    const horizontalGap = opts.horizontalGap;
    const verticalGap = opts.verticalGap;
    const maxNodesPerRow = opts.maxNodesPerRow;

    const positions = new Map<string, Position>();

    if (executions.length === 0) {
      return positions;
    }

    // Sort by execution time
    const sorted = [...executions].sort((a, b) =>
      new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );

    // Layout left to right, wrapping after maxNodesPerRow items
    sorted.forEach((exec, index) => {
      const row = Math.floor(index / maxNodesPerRow);
      const col = index % maxNodesPerRow;

      positions.set(exec.execution_id, {
        x: col * (nodeWidth + horizontalGap),
        y: row * (nodeHeight + verticalGap)
      });
    });

    return positions;
  }

  calculateFull(executions: ExecutionTrace[], options?: LayoutOptions): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const positions = this.calculate(executions, opts);

    const dimensions = new Map<string, Dimensions>();
    for (const exec of executions) {
      dimensions.set(exec.execution_id, {
        width: opts.nodeWidth,
        height: opts.nodeHeight
      });
    }

    return {
      positions,
      dimensions,
      bounds: calculateBounds(positions, dimensions)
    };
  }

  /**
   * Calculate layout with time-based spacing.
   * Nodes are spaced proportionally to their time difference.
   */
  calculateProportional(
    executions: ExecutionTrace[],
    options?: LayoutOptions & { timeScale?: number }
  ): Map<string, Position> {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const nodeHeight = opts.nodeHeight;
    const verticalGap = opts.verticalGap;
    const timeScale = options?.timeScale || 0.001; // ms to pixels

    const positions = new Map<string, Position>();

    if (executions.length === 0) {
      return positions;
    }

    // Sort by execution time
    const sorted = [...executions].sort((a, b) =>
      new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );

    const startTime = new Date(sorted[0].executed_at).getTime();

    // Group overlapping executions into lanes
    const lanes: ExecutionTrace[][] = [];

    for (const exec of sorted) {
      const execStart = new Date(exec.executed_at).getTime();
      const execEnd = execStart + (exec.duration_ms || 1000);

      // Find a lane that doesn't overlap
      let foundLane = false;
      for (let i = 0; i < lanes.length; i++) {
        const lastInLane = lanes[i][lanes[i].length - 1];
        const lastEnd = new Date(lastInLane.executed_at).getTime() + (lastInLane.duration_ms || 1000);

        if (execStart >= lastEnd) {
          lanes[i].push(exec);
          foundLane = true;
          break;
        }
      }

      if (!foundLane) {
        lanes.push([exec]);
      }
    }

    // Position nodes based on time and lane
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      for (const exec of lanes[laneIndex]) {
        const execTime = new Date(exec.executed_at).getTime();
        positions.set(exec.execution_id, {
          x: (execTime - startTime) * timeScale,
          y: laneIndex * (nodeHeight + verticalGap)
        });
      }
    }

    return positions;
  }
}
