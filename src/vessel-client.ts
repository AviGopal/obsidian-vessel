/**
 * Vessel Client
 *
 * Handles vessel registration and discovery with the Activity API.
 * Implements heartbeat mechanism to maintain active registration.
 *
 * Based on patterns from:
 * - repos/minibob/src/vessel-bootstrap.ts
 * - repos/metabob-activity-api/src/routes/vessel-registry.ts
 */

import { requestUrl } from 'obsidian';
import { MetabobVesselSettings } from './settings';

// =============================================================================
// Types
// =============================================================================

/**
 * Capability types supported by vessels
 */
export interface VesselCapability {
  type: 'impulse-resolver' | 'tool' | 'activity' | 'mcp-server';
  shapes?: string[];
  tools?: string[];
  activities?: string[];
  mcp?: {
    protocol: string;
    tools: string[];
  };
  port?: number;
}

/**
 * Registration payload sent to the backend
 */
export interface VesselRegistration {
  vesselId: string;
  vesselName: string;
  endpoint: string;
  shapes: string[];
  capabilities?: VesselCapability[];
  metadata?: {
    version: string;
    capabilities: VesselCapability[];
    vaultPath?: string;
    obsidianVersion?: string;
    pluginVersion?: string;
  };
  ttl?: number;
}

/**
 * Registration response from the backend
 */
export interface RegistrationResponse {
  id: string;
  expires_at: string;
  success?: boolean;
  vesselId?: string;
  timestamp?: string;
  message?: string;
}

/**
 * Heartbeat payload sent to maintain registration
 */
export interface HeartbeatPayload {
  vesselId: string;
  status: 'idle' | 'active' | 'syncing' | 'error';
  metrics?: {
    resolutionsCompleted: number;
    syncedNotes: number;
    uptime: number;
    lastError?: string;
  };
}

/**
 * Heartbeat response from the backend
 */
export interface HeartbeatResponse {
  success: boolean;
  pod_name?: string;
  timestamp: string;
}

/**
 * Options for vessel client
 */
export interface VesselClientOptions {
  /** Logger function for debug output */
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  /** Maximum retry attempts for registration */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  baseRetryDelay?: number;
  /** Maximum delay for exponential backoff (ms) */
  maxRetryDelay?: number;
}

// =============================================================================
// Logger
// =============================================================================

const defaultLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => {
  const prefix = '[VesselClient]';
  const logData = data ? ` ${JSON.stringify(data)}` : '';
  switch (level) {
    case 'debug':
      console.debug(`${prefix} ${message}${logData}`);
      break;
    case 'info':
      console.log(`${prefix} ${message}${logData}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}${logData}`);
      break;
    case 'error':
      console.error(`${prefix} ${message}${logData}`);
      break;
  }
};

// =============================================================================
// Vessel Client
// =============================================================================

/**
 * VesselClient manages registration and heartbeat with the Activity API.
 *
 * Usage:
 * ```typescript
 * const client = new VesselClient(settings);
 * await client.register('/path/to/vault', 3847);
 * client.startHeartbeat(30000);
 *
 * // During operation
 * client.incrementResolutions();
 * client.incrementSyncedNotes();
 *
 * // On shutdown
 * await client.deregister();
 * ```
 */
export class VesselClient {
  private settings: MetabobVesselSettings;
  private registered: boolean = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private startTime: number;
  private resolutionCount: number = 0;
  private syncedNotesCount: number = 0;
  private currentStatus: HeartbeatPayload['status'] = 'idle';
  private lastError: string | undefined;
  private expiresAt: Date | null = null;
  private logger: NonNullable<VesselClientOptions['logger']>;
  private maxRetries: number;
  private baseRetryDelay: number;
  private maxRetryDelay: number;
  private vaultPath: string = '';
  private serverPort: number = 0;

  constructor(settings: MetabobVesselSettings, options: VesselClientOptions = {}) {
    this.settings = settings;
    this.startTime = Date.now();
    this.logger = options.logger || defaultLogger;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseRetryDelay = options.baseRetryDelay ?? 1000;
    this.maxRetryDelay = options.maxRetryDelay ?? 30000;
  }

  /**
   * Register this vessel with the Activity API
   *
   * @param vaultPath - Path to the Obsidian vault
   * @param port - Port the local HTTP server is listening on
   * @returns true if registration succeeded
   */
  async register(vaultPath: string, port: number): Promise<boolean> {
    this.vaultPath = vaultPath;
    this.serverPort = port;

    const { vesselId, vesselName, discoveryVesselEndpoint, advertisedHost, shapes, apiKey } = this.settings;

    // Endpoint the SUBSTRATE (in the container) uses to reach this host-side
    // plugin: the container->host gateway, not localhost.
    const endpoint = `http://${advertisedHost || 'host.docker.internal'}:${port}`;

    // Discovery RegisterRequest. systemVessel:true is REQUIRED or the substrate's
    // org-scoped vesselRegistry query hides it (the original bug). Resolve
    // contract points callers at `${endpoint}/resolve`, ApiKey auth, pointer body.
    const registration = {
      vesselId,
      vesselName,
      version: '0.1.0',
      endpoint,
      shapes,
      protocol: 'http',
      systemVessel: true,
      resolve_endpoint: '/resolve',
      resolve_request_format: 'pointer',
      auth_scheme: 'ApiKey',
      resolve_timeout_ms: 10000,
      metadata: { vaultPath, pluginVersion: '0.1.0' },
      ttl: this.settings.registrationTtl,
    };

    this.logger('info', 'Registering vessel', {
      vesselId,
      vesselName,
      endpoint,
      shapes,
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(
          `${discoveryVesselEndpoint}/register`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { 'Authorization': `ApiKey ${apiKey}` } : {}),
            },
            body: JSON.stringify(registration),
          },
          10000 // 10 second timeout
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Registration failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result: RegistrationResponse = await response.json();

        this.registered = true;
        this.expiresAt = result.expires_at ? new Date(result.expires_at) : null;
        this.currentStatus = 'idle';

        this.logger('info', 'Vessel registered successfully', {
          vesselId,
          expiresAt: result.expires_at,
        });

        return true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger('warn', `Registration attempt ${attempt + 1}/${this.maxRetries} failed`, {
          error: lastError.message,
        });

        if (attempt < this.maxRetries - 1) {
          const delay = this.calculateBackoffDelay(attempt);
          this.logger('debug', `Retrying in ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }

    this.logger('error', 'Registration failed after all retries', {
      error: lastError?.message,
    });
    this.lastError = lastError?.message;
    return false;
  }

  /**
   * Deregister this vessel from the Activity API
   */
  async deregister(): Promise<void> {
    this.stopHeartbeat();

    if (!this.registered) {
      this.logger('debug', 'Vessel not registered, skipping deregistration');
      return;
    }

    const { vesselId, discoveryVesselEndpoint, apiKey } = this.settings;

    this.logger('info', 'Deregistering vessel', { vesselId });

    try {
      const response = await this.fetchWithTimeout(
        `${discoveryVesselEndpoint}/vessels/${vesselId}`,
        {
          method: 'DELETE',
          headers: {
            ...(apiKey ? { 'Authorization': `ApiKey ${apiKey}` } : {}),
          },
        },
        10000
      );

      if (response.ok || response.status === 204 || response.status === 404) {
        this.logger('info', 'Vessel deregistered successfully', { vesselId });
      } else {
        const errorText = await response.text();
        this.logger('warn', 'Deregistration returned non-success status', {
          status: response.status,
          error: errorText,
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger('error', 'Deregistration failed', { error: err.message });
    } finally {
      this.registered = false;
      this.expiresAt = null;
    }
  }

  /**
   * Start sending heartbeats at the specified interval
   *
   * @param intervalMs - Heartbeat interval in milliseconds (default: 30000)
   */
  startHeartbeat(intervalMs: number = 30000): void {
    if (this.heartbeatInterval) {
      this.logger('warn', 'Heartbeat already running, stopping existing one');
      this.stopHeartbeat();
    }

    this.logger('info', 'Starting heartbeat', { intervalMs });

    // Send initial heartbeat
    this.sendHeartbeat();

    // Schedule recurring heartbeats
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, intervalMs);
  }

  /**
   * Stop sending heartbeats
   */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger('info', 'Heartbeat stopped');
    }
  }

  /**
   * Send a single heartbeat to the backend
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.registered) {
      this.logger('debug', 'Not registered, skipping heartbeat');
      return;
    }

    const { vesselId, vesselName, discoveryVesselEndpoint, advertisedHost, shapes, apiKey } = this.settings;

    try {
      // Re-registering with discovery is idempotent and refreshes the TTL while
      // keeping the resolve contract current; it also self-heals if discovery
      // restarted and lost the registry.
      const registration = {
        vesselId,
        vesselName,
        version: '0.1.0',
        endpoint: `http://${advertisedHost || 'host.docker.internal'}:${this.serverPort}`,
        shapes,
        protocol: 'http',
        systemVessel: true,
        resolve_endpoint: '/resolve',
        resolve_request_format: 'pointer',
        auth_scheme: 'ApiKey',
        resolve_timeout_ms: 10000,
        metadata: { vaultPath: this.vaultPath, pluginVersion: '0.1.0' },
        ttl: this.settings.registrationTtl,
      };

      const response = await this.fetchWithTimeout(
        `${discoveryVesselEndpoint}/register`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `ApiKey ${apiKey}` } : {}),
          },
          body: JSON.stringify(registration),
        },
        10000
      );

      if (response.ok) {
        const result: RegistrationResponse = await response.json();
        this.expiresAt = result.expires_at ? new Date(result.expires_at) : null;
        this.lastError = undefined;
        this.logger('debug', 'Heartbeat sent', { expiresAt: result.expires_at });
      } else {
        const errorText = await response.text();
        throw new Error(`Heartbeat failed: ${response.status} - ${errorText}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err.message;
      this.logger('warn', 'Heartbeat failed', { error: err.message });

      // If heartbeat fails repeatedly, try re-registering
      if (this.expiresAt && new Date() > this.expiresAt) {
        this.logger('warn', 'Registration expired, attempting re-registration');
        this.registered = false;
        await this.register(this.vaultPath, this.serverPort);
      }
    }
  }

  /**
   * Increment the resolution counter
   */
  incrementResolutions(): void {
    this.resolutionCount++;
  }

  /**
   * Increment the synced notes counter
   */
  incrementSyncedNotes(): void {
    this.syncedNotesCount++;
  }

  /**
   * Check if the vessel is currently registered
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the current registration expiration time
   */
  getExpiresAt(): Date | null {
    return this.expiresAt;
  }

  /**
   * Get the current vessel status
   */
  getStatus(): HeartbeatPayload['status'] {
    return this.currentStatus;
  }

  /**
   * Set the current vessel status
   */
  setStatus(status: HeartbeatPayload['status']): void {
    this.currentStatus = status;
  }

  /**
   * Get current metrics
   */
  getMetrics(): HeartbeatPayload['metrics'] {
    return {
      resolutionsCompleted: this.resolutionCount,
      syncedNotes: this.syncedNotesCount,
      uptime: Date.now() - this.startTime,
      lastError: this.lastError,
    };
  }

  /**
   * Update settings and re-register if needed
   */
  async updateSettings(newSettings: MetabobVesselSettings): Promise<void> {
    const needsReregister =
      newSettings.vesselId !== this.settings.vesselId ||
      newSettings.vesselName !== this.settings.vesselName ||
      newSettings.activityApiUrl !== this.settings.activityApiUrl ||
      JSON.stringify(newSettings.shapes) !== JSON.stringify(this.settings.shapes);

    this.settings = newSettings;

    if (needsReregister && this.registered) {
      this.logger('info', 'Settings changed, re-registering vessel');
      await this.deregister();
      await this.register(this.vaultPath, this.serverPort);
      this.startHeartbeat(this.settings.heartbeatInterval);
    }
  }

  // =============================================================================
  // Private Helpers
  // =============================================================================

  /**
   * Fetch with timeout support
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    _timeoutMs: number
  ): Promise<{ ok: boolean; status: number; statusText: string; text(): Promise<string>; json(): Promise<unknown> }> {
    const resp = await requestUrl({
      url,
      method: (options.method as string) || 'GET',
      headers: (options.headers as Record<string, string>) || {},
      body: options.body as string | undefined,
      throw: false,
    });
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: String(resp.status),
      text: () => Promise.resolve(resp.text),
      json: () => Promise.resolve(resp.json),
    };
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = this.baseRetryDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * delay; // 0-30% jitter
    return Math.min(delay + jitter, this.maxRetryDelay);
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

