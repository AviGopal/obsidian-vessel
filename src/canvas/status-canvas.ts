import { App } from 'obsidian';
import {
  CanvasData,
  CanvasNode,
  CanvasEdge,
  CanvasTextNode,
  CanvasGroupNode
} from '../types/canvas';
import { MetabobVesselSettings } from '../settings';

type CanvasColor = '1' | '2' | '3' | '4' | '5' | '6' | string;

/**
 * System status for display in canvas.
 */
interface SystemStatus {
  vesselConnected: boolean;
  realtimeConnected: boolean;
  lastSyncedAt: string | null;
  recentExecutions: number;
  successRate: number;
  activeActivities: number;
  pendingSync: number;
}
import { CanvasManager } from './canvas-manager';

/**
 * Connection status indicator colors.
 */
const CONNECTION_STATUS = {
  connected: '4' as CanvasColor,      // Green
  disconnected: '1' as CanvasColor,   // Red
  connecting: '3' as CanvasColor,     // Yellow
  degraded: '2' as CanvasColor        // Orange
};

/**
 * Builds system status visualization canvases.
 * Displays vessel connection, sync status, and recent metrics.
 */
export class StatusCanvasBuilder {
  private canvasManager: CanvasManager;

  constructor(
    private app: App,
    private settings: MetabobVesselSettings
  ) {
    this.canvasManager = new CanvasManager(app, settings);
  }

  /**
   * Build a canvas showing system status.
   */
  async buildStatusCanvas(status: SystemStatus): Promise<void> {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    // Central vessel status node
    const vesselNode = this.createVesselStatusNode(status);
    nodes.push(vesselNode);

    // Connection status nodes (arranged around vessel)
    const connectionNodes = this.createConnectionNodes(status);
    nodes.push(...connectionNodes);

    // Metrics summary node
    const metricsNode = this.createMetricsSummaryNode(status);
    nodes.push(metricsNode);

    // Sync status node
    const syncNode = this.createSyncStatusNode(status);
    nodes.push(syncNode);

    // Create edges from vessel to status nodes
    edges.push(
      ...this.createConnectionEdges(vesselNode.id, connectionNodes.map(n => n.id)),
      { id: 'edge-vessel-metrics', fromNode: vesselNode.id, toNode: metricsNode.id, fromSide: 'bottom', toSide: 'top', toEnd: 'arrow' },
      { id: 'edge-vessel-sync', fromNode: vesselNode.id, toNode: syncNode.id, fromSide: 'right', toSide: 'left', toEnd: 'arrow' }
    );

    await this.canvasManager.createOrUpdateCanvas('system-status', { nodes, edges });
  }

  /**
   * Build a dashboard canvas with multiple status sections.
   */
  async buildDashboardCanvas(
    status: SystemStatus,
    recentActivity: RecentActivityData
  ): Promise<void> {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];

    // Header group
    const headerGroup = this.createHeaderGroup(status);
    nodes.push(headerGroup);

    // Connection status group
    const connectionGroup = this.createConnectionGroup(status);
    nodes.push(connectionGroup);

    // Activity metrics group
    const activityGroup = this.createActivityGroup(recentActivity);
    nodes.push(activityGroup);

    // Quick actions group
    const actionsGroup = this.createActionsGroup();
    nodes.push(actionsGroup);

    await this.canvasManager.createOrUpdateCanvas('dashboard', { nodes, edges });
  }

  /**
   * Update just the status portion of an existing dashboard.
   */
  async updateStatus(status: SystemStatus): Promise<void> {
    const existing = await this.canvasManager.readCanvas('system-status');

    if (!existing) {
      await this.buildStatusCanvas(status);
      return;
    }

    // Update specific nodes by replacing them
    const updatedNodes = existing.nodes.map(node => {
      if (node.id === 'vessel-status') {
        return this.createVesselStatusNode(status);
      }
      if (node.id === 'metrics-summary') {
        return this.createMetricsSummaryNode(status);
      }
      if (node.id === 'sync-status') {
        return this.createSyncStatusNode(status);
      }
      if (node.id === 'api-connection') {
        return this.createApiConnectionNode(status);
      }
      if (node.id === 'realtime-connection') {
        return this.createRealtimeConnectionNode(status);
      }
      return node;
    });

    await this.canvasManager.createOrUpdateCanvas('system-status', {
      nodes: updatedNodes,
      edges: existing.edges
    });
  }

  /**
   * Create the central vessel status node.
   */
  private createVesselStatusNode(status: SystemStatus): CanvasTextNode {
    const isHealthy = status.vesselConnected && status.realtimeConnected;
    const statusEmoji = isHealthy ? '' : '';  // No emojis per guidelines
    const statusText = isHealthy ? 'HEALTHY' : 'DEGRADED';

    return {
      id: 'vessel-status',
      type: 'text',
      x: 300,
      y: 200,
      width: 400,
      height: 200,
      color: isHealthy ? CONNECTION_STATUS.connected : CONNECTION_STATUS.degraded,
      text: `# Metabob Vessel

## Status: ${statusText}

**API**: ${status.vesselConnected ? 'Connected' : 'Disconnected'}
**Realtime**: ${status.realtimeConnected ? 'Connected' : 'Disconnected'}
**Active Activities**: ${status.activeActivities}

---
Last updated: ${new Date().toLocaleTimeString()}`
    };
  }

  /**
   * Create connection status nodes.
   */
  private createConnectionNodes(status: SystemStatus): CanvasTextNode[] {
    return [
      this.createApiConnectionNode(status),
      this.createRealtimeConnectionNode(status)
    ];
  }

  /**
   * Create API connection node.
   */
  private createApiConnectionNode(status: SystemStatus): CanvasTextNode {
    return {
      id: 'api-connection',
      type: 'text',
      x: 100,
      y: 50,
      width: 250,
      height: 120,
      color: status.vesselConnected ? CONNECTION_STATUS.connected : CONNECTION_STATUS.disconnected,
      text: `## API Connection

**Status**: ${status.vesselConnected ? 'Connected' : 'Disconnected'}
**Endpoint**: ${this.settings.activityApiUrl}

${status.vesselConnected ? 'Receiving traces' : 'Check API key'}`
    };
  }

  /**
   * Create realtime connection node.
   */
  private createRealtimeConnectionNode(status: SystemStatus): CanvasTextNode {
    return {
      id: 'realtime-connection',
      type: 'text',
      x: 500,
      y: 50,
      width: 250,
      height: 120,
      color: status.realtimeConnected ? CONNECTION_STATUS.connected : CONNECTION_STATUS.disconnected,
      text: `## Realtime Updates

**Status**: ${status.realtimeConnected ? 'Connected' : 'Disconnected'}
**WebSocket**: ${this.settings.websocketUrl}

${status.realtimeConnected ? 'Live updates enabled' : 'Polling fallback'}`
    };
  }

  /**
   * Create metrics summary node.
   */
  private createMetricsSummaryNode(status: SystemStatus): CanvasTextNode {
    const successRateColor = this.getSuccessRateColor(status.successRate);

    return {
      id: 'metrics-summary',
      type: 'text',
      x: 200,
      y: 450,
      width: 350,
      height: 200,
      color: successRateColor,
      text: `# Execution Metrics

## Recent Activity
- **Executions**: ${status.recentExecutions}
- **Success Rate**: ${Math.round(status.successRate * 100)}%

## Performance
- **Active Activities**: ${status.activeActivities}
- **Pending Sync**: ${status.pendingSync}

---
*Click nodes below for details*`
    };
  }

  /**
   * Create sync status node.
   */
  private createSyncStatusNode(status: SystemStatus): CanvasTextNode {
    const syncedRecently = status.lastSyncedAt &&
      (Date.now() - new Date(status.lastSyncedAt).getTime()) < 5 * 60 * 1000;

    return {
      id: 'sync-status',
      type: 'text',
      x: 600,
      y: 300,
      width: 250,
      height: 150,
      color: syncedRecently ? '4' : '3',
      text: `## Sync Status

**Last Sync**: ${status.lastSyncedAt
  ? new Date(status.lastSyncedAt).toLocaleTimeString()
  : 'Never'}

**Pending**: ${status.pendingSync} items
**Auto-sync**: ${this.settings.autoSync ? 'Enabled' : 'Disabled'}
**Interval**: ${this.settings.syncInterval} min`
    };
  }

  /**
   * Create header group for dashboard.
   */
  private createHeaderGroup(status: SystemStatus): CanvasGroupNode {
    return {
      id: 'header-group',
      type: 'group',
      x: 0,
      y: 0,
      width: 900,
      height: 100,
      label: 'Metabob Vessel Dashboard',
      color: status.vesselConnected ? '4' : '1'
    };
  }

  /**
   * Create connection group for dashboard.
   */
  private createConnectionGroup(status: SystemStatus): CanvasGroupNode {
    return {
      id: 'connection-group',
      type: 'group',
      x: 0,
      y: 120,
      width: 400,
      height: 300,
      label: 'Connection Status'
    };
  }

  /**
   * Create activity group for dashboard.
   */
  private createActivityGroup(activity: RecentActivityData): CanvasGroupNode {
    return {
      id: 'activity-group',
      type: 'group',
      x: 420,
      y: 120,
      width: 480,
      height: 300,
      label: `Recent Activity (${activity.totalExecutions} executions)`
    };
  }

  /**
   * Create actions group for dashboard.
   */
  private createActionsGroup(): CanvasGroupNode {
    return {
      id: 'actions-group',
      type: 'group',
      x: 0,
      y: 440,
      width: 900,
      height: 120,
      label: 'Quick Actions'
    };
  }

  /**
   * Create edges from central node to surrounding nodes.
   */
  private createConnectionEdges(fromId: string, toIds: string[]): CanvasEdge[] {
    return toIds.map((toId, index) => ({
      id: `edge-${fromId}-${toId}`,
      fromNode: fromId,
      toNode: toId,
      fromSide: 'top' as const,
      toSide: 'bottom' as const,
      toEnd: 'arrow' as const
    }));
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
}

/**
 * Recent activity data for dashboard.
 */
export interface RecentActivityData {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  activeActivities: string[];
  topTemplates: Array<{
    name: string;
    count: number;
    successRate: number;
  }>;
  recentExecutions: Array<{
    id: string;
    templateName: string;
    success: boolean;
    executedAt: string;
  }>;
}
