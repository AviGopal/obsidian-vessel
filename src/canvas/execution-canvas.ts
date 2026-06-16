import { App } from 'obsidian';
import {
  CanvasData,
  CanvasNode,
  CanvasEdge,
  CanvasFileNode,
  CanvasTextNode,
  CanvasGroupNode
} from '../types/canvas';
import { ExecutionTrace } from '../types';
import { MetabobVesselSettings } from '../settings';
import type { CompositionGraph, CompositionNode, CompositionEdge } from '../api-client';

/**
 * Get cost from execution trace, handling both cost and cost_usd field names
 */
function getCost(execution: ExecutionTrace): number {
  return execution.cost ?? execution.cost_usd ?? 0;
}

type CanvasColor = '1' | '2' | '3' | '4' | '5' | '6' | string;
import { CanvasManager } from './canvas-manager';
import {
  HierarchicalLayout,
  TimelineLayout,
  RadialLayout,
  ForceDirectedLayout,
  LayoutEngine,
  Position
} from './layout-engines';

/**
 * Color mapping for execution status.
 * Obsidian canvas colors: 1=red, 2=orange, 3=yellow, 4=green, 5=cyan, 6=purple
 */
const STATUS_COLORS = {
  success: '4' as CanvasColor,      // Green
  failed: '1' as CanvasColor,       // Red
  partial: '3' as CanvasColor,      // Yellow
  inProgress: '5' as CanvasColor,   // Cyan
  pending: '2' as CanvasColor       // Orange
};

/**
 * Color mapping for activity categories.
 */
const CATEGORY_COLORS: Record<string, CanvasColor> = {
  feature: '4',        // Green
  bugfix: '1',         // Red
  refactor: '6',       // Purple
  tool: '5',           // Cyan
  infrastructure: '2'  // Orange
};

/**
 * Color mapping for error types.
 * Used to visually distinguish different failure modes.
 */
const ERROR_TYPE_COLORS: Record<string, CanvasColor> = {
  'tool_error': '1',         // Red - tool failures
  'validation_error': '2',   // Orange - validation issues
  'timeout': '3',            // Yellow - timeouts
  'llm_error': '6',          // Purple - LLM issues
  'permission_error': '1',   // Red - permission denied
  'network_error': '5',      // Cyan - connectivity
  'resource_error': '2',     // Orange - resource issues
  'unknown': '1'             // Red - unknown errors
};

/**
 * Builds execution visualization canvases.
 * Displays execution traces as connected nodes in Obsidian canvas.
 */
export class ExecutionCanvasBuilder {
  private canvasManager: CanvasManager;

  constructor(
    private app: App,
    private settings: MetabobVesselSettings
  ) {
    this.canvasManager = new CanvasManager(app, settings);
  }

  /**
   * Build a canvas showing execution traces.
   */
  async buildExecutionCanvas(
    executions: ExecutionTrace[],
    name: string = 'executions'
  ): Promise<void> {
    if (executions.length === 0) {
      // Create empty canvas with placeholder
      const emptyCanvas: CanvasData = {
        nodes: [{
          id: 'empty-placeholder',
          type: 'text',
          x: 0,
          y: 0,
          width: 400,
          height: 100,
          text: '# No Executions\n\nNo execution traces to display. Run some activities to see them here.',
          color: '3'
        }],
        edges: []
      };
      await this.canvasManager.createOrUpdateCanvas(name, emptyCanvas);
      return;
    }

    const layout = this.getLayoutEngine();
    const positions = layout.calculate(executions);

    const nodes = this.createExecutionNodes(executions, positions);
    const edges = this.createSequentialEdges(executions);

    await this.canvasManager.createOrUpdateCanvas(name, { nodes, edges });
  }

  /**
   * Build a canvas grouped by activity.
   * Each activity is a group containing its executions.
   */
  async buildGroupedCanvas(
    executions: ExecutionTrace[],
    name: string = 'grouped-executions'
  ): Promise<void> {
    if (executions.length === 0) {
      await this.buildExecutionCanvas(executions, name);
      return;
    }

    const byActivity = this.groupByActivity(executions);
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    // Layout configuration
    const nodeWidth = 380;
    const nodeHeight = 180;
    const groupPadding = 40;
    const horizontalGap = 100;
    const verticalGap = 80;

    let currentX = 0;

    for (const [activityId, activityExecs] of byActivity) {
      // Sort executions by time
      activityExecs.sort((a, b) =>
        new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
      );

      // Calculate group dimensions
      const groupWidth = nodeWidth + groupPadding * 2;
      const groupHeight = activityExecs.length * (nodeHeight + verticalGap) - verticalGap + groupPadding * 2;

      // Create group node
      const templateName = activityExecs[0]?.template_name || activityId;
      const successRate = activityExecs.filter(e => e.success).length / activityExecs.length;

      nodes.push({
        id: `group-${activityId}`,
        type: 'group',
        x: currentX,
        y: 0,
        width: groupWidth,
        height: groupHeight,
        label: `${templateName} (${Math.round(successRate * 100)}% success)`,
        color: this.getSuccessRateColor(successRate)
      } as CanvasGroupNode);

      // Add execution nodes within group
      activityExecs.forEach((exec, index) => {
        const nodeX = currentX + groupPadding;
        const nodeY = groupPadding + index * (nodeHeight + verticalGap);

        nodes.push(this.createFileNode(exec, { x: nodeX, y: nodeY }, nodeWidth, nodeHeight));

        // Create edges between sequential executions within activity
        if (index > 0) {
          edges.push({
            id: `edge-${activityExecs[index - 1].execution_id}-${exec.execution_id}`,
            fromNode: activityExecs[index - 1].execution_id,
            toNode: exec.execution_id,
            fromSide: 'bottom',
            toSide: 'top',
            toEnd: 'arrow'
          });
        }
      });

      currentX += groupWidth + horizontalGap;
    }

    await this.canvasManager.createOrUpdateCanvas(name, { nodes, edges });
  }

  /**
   * Build a canvas with activity summary nodes.
   * Shows aggregated metrics per activity.
   */
  async buildSummaryCanvas(
    executions: ExecutionTrace[],
    name: string = 'activity-summary'
  ): Promise<void> {
    if (executions.length === 0) {
      await this.buildExecutionCanvas(executions, name);
      return;
    }

    const byActivity = this.groupByActivity(executions);
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    const nodeWidth = 400;
    const nodeHeight = 250;
    const gap = 100;
    const itemsPerRow = 3;

    let index = 0;
    for (const [activityId, activityExecs] of byActivity) {
      const row = Math.floor(index / itemsPerRow);
      const col = index % itemsPerRow;

      const summary = this.calculateActivitySummary(activityExecs);

      nodes.push({
        id: `summary-${activityId}`,
        type: 'text',
        x: col * (nodeWidth + gap),
        y: row * (nodeHeight + gap),
        width: nodeWidth,
        height: nodeHeight,
        text: this.formatActivitySummary(summary),
        color: this.getSuccessRateColor(summary.successRate)
      } as CanvasTextNode);

      index++;
    }

    await this.canvasManager.createOrUpdateCanvas(name, { nodes, edges });
  }

  /**
   * Update an existing canvas with new executions.
   */
  async updateCanvas(
    name: string,
    newExecutions: ExecutionTrace[]
  ): Promise<void> {
    const existing = await this.canvasManager.readCanvas(name);

    if (!existing) {
      await this.buildExecutionCanvas(newExecutions, name);
      return;
    }

    const layout = this.getLayoutEngine();

    // Get existing node IDs
    const existingIds = new Set(existing.nodes.map(n => n.id));

    // Filter to only new executions
    const actuallyNew = newExecutions.filter(e => !existingIds.has(e.execution_id));

    if (actuallyNew.length === 0) {
      return;
    }

    // Calculate positions for all executions (including existing)
    const allExecutions = [
      ...this.extractExecutionsFromNodes(existing.nodes),
      ...actuallyNew
    ];

    const positions = layout.calculate(allExecutions);

    // Create nodes only for new executions
    const newNodes = this.createExecutionNodes(actuallyNew, positions);

    // Create edges connecting new executions
    const newEdges = this.createSequentialEdges(allExecutions).filter(
      edge => !existing.edges.some(e => e.id === edge.id)
    );

    await this.canvasManager.mergeCanvas(name, {
      nodes: newNodes,
      edges: newEdges
    });
  }

  /**
   * Open the canvas in Obsidian.
   */
  async openCanvas(name: string): Promise<void> {
    await this.canvasManager.openCanvas(name);
  }

  /**
   * Get the configured layout engine.
   */
  private getLayoutEngine(): LayoutEngine {
    switch (this.settings.canvasLayout) {
      case 'timeline':
        return new TimelineLayout();
      case 'radial':
        return new RadialLayout();
      case 'force-directed':
        return new ForceDirectedLayout();
      case 'hierarchical':
      default:
        return new HierarchicalLayout();
    }
  }

  /**
   * Create canvas nodes for executions.
   * Includes file nodes for execution notes and label nodes for activity names.
   */
  private createExecutionNodes(
    executions: ExecutionTrace[],
    positions: Map<string, Position>
  ): CanvasNode[] {
    const nodes: CanvasNode[] = [];

    // Track which activities we've already labeled to avoid duplicates
    const labeledActivities = new Map<string, Position>();

    for (const exec of executions) {
      const pos = positions.get(exec.execution_id) || { x: 0, y: 0 };

      // Add the file node
      nodes.push(this.createFileNode(exec, pos));

      // Add activity label if this is the first execution of this activity
      // or if the previous execution was a different activity
      const activityKey = exec.activity_id;
      if (!labeledActivities.has(activityKey)) {
        labeledActivities.set(activityKey, pos);

        // Create a small label node above the first file node of each activity
        const activityName = exec.template_name || exec.activity_id;
        nodes.push(this.createActivityLabelNode(exec, pos, activityName));
      }
    }

    return nodes;
  }

  /**
   * Create a small text node label for an activity.
   */
  private createActivityLabelNode(
    exec: ExecutionTrace,
    pos: Position,
    activityName: string
  ): CanvasTextNode {
    return {
      id: `label-${exec.activity_id}-${exec.execution_id}`,
      type: 'text',
      x: pos.x,
      y: pos.y - 50,
      width: 200,
      height: 40,
      text: `**${activityName}**`,
      color: this.getActivityCategoryColor(exec)
    } as CanvasTextNode;
  }

  /**
   * Get color based on activity category (inferred from activity_id).
   */
  private getActivityCategoryColor(exec: ExecutionTrace): CanvasColor {
    const activityId = exec.activity_id.toLowerCase();
    if (activityId.includes('bugfix') || activityId.includes('fix')) {
      return CATEGORY_COLORS.bugfix;
    }
    if (activityId.includes('feature') || activityId.includes('add')) {
      return CATEGORY_COLORS.feature;
    }
    if (activityId.includes('refactor')) {
      return CATEGORY_COLORS.refactor;
    }
    if (activityId.includes('tool')) {
      return CATEGORY_COLORS.tool;
    }
    if (activityId.includes('infra')) {
      return CATEGORY_COLORS.infrastructure;
    }
    return '5'; // Default cyan
  }

  /**
   * Create a file node for an execution.
   */
  private createFileNode(
    exec: ExecutionTrace,
    pos: Position,
    width: number = 400,
    height: number = 200
  ): CanvasFileNode {
    return {
      id: exec.execution_id,
      type: 'file',
      x: pos.x,
      y: pos.y,
      width,
      height,
      file: this.getNotePath(exec),
      color: this.getStatusColor(exec)
    };
  }

  /**
   * Get the note path for an execution trace.
   */
  private getNotePath(exec: ExecutionTrace): string {
    const date = new Date(exec.executed_at).toISOString().split('T')[0];
    return `${this.settings.executionNotesFolder}/${date}/${exec.execution_id}.md`;
  }

  /**
   * Get color based on execution status and error type.
   */
  private getStatusColor(exec: ExecutionTrace): CanvasColor {
    if (exec.success) {
      return STATUS_COLORS.success;
    }

    // Partial success: some tasks completed
    if (exec.tasks_completed && exec.tasks_total && exec.tasks_completed > 0 && exec.tasks_completed < exec.tasks_total) {
      return STATUS_COLORS.partial;
    }

    // Use error type color for failed executions
    if (exec.error_type && ERROR_TYPE_COLORS[exec.error_type]) {
      return ERROR_TYPE_COLORS[exec.error_type];
    }

    return STATUS_COLORS.failed;
  }

  /**
   * Get color based on success rate.
   */
  private getSuccessRateColor(rate: number): CanvasColor {
    if (rate >= 0.8) return '4';      // Green
    if (rate >= 0.5) return '3';      // Yellow
    if (rate >= 0.2) return '2';      // Orange
    return '1';                        // Red
  }

  /**
   * Create edges based on execution sequence.
   * Includes activity transition labels when activities change.
   */
  private createSequentialEdges(executions: ExecutionTrace[]): CanvasEdge[] {
    const edges: CanvasEdge[] = [];

    // Sort by timestamp
    const sorted = [...executions].sort((a, b) =>
      new Date(a.executed_at).getTime() - new Date(b.executed_at).getTime()
    );

    // Connect sequential executions
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];

      // Create edge with activity transition label when activities change
      const edge: CanvasEdge = {
        id: `edge-${from.execution_id}-${to.execution_id}`,
        fromNode: from.execution_id,
        toNode: to.execution_id,
        fromSide: 'right',
        toSide: 'left',
        toEnd: 'arrow'
      };

      // Add label when transitioning between different activities
      if (from.activity_id !== to.activity_id) {
        const toName = to.template_name || to.activity_id;
        edge.label = `→ ${toName}`;
      }

      // Color edge based on transition success
      if (!from.success) {
        edge.color = STATUS_COLORS.failed;
      }

      edges.push(edge);
    }

    return edges;
  }

  /**
   * Group executions by activity ID.
   */
  private groupByActivity(executions: ExecutionTrace[]): Map<string, ExecutionTrace[]> {
    const grouped = new Map<string, ExecutionTrace[]>();

    for (const exec of executions) {
      const list = grouped.get(exec.activity_id) || [];
      list.push(exec);
      grouped.set(exec.activity_id, list);
    }

    return grouped;
  }

  /**
   * Calculate summary metrics for an activity.
   */
  private calculateActivitySummary(executions: ExecutionTrace[]): ActivitySummary {
    const successful = executions.filter(e => e.success);

    return {
      activityId: executions[0]?.activity_id || '',
      templateName: executions[0]?.template_name || 'Unknown',
      totalExecutions: executions.length,
      successfulExecutions: successful.length,
      successRate: successful.length / executions.length,
      totalDurationMs: executions.reduce((sum, e) => sum + (e.duration_ms || 0), 0),
      avgDurationMs: executions.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / executions.length,
      totalCostUsd: executions.reduce((sum, e) => sum + getCost(e), 0),
      lastExecutedAt: executions.reduce((latest, e) =>
        new Date(e.executed_at) > new Date(latest) ? e.executed_at : latest,
        executions[0]?.executed_at || ''
      )
    };
  }

  /**
   * Format activity summary as markdown.
   */
  private formatActivitySummary(summary: ActivitySummary): string {
    return `# ${summary.templateName}

## Metrics
- **Executions**: ${summary.totalExecutions}
- **Success Rate**: ${Math.round(summary.successRate * 100)}%
- **Avg Duration**: ${Math.round(summary.avgDurationMs / 1000)}s
- **Total Cost**: $${summary.totalCostUsd.toFixed(4)}

## Timeline
- **Last Run**: ${new Date(summary.lastExecutedAt).toLocaleString()}

---
*Activity ID: ${summary.activityId}*`;
  }

  /**
   * Extract execution data from existing canvas nodes.
   * Used for incremental updates.
   */
  private extractExecutionsFromNodes(nodes: CanvasNode[]): ExecutionTrace[] {
    // This is a simplified extraction - in practice you'd need
    // to fetch full execution data from the API
    return nodes
      .filter((n): n is CanvasFileNode => n.type === 'file')
      .map(n => ({
        execution_id: n.id,
        activity_id: '', // Would need to be extracted from note
        template_id: '',
        template_name: '',
        success: n.color === STATUS_COLORS.success,
        executed_at: new Date().toISOString(),
        duration_ms: 0,
        cost: 0,
        tasks_completed: 0,
        tasks_total: 0
      }));
  }

  // ===========================================================================
  // Composition Graph Canvas
  // ===========================================================================

  /**
   * Build a canvas showing activity composition relationships.
   * Shows how activities relate to each other through impulse flows.
   */
  async buildCompositionCanvas(
    graph: CompositionGraph,
    name: string = 'composition-graph'
  ): Promise<void> {
    if (graph.nodes.length === 0) {
      // Create empty canvas with placeholder
      const emptyCanvas: CanvasData = {
        nodes: [{
          id: 'empty-placeholder',
          type: 'text',
          x: 0,
          y: 0,
          width: 400,
          height: 100,
          text: '# No Composition Data\n\nNo activity composition data found. Run activities with parent-child relationships to see them here.',
          color: '3'
        }],
        edges: []
      };
      await this.canvasManager.createOrUpdateCanvas(name, emptyCanvas);
      return;
    }

    // Calculate positions using hierarchical layout
    const positions = this.calculateCompositionLayout(graph);

    // Create nodes and edges
    const nodes = this.createCompositionNodes(graph.nodes, positions);
    const edges = this.createCompositionEdges(graph.edges);

    await this.canvasManager.createOrUpdateCanvas(name, { nodes, edges });
  }

  /**
   * Calculate layout positions for composition graph nodes.
   * Uses a simple hierarchical layout based on edge relationships.
   */
  private calculateCompositionLayout(graph: CompositionGraph): Map<string, Position> {
    const positions = new Map<string, Position>();
    const nodeWidth = 350;
    const nodeHeight = 150;
    const horizontalGap = 200;
    const verticalGap = 150;

    // Find root nodes (nodes that are parents but not children)
    const childIds = new Set(graph.edges.map(e => e.childActivityId));
    const parentIds = new Set(graph.edges.map(e => e.parentActivityId));
    const rootIds = [...parentIds].filter(id => !childIds.has(id));

    // If no clear roots, use all nodes
    const startNodes = rootIds.length > 0 ? rootIds : graph.nodes.map(n => n.id);

    // Build adjacency map
    const children = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const existing = children.get(edge.parentActivityId) || [];
      existing.push(edge.childActivityId);
      children.set(edge.parentActivityId, existing);
    }

    // BFS to assign levels
    const levels = new Map<string, number>();
    const queue = startNodes.map(id => ({ id, level: 0 }));
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { id, level } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      levels.set(id, level);

      const nodeChildren = children.get(id) || [];
      for (const childId of nodeChildren) {
        if (!visited.has(childId)) {
          queue.push({ id: childId, level: level + 1 });
        }
      }
    }

    // Handle nodes not reached by BFS (disconnected)
    for (const node of graph.nodes) {
      if (!levels.has(node.id)) {
        levels.set(node.id, 0);
      }
    }

    // Group nodes by level
    const nodesByLevel = new Map<number, string[]>();
    for (const [id, level] of levels) {
      const existing = nodesByLevel.get(level) || [];
      existing.push(id);
      nodesByLevel.set(level, existing);
    }

    // Calculate positions
    for (const [level, nodeIds] of nodesByLevel) {
      const x = level * (nodeWidth + horizontalGap);
      nodeIds.forEach((id, index) => {
        const y = index * (nodeHeight + verticalGap);
        positions.set(id, { x, y });
      });
    }

    return positions;
  }

  /**
   * Create canvas text nodes for composition graph activities.
   */
  private createCompositionNodes(
    nodes: CompositionNode[],
    positions: Map<string, Position>
  ): CanvasTextNode[] {
    return nodes.map(node => {
      const pos = positions.get(node.id) || { x: 0, y: 0 };
      const successRate = node.successRate ?? 0;

      return {
        id: node.id,
        type: 'text',
        x: pos.x,
        y: pos.y,
        width: 350,
        height: 150,
        text: this.formatCompositionNodeText(node),
        color: this.getSuccessRateColor(successRate)
      } as CanvasTextNode;
    });
  }

  /**
   * Format composition node as markdown text.
   */
  private formatCompositionNodeText(node: CompositionNode): string {
    const successPct = Math.round((node.successRate ?? 0) * 100);
    const avgDuration = node.avgDurationMs
      ? `${Math.round(node.avgDurationMs / 1000)}s`
      : 'N/A';

    return `# ${node.activityName || node.activityId}

## Metrics
- **Executions**: ${node.executionCount ?? 0}
- **Success Rate**: ${successPct}%
- **Avg Duration**: ${avgDuration}

---
*ID: ${node.activityId}*`;
  }

  /**
   * Create canvas edges for composition relationships.
   */
  private createCompositionEdges(edges: CompositionEdge[]): CanvasEdge[] {
    return edges.map(edge => {
      const successRate = edge.successRate ?? 0;
      const label = edge.impulseShape
        ? `${edge.impulseShape} (${Math.round(successRate * 100)}%)`
        : `${Math.round(successRate * 100)}%`;

      return {
        id: edge.id,
        fromNode: edge.parentActivityId,
        toNode: edge.childActivityId,
        fromSide: 'right',
        toSide: 'left',
        toEnd: 'arrow',
        color: this.getSuccessRateColor(successRate),
        label
      };
    });
  }
}

/**
 * Summary metrics for an activity.
 */
interface ActivitySummary {
  activityId: string;
  templateName: string;
  totalExecutions: number;
  successfulExecutions: number;
  successRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalCostUsd: number;
  lastExecutedAt: string;
}
