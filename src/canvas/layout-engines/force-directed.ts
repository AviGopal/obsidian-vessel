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
 * Force-directed layout configuration.
 */
interface ForceLayoutOptions extends LayoutOptions {
  iterations?: number;
  repulsionStrength?: number;
  attractionStrength?: number;
  idealDistance?: number;
  damping?: number;
  minMovement?: number;
}

const DEFAULT_FORCE_OPTIONS: Required<ForceLayoutOptions> = {
  ...DEFAULT_LAYOUT_OPTIONS,
  iterations: 100,
  repulsionStrength: 10000,
  attractionStrength: 0.01,
  idealDistance: 300,
  damping: 0.9,
  minMovement: 0.1
};

/**
 * Force-directed layout engine.
 * Uses a physics simulation to position nodes.
 * Connected nodes attract, all nodes repel.
 */
export class ForceDirectedLayout implements LayoutEngine {
  private options: Required<ForceLayoutOptions>;

  constructor(options?: ForceLayoutOptions) {
    this.options = { ...DEFAULT_FORCE_OPTIONS, ...options };
  }

  calculate(executions: ExecutionTrace[], options?: LayoutOptions): Map<string, Position> {
    const opts = { ...this.options, ...options };

    if (executions.length === 0) {
      return new Map();
    }

    // Initialize positions randomly
    const positions = this.initializePositions(executions);
    const velocities = new Map<string, { vx: number; vy: number }>();

    for (const exec of executions) {
      velocities.set(exec.execution_id, { vx: 0, vy: 0 });
    }

    // Build adjacency map for attractions
    const connections = this.buildConnections(executions);

    // Run simulation
    for (let i = 0; i < opts.iterations; i++) {
      const forces = this.calculateForces(executions, positions, connections, opts);
      const totalMovement = this.applyForces(positions, velocities, forces, opts);

      if (totalMovement < opts.minMovement) {
        break;
      }
    }

    // Normalize positions (move to positive quadrant)
    this.normalizePositions(positions, opts.nodeWidth, opts.nodeHeight);

    return positions;
  }

  calculateFull(executions: ExecutionTrace[], options?: LayoutOptions): LayoutResult {
    const opts = { ...this.options, ...options };
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
   * Initialize positions in a circle.
   */
  private initializePositions(executions: ExecutionTrace[]): Map<string, Position> {
    const positions = new Map<string, Position>();
    const n = executions.length;
    const radius = Math.max(300, n * 30);

    executions.forEach((exec, index) => {
      const angle = (2 * Math.PI * index) / n;
      positions.set(exec.execution_id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle)
      });
    });

    return positions;
  }

  /**
   * Build connection map based on execution sequence.
   */
  private buildConnections(executions: ExecutionTrace[]): Map<string, Set<string>> {
    const connections = new Map<string, Set<string>>();

    // Initialize sets
    for (const exec of executions) {
      connections.set(exec.execution_id, new Set());
    }

    // Sort by time
    const sorted = [...executions].sort((a, b) =>
      new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );

    // Connect sequential executions
    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i].execution_id;
      const next = sorted[i + 1].execution_id;

      connections.get(current)?.add(next);
      connections.get(next)?.add(current);
    }

    // Connect executions of the same activity
    const byActivity = new Map<string, ExecutionTrace[]>();
    for (const exec of executions) {
      const list = byActivity.get(exec.activity_id) || [];
      list.push(exec);
      byActivity.set(exec.activity_id, list);
    }

    for (const [, activityExecs] of byActivity) {
      for (let i = 0; i < activityExecs.length; i++) {
        for (let j = i + 1; j < activityExecs.length; j++) {
          const a = activityExecs[i].execution_id;
          const b = activityExecs[j].execution_id;
          connections.get(a)?.add(b);
          connections.get(b)?.add(a);
        }
      }
    }

    return connections;
  }

  /**
   * Calculate forces between all nodes.
   */
  private calculateForces(
    executions: ExecutionTrace[],
    positions: Map<string, Position>,
    connections: Map<string, Set<string>>,
    opts: Required<ForceLayoutOptions>
  ): Map<string, { fx: number; fy: number }> {
    const forces = new Map<string, { fx: number; fy: number }>();

    // Initialize forces
    for (const exec of executions) {
      forces.set(exec.execution_id, { fx: 0, fy: 0 });
    }

    // Repulsion between all pairs
    for (let i = 0; i < executions.length; i++) {
      for (let j = i + 1; j < executions.length; j++) {
        const a = executions[i].execution_id;
        const b = executions[j].execution_id;

        const posA = positions.get(a)!;
        const posB = positions.get(b)!;

        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;

        // Repulsion force (inverse square)
        const repulsion = opts.repulsionStrength / (distance * distance);
        const fx = (dx / distance) * repulsion;
        const fy = (dy / distance) * repulsion;

        const forceA = forces.get(a)!;
        const forceB = forces.get(b)!;

        forceA.fx -= fx;
        forceA.fy -= fy;
        forceB.fx += fx;
        forceB.fy += fy;
      }
    }

    // Attraction for connected nodes
    for (const [nodeId, neighbors] of connections) {
      const posA = positions.get(nodeId)!;
      const forceA = forces.get(nodeId)!;

      for (const neighborId of neighbors) {
        const posB = positions.get(neighborId)!;

        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;

        // Spring force (linear)
        const displacement = distance - opts.idealDistance;
        const attraction = displacement * opts.attractionStrength;
        const fx = (dx / distance) * attraction;
        const fy = (dy / distance) * attraction;

        forceA.fx += fx;
        forceA.fy += fy;
      }
    }

    return forces;
  }

  /**
   * Apply forces to update positions.
   * Returns total movement for convergence check.
   */
  private applyForces(
    positions: Map<string, Position>,
    velocities: Map<string, { vx: number; vy: number }>,
    forces: Map<string, { fx: number; fy: number }>,
    opts: Required<ForceLayoutOptions>
  ): number {
    let totalMovement = 0;

    for (const [nodeId, force] of forces) {
      const vel = velocities.get(nodeId)!;
      const pos = positions.get(nodeId)!;

      // Update velocity with damping
      vel.vx = (vel.vx + force.fx) * opts.damping;
      vel.vy = (vel.vy + force.fy) * opts.damping;

      // Update position
      pos.x += vel.vx;
      pos.y += vel.vy;

      totalMovement += Math.abs(vel.vx) + Math.abs(vel.vy);
    }

    return totalMovement;
  }

  /**
   * Normalize positions to positive quadrant.
   */
  private normalizePositions(
    positions: Map<string, Position>,
    nodeWidth: number,
    nodeHeight: number
  ): void {
    let minX = Infinity;
    let minY = Infinity;

    for (const pos of positions.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
    }

    const padding = 50;

    for (const pos of positions.values()) {
      pos.x = pos.x - minX + padding;
      pos.y = pos.y - minY + padding;
    }
  }
}
