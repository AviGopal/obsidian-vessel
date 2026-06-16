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
 * Radial layout engine.
 * Arranges executions in concentric circles around a central point.
 * Activities form rings, executions are distributed around each ring.
 */
export class RadialLayout implements LayoutEngine {
  private nodeWidth: number;
  private nodeHeight: number;
  private ringGap: number;
  private centerX: number;
  private centerY: number;

  constructor(options?: LayoutOptions & { centerX?: number; centerY?: number; ringGap?: number }) {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    this.nodeWidth = opts.nodeWidth;
    this.nodeHeight = opts.nodeHeight;
    this.ringGap = options?.ringGap || 250;
    this.centerX = options?.centerX || 0;
    this.centerY = options?.centerY || 0;
  }

  calculate(executions: ExecutionTrace[], options?: LayoutOptions): Map<string, Position> {
    const positions = new Map<string, Position>();

    if (executions.length === 0) {
      return positions;
    }

    // Group executions by activity
    const byActivity = this.groupByActivity(executions);
    const activityIds = Array.from(byActivity.keys());

    // Calculate ring assignments
    // Each activity gets its own ring, ordered by first execution time
    const activityRings = this.assignRings(byActivity);

    // Position each execution on its activity's ring
    for (const [activityId, activityExecs] of byActivity) {
      const ringIndex = activityRings.get(activityId)!;
      const radius = (ringIndex + 1) * this.ringGap;

      // Distribute executions evenly around the ring
      const angleStep = (2 * Math.PI) / activityExecs.length;

      // Sort by time within activity
      activityExecs.sort((a, b) =>
        new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
      );

      activityExecs.forEach((exec, index) => {
        const angle = index * angleStep - Math.PI / 2; // Start at top
        positions.set(exec.execution_id, {
          x: this.centerX + radius * Math.cos(angle) - this.nodeWidth / 2,
          y: this.centerY + radius * Math.sin(angle) - this.nodeHeight / 2
        });
      });
    }

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
   * Group executions by activity ID.
   */
  private groupByActivity(executions: ExecutionTrace[]): Map<string, ExecutionTrace[]> {
    const byActivity = new Map<string, ExecutionTrace[]>();

    for (const exec of executions) {
      const list = byActivity.get(exec.activity_id) || [];
      list.push(exec);
      byActivity.set(exec.activity_id, list);
    }

    return byActivity;
  }

  /**
   * Assign ring indices to activities based on execution order.
   */
  private assignRings(byActivity: Map<string, ExecutionTrace[]>): Map<string, number> {
    const activityFirstTime = new Map<string, number>();

    for (const [activityId, execs] of byActivity) {
      const firstTime = Math.min(
        ...execs.map(e => new Date(e.executed_at).getTime())
      );
      activityFirstTime.set(activityId, firstTime);
    }

    const sortedActivities = Array.from(byActivity.keys()).sort((a, b) =>
      (activityFirstTime.get(a) || 0) - (activityFirstTime.get(b) || 0)
    );

    const rings = new Map<string, number>();
    sortedActivities.forEach((activityId, index) => {
      rings.set(activityId, index);
    });

    return rings;
  }

  /**
   * Calculate layout with success/failure separation.
   * Successful executions go on outer rings, failed on inner.
   */
  calculateWithStatusSeparation(
    executions: ExecutionTrace[],
    options?: LayoutOptions
  ): Map<string, Position> {
    const positions = new Map<string, Position>();

    if (executions.length === 0) {
      return positions;
    }

    const successful = executions.filter(e => e.success);
    const failed = executions.filter(e => !e.success);

    // Failed executions on inner ring
    if (failed.length > 0) {
      const innerRadius = this.ringGap;
      const angleStep = (2 * Math.PI) / failed.length;

      failed.forEach((exec, index) => {
        const angle = index * angleStep - Math.PI / 2;
        positions.set(exec.execution_id, {
          x: this.centerX + innerRadius * Math.cos(angle) - this.nodeWidth / 2,
          y: this.centerY + innerRadius * Math.sin(angle) - this.nodeHeight / 2
        });
      });
    }

    // Successful executions on outer ring
    if (successful.length > 0) {
      const outerRadius = this.ringGap * 2;
      const angleStep = (2 * Math.PI) / successful.length;

      successful.forEach((exec, index) => {
        const angle = index * angleStep - Math.PI / 2;
        positions.set(exec.execution_id, {
          x: this.centerX + outerRadius * Math.cos(angle) - this.nodeWidth / 2,
          y: this.centerY + outerRadius * Math.sin(angle) - this.nodeHeight / 2
        });
      });
    }

    return positions;
  }
}
