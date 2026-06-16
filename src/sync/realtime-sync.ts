/**
 * Real-time Sync Service
 *
 * WebSocket-based real-time sync for execution traces.
 * Connects to the Activity API WebSocket and creates
 * notes as executions complete.
 */

import type { App } from 'obsidian';
import type { ExecutionTrace, MetabobVesselSettings } from './historical-sync';

/**
 * WebSocket message types from Activity API
 */
export interface WebSocketMessage {
  type: 'execution_started' | 'execution_completed' | 'template_updated' | 'pod_status_changed' | 'error' | 'authenticated';
  timestamp?: string;
  data: any;
}

/**
 * Execution started event
 */
export interface ExecutionStartedMessage extends WebSocketMessage {
  type: 'execution_started';
  data: {
    execution_id: string;
    variant_id: string;
    pod_name?: string;
  };
}

/**
 * Execution completed event - contains full trace
 */
export interface ExecutionCompletedMessage extends WebSocketMessage {
  type: 'execution_completed';
  data: ExecutionTrace;
}

/**
 * Connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/**
 * Callback for execution events
 */
export type ExecutionCallback = (execution: ExecutionTrace) => Promise<void>;

/**
 * Callback for connection status changes
 */
export type StatusCallback = (connected: boolean, state: ConnectionState) => void;

/**
 * Service for real-time WebSocket sync
 */
export class RealtimeSyncService {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private baseReconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingIntervalMs: number = 30000;
  private connectionState: ConnectionState = 'disconnected';

  constructor(
    private app: App,
    private settings: MetabobVesselSettings,
    private onExecution: ExecutionCallback,
    private onStatusChange: StatusCallback
  ) {}

  /**
   * Connect to the Activity API WebSocket
   */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      console.log('[RealtimeSync] Already connected or connecting');
      return;
    }

    this.setConnectionState('connecting');
    const wsUrl = this.buildWebSocketUrl();

    console.log('[RealtimeSync] Connecting to:', wsUrl);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[RealtimeSync] Connected');
        this.setConnectionState('connected');
        this.reconnectAttempts = 0;

        // Authenticate if API key available
        if (this.settings.apiKey) {
          this.sendMessage({
            type: 'authenticate',
            token: this.settings.apiKey,
          });
        }

        // Start ping/pong for keepalive
        this.startPingTimer();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event);
      };

      this.ws.onerror = (error) => {
        console.error('[RealtimeSync] WebSocket error:', error);
        this.setConnectionState('error');
      };

      this.ws.onclose = (event) => {
        console.log('[RealtimeSync] Connection closed', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });

        this.stopPingTimer();

        // Don't reconnect if close was intentional (code 1000)
        if (event.code === 1000) {
          this.setConnectionState('disconnected');
          return;
        }

        // Schedule reconnection
        this.scheduleReconnect();
      };

    } catch (error) {
      console.error('[RealtimeSync] Failed to create WebSocket:', error);
      this.setConnectionState('error');
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    console.log('[RealtimeSync] Disconnecting');

    // Clear timers
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingTimer();

    // Close connection
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.setConnectionState('disconnected');
    this.reconnectAttempts = 0;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Build WebSocket URL from settings
   */
  private buildWebSocketUrl(): string {
    let endpoint = this.settings.websocketUrl || this.settings.activityApiUrl;

    // Convert HTTP to WS
    endpoint = endpoint.replace('http://', 'ws://').replace('https://', 'wss://');

    // Remove trailing slash
    endpoint = endpoint.replace(/\/$/, '');

    // Add /ws path only if not already present
    if (!endpoint.endsWith('/ws')) endpoint = `${endpoint}/ws`;
    return endpoint;
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(event: MessageEvent): void {
    try {
      const message: WebSocketMessage = JSON.parse(event.data);

      console.log('[RealtimeSync] Received message:', message.type);

      switch (message.type) {
        case 'authenticated':
          console.log('[RealtimeSync] Authentication successful');
          break;

        case 'execution_started':
          this.handleExecutionStarted(message as ExecutionStartedMessage);
          break;

        case 'execution_completed':
          this.handleExecutionCompleted(message as ExecutionCompletedMessage);
          break;

        case 'template_updated':
          // Optionally handle template updates
          console.log('[RealtimeSync] Template updated:', message.data);
          break;

        case 'pod_status_changed':
          // Optionally handle pod status
          console.log('[RealtimeSync] Pod status changed:', message.data);
          break;

        case 'error':
          console.error('[RealtimeSync] Server error:', message.data);
          break;

        default:
          console.log('[RealtimeSync] Unknown message type:', (message as any).type);
      }

    } catch (error) {
      console.error('[RealtimeSync] Failed to parse message:', error);
    }
  }

  /**
   * Handle execution started event
   */
  private handleExecutionStarted(message: ExecutionStartedMessage): void {
    console.log('[RealtimeSync] Execution started:', {
      execution_id: message.data.execution_id,
      variant_id: message.data.variant_id,
    });
    // Could show a notice or update UI here
  }

  /**
   * Handle execution completed event
   */
  private async handleExecutionCompleted(message: ExecutionCompletedMessage): Promise<void> {
    console.log('[RealtimeSync] Execution completed:', {
      execution_id: message.data.execution_id,
      success: message.data.success,
    });

    try {
      await this.onExecution(message.data);
    } catch (error) {
      console.error('[RealtimeSync] Failed to process execution:', error);
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[RealtimeSync] Max reconnect attempts reached');
      this.setConnectionState('error');
      return;
    }

    // Calculate delay with exponential backoff and jitter
    const exponentialDelay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    const jitter = Math.random() * 1000;
    const delay = exponentialDelay + jitter;

    console.log('[RealtimeSync] Scheduling reconnect', {
      attempt: this.reconnectAttempts + 1,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: Math.round(delay),
    });

    this.setConnectionState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Send a message through the WebSocket
   */
  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('[RealtimeSync] Cannot send message - not connected');
    }
  }

  /**
   * Start ping timer for keepalive
   */
  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.isConnected()) {
        this.sendMessage({ type: 'ping' });
      }
    }, this.pingIntervalMs);
  }

  /**
   * Stop ping timer
   */
  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Update connection state and notify listeners
   */
  private setConnectionState(state: ConnectionState): void {
    const wasConnected = this.connectionState === 'connected';
    this.connectionState = state;
    const isConnected = state === 'connected';

    if (wasConnected !== isConnected) {
      this.onStatusChange(isConnected, state);
    }
  }

  /**
   * Get reconnect attempts count
   */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Reset reconnect counter (for manual reconnect)
   */
  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  /**
   * Force immediate reconnection
   */
  async reconnect(): Promise<void> {
    this.disconnect();
    this.resetReconnectAttempts();
    await this.connect();
  }
}
