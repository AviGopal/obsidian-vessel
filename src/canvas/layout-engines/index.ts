import { ExecutionTrace } from '../../types';

/**
 * Position in 2D space for canvas layout.
 */
export interface Position {
  x: number;
  y: number;
}

/**
 * Dimensions for node sizing.
 */
export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Layout configuration options.
 */
export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalGap?: number;
  verticalGap?: number;
  padding?: number;
  maxNodesPerRow?: number;
}

/**
 * Result of a layout calculation.
 */
export interface LayoutResult {
  positions: Map<string, Position>;
  dimensions: Map<string, Dimensions>;
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
  };
}

/**
 * Interface for layout engines.
 * Layout engines calculate positions for execution trace nodes.
 */
export interface LayoutEngine {
  /**
   * Calculate positions for all executions.
   */
  calculate(executions: ExecutionTrace[], options?: LayoutOptions): Map<string, Position>;

  /**
   * Calculate full layout result with dimensions and bounds.
   */
  calculateFull?(executions: ExecutionTrace[], options?: LayoutOptions): LayoutResult;
}

/**
 * Default layout options.
 */
export const DEFAULT_LAYOUT_OPTIONS: Required<LayoutOptions> = {
  nodeWidth: 400,
  nodeHeight: 200,
  horizontalGap: 100,
  verticalGap: 150,
  padding: 50,
  maxNodesPerRow: 5
};

/**
 * Calculate bounds from a set of positions.
 */
export function calculateBounds(
  positions: Map<string, Position>,
  dimensions: Map<string, Dimensions>
): LayoutResult['bounds'] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [id, pos] of positions) {
    const dim = dimensions.get(id) || { width: 400, height: 200 };
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + dim.width);
    maxY = Math.max(maxY, pos.y + dim.height);
  }

  return {
    minX: minX === Infinity ? 0 : minX,
    minY: minY === Infinity ? 0 : minY,
    maxX: maxX === -Infinity ? 0 : maxX,
    maxY: maxY === -Infinity ? 0 : maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

// Re-export layout engines
export { HierarchicalLayout } from './hierarchical';
export { TimelineLayout } from './timeline';
export { RadialLayout } from './radial';
export { ForceDirectedLayout } from './force-directed';
