/**
 * Canvas data structures for Obsidian canvas files.
 *
 * These types match the Obsidian canvas JSON format and are used
 * for both reading existing canvases and generating activity-related
 * canvases programmatically.
 */

/**
 * Complete canvas data structure.
 */
export interface CanvasData {
  /** All nodes in the canvas */
  nodes: CanvasNode[];
  /** All edges (connections) between nodes */
  edges: CanvasEdge[];
}

/**
 * Node in a canvas.
 */
export interface CanvasNode {
  /** Unique identifier for the node */
  id: string;
  /** Type of node content */
  type: 'text' | 'file' | 'link' | 'group';
  /** X coordinate (pixels from origin) */
  x: number;
  /** Y coordinate (pixels from origin) */
  y: number;
  /** Node width in pixels */
  width: number;
  /** Node height in pixels */
  height: number;
  /** Text content (for type: 'text') */
  text?: string;
  /** File path (for type: 'file') */
  file?: string;
  /** URL (for type: 'link') */
  url?: string;
  /** Node background color (CSS color or number 1-6) */
  color?: string;
  /** Label for group nodes */
  label?: string;
}

/**
 * Edge connecting two nodes.
 */
export interface CanvasEdge {
  /** Unique identifier for the edge */
  id: string;
  /** ID of the source node */
  fromNode: string;
  /** ID of the target node */
  toNode: string;
  /** Side of source node where edge starts */
  fromSide: 'top' | 'bottom' | 'left' | 'right';
  /** Side of target node where edge ends */
  toSide: 'top' | 'bottom' | 'left' | 'right';
  /** Edge color (CSS color or number 1-6) */
  color?: string;
  /** Optional label on the edge */
  label?: string;
  /** Arrow style at the start */
  fromEnd?: 'none' | 'arrow';
  /** Arrow style at the end */
  toEnd?: 'none' | 'arrow';
}

/**
 * Text node with specific content.
 */
export interface CanvasTextNode extends CanvasNode {
  type: 'text';
  text: string;
}

/**
 * File reference node.
 */
export interface CanvasFileNode extends CanvasNode {
  type: 'file';
  file: string;
  /** Optional subpath (heading or block) */
  subpath?: string;
}

/**
 * External link node.
 */
export interface CanvasLinkNode extends CanvasNode {
  type: 'link';
  url: string;
}

/**
 * Group node containing other nodes.
 */
export interface CanvasGroupNode extends CanvasNode {
  type: 'group';
  label?: string;
  /** Background color for the group */
  background?: string;
  /** Style of the group background */
  backgroundStyle?: 'cover' | 'ratio' | 'repeat';
}

/**
 * Union type of all specific node types.
 */
export type SpecificCanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode;

/**
 * Canvas color palette (Obsidian's default colors).
 */
export const CANVAS_COLORS = {
  red: '1',
  orange: '2',
  yellow: '3',
  green: '4',
  cyan: '5',
  purple: '6',
} as const;

export type CanvasColorName = keyof typeof CANVAS_COLORS;

/**
 * Layout configuration for activity canvases.
 */
export interface CanvasLayoutConfig {
  /** Layout algorithm to use */
  algorithm: 'hierarchical' | 'force-directed' | 'timeline' | 'manual';
  /** Spacing between nodes horizontally */
  nodeSpacingX: number;
  /** Spacing between nodes vertically */
  nodeSpacingY: number;
  /** Default node width */
  defaultNodeWidth: number;
  /** Default node height */
  defaultNodeHeight: number;
  /** Whether to auto-fit canvas to content */
  autoFit: boolean;
}

/**
 * Default layout configuration.
 */
export const DEFAULT_CANVAS_LAYOUT: CanvasLayoutConfig = {
  algorithm: 'hierarchical',
  nodeSpacingX: 300,
  nodeSpacingY: 150,
  defaultNodeWidth: 250,
  defaultNodeHeight: 100,
  autoFit: true,
};

/**
 * Activity-specific canvas node with execution metadata.
 */
export interface ActivityCanvasNode extends CanvasNode {
  /** Custom data for activity tracking */
  data?: {
    executionId?: string;
    activityId?: string;
    success?: boolean;
    duration?: number;
  };
}

/**
 * Builder class for creating canvas data programmatically.
 */
export class CanvasBuilder {
  private nodes: CanvasNode[] = [];
  private edges: CanvasEdge[] = [];
  private nodeCounter = 0;
  private edgeCounter = 0;

  /**
   * Add a text node to the canvas.
   */
  addTextNode(
    text: string,
    x: number,
    y: number,
    options?: Partial<Pick<CanvasNode, 'width' | 'height' | 'color'>>
  ): string {
    const id = `node-${++this.nodeCounter}`;
    this.nodes.push({
      id,
      type: 'text',
      x,
      y,
      width: options?.width ?? 250,
      height: options?.height ?? 100,
      text,
      color: options?.color,
    });
    return id;
  }

  /**
   * Add a file reference node to the canvas.
   */
  addFileNode(
    file: string,
    x: number,
    y: number,
    options?: Partial<Pick<CanvasNode, 'width' | 'height' | 'color'>>
  ): string {
    const id = `node-${++this.nodeCounter}`;
    this.nodes.push({
      id,
      type: 'file',
      x,
      y,
      width: options?.width ?? 250,
      height: options?.height ?? 100,
      file,
      color: options?.color,
    });
    return id;
  }

  /**
   * Add a link node to the canvas.
   */
  addLinkNode(
    url: string,
    x: number,
    y: number,
    options?: Partial<Pick<CanvasNode, 'width' | 'height' | 'color'>>
  ): string {
    const id = `node-${++this.nodeCounter}`;
    this.nodes.push({
      id,
      type: 'link',
      x,
      y,
      width: options?.width ?? 250,
      height: options?.height ?? 100,
      url,
      color: options?.color,
    });
    return id;
  }

  /**
   * Add a group node to the canvas.
   */
  addGroupNode(
    label: string,
    x: number,
    y: number,
    width: number,
    height: number,
    options?: Partial<Pick<CanvasGroupNode, 'color' | 'background' | 'backgroundStyle'>>
  ): string {
    const id = `node-${++this.nodeCounter}`;
    this.nodes.push({
      id,
      type: 'group',
      x,
      y,
      width,
      height,
      label,
      color: options?.color,
    } as CanvasNode);
    return id;
  }

  /**
   * Add an edge between two nodes.
   */
  addEdge(
    fromNode: string,
    toNode: string,
    options?: Partial<Pick<CanvasEdge, 'fromSide' | 'toSide' | 'color' | 'label'>>
  ): string {
    const id = `edge-${++this.edgeCounter}`;
    this.edges.push({
      id,
      fromNode,
      toNode,
      fromSide: options?.fromSide ?? 'right',
      toSide: options?.toSide ?? 'left',
      color: options?.color,
      label: options?.label,
    });
    return id;
  }

  /**
   * Build the final canvas data object.
   */
  build(): CanvasData {
    return {
      nodes: [...this.nodes],
      edges: [...this.edges],
    };
  }

  /**
   * Reset the builder for reuse.
   */
  reset(): void {
    this.nodes = [];
    this.edges = [];
    this.nodeCounter = 0;
    this.edgeCounter = 0;
  }
}

/**
 * Type guard for text nodes.
 */
export function isTextNode(node: CanvasNode): node is CanvasTextNode {
  return node.type === 'text';
}

/**
 * Type guard for file nodes.
 */
export function isFileNode(node: CanvasNode): node is CanvasFileNode {
  return node.type === 'file';
}

/**
 * Type guard for link nodes.
 */
export function isLinkNode(node: CanvasNode): node is CanvasLinkNode {
  return node.type === 'link';
}

/**
 * Type guard for group nodes.
 */
export function isGroupNode(node: CanvasNode): node is CanvasGroupNode {
  return node.type === 'group';
}
