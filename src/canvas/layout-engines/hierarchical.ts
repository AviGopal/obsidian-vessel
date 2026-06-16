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
 * Hierarchical layout engine.
 * Groups executions by activity and arranges them in columns.
 * Activities are columns, executions within an activity are rows.
 */
export class HierarchicalLayout implements LayoutEngine {
  private nodeWidth: number;
  private nodeHeight: number;
  private horizontalGap: number;
  private verticalGap: number;

  constructor(options?: LayoutOptions) {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    this.nodeWidth = opts.nodeWidth;
    this.nodeHeight = opts.nodeHeight;
    this.horizontalGap = opts.horizontalGap;
    this.verticalGap = opts.verticalGap;
  }

  calculate(executions: ExecutionTrace[], options?: LayoutOptions): Map<string, Position> {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const nodeWidth = opts.nodeWidth;
    const nodeHeight = opts.nodeHeight;
    const horizontalGap = opts.horizontalGap;
    const verticalGap = opts.verticalGap;

    const positions = new Map<string, Position>();

    if (executions.length === 0) {
      return positions;
    }

    // Group executions by activity_id
    const byActivity = this.groupByActivity(executions);

    // Sort activities by first execution time
    const sortedActivities = this.sortActivities(byActivity);

    // Layout in columns by activity, rows by execution time
    let colIndex = 0;
    for (const activityId of sortedActivities) {
      const activityExecs = byActivity.get(activityId)!;

      // Sort executions within activity by time
      activityExecs.sort((a, b) =>
        new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
      );

      let rowIndex = 0;
      for (const exec of activityExecs) {
        positions.set(exec.execution_id, {
          x: colIndex * (nodeWidth + horizontalGap),
          y: rowIndex * (nodeHeight + verticalGap)
        });
        rowIndex++;
      }
      colIndex++;
    }

    return positions;
  }

  calculateFull(executions: ExecutionTrace[], options?: LayoutOptions): LayoutResult {
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
    const positions = this.calculate(executions, opts);

    // All nodes have same dimensions in hierarchical layout
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
   * Group executions by their activity ID.
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
   * Sort activities by their first execution time.
   */
  private sortActivities(byActivity: Map<string, ExecutionTrace[]>): string[] {
    const activityFirstTime = new Map<string, number>();

    for (const [activityId, execs] of byActivity) {
      const firstTime = Math.min(
        ...execs.map(e => new Date(e.executed_at).getTime())
      );
      activityFirstTime.set(activityId, firstTime);
    }

    return Array.from(byActivity.keys()).sort((a, b) =>
      (activityFirstTime.get(a) || 0) - (activityFirstTime.get(b) || 0)
    );
  }
}
