/**
 * HTTP Server for Obsidian Vessel
 *
 * Lightweight HTTP server using Node's built-in http module.
 * Provides impulse resolution endpoints for MiniBob integration.
 *
 * Security: Binds to 127.0.0.1 only (localhost) to prevent remote access.
 */

import * as http from 'http';
import type { IncomingMessage, ServerResponse, Server } from 'http';
import { handleCors, type CorsOptions } from './cors';
import {
  sendError,
  sendJson,
  handleHealth,
  handleManifest,
  handleResolve,
  type RouteContext,
  type VesselManifest,
  type ImpulseResolver,
} from './routes';

/** HTTP server configuration */
export interface HTTPServerConfig {
  /** Port to bind to (default: 27182) */
  port?: number;
  /** Host to bind to (default: 127.0.0.1 for security) */
  host?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** CORS configuration */
  cors?: CorsOptions;
  /** Vessel manifest */
  manifest: VesselManifest;
  /** Map of impulse type to resolver */
  resolvers?: Map<string, ImpulseResolver>;
  /** Logger function */
  logger?: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

/** Route handler type */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Default CORS options for local development */
const DEFAULT_CORS: CorsOptions = {
  allowedOrigins: [
    'http://localhost:*',
    'http://127.0.0.1:*',
    'app://obsidian.md',
    'capacitor://localhost', // Obsidian mobile
  ],
  allowedMethods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Vessel-Id'],
  credentials: false,
  maxAge: 86400,
};

/** Default logger */
const defaultLogger = (message: string, level: string = 'info') => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [obsidian-vessel] [${level.toUpperCase()}] ${message}`);
};

/**
 * HTTP Server for Obsidian Vessel impulse resolution
 */
export class HTTPServer {
  private server: Server | null = null;
  private config: Required<Omit<HTTPServerConfig, 'cors' | 'resolvers'>> & {
    cors: CorsOptions;
    resolvers: Map<string, ImpulseResolver>;
  };
  private routes: Map<string, RouteHandler> = new Map();
  private isShuttingDown = false;

  constructor(config: HTTPServerConfig) {
    this.config = {
      port: config.port ?? 27182,
      host: config.host ?? '127.0.0.1',
      timeout: config.timeout ?? 30000,
      cors: config.cors ?? DEFAULT_CORS,
      manifest: config.manifest,
      resolvers: config.resolvers ?? new Map(),
      logger: config.logger ?? defaultLogger,
    };

    this.setupRoutes();
  }

  /**
   * Set up route handlers
   */
  private setupRoutes(): void {
    const context: RouteContext = {
      manifest: this.config.manifest,
      resolvers: this.config.resolvers,
      log: this.config.logger,
    };

    this.routes.set('GET /health', (req, res) => handleHealth(req, res, context));
    this.routes.set('GET /manifest', (req, res) => handleManifest(req, res, context));
    this.routes.set('POST /resolve', (req, res) => handleResolve(req, res, context));
  }

  /**
   * Register a custom route handler
   */
  public addRoute(method: string, path: string, handler: RouteHandler): void {
    const key = `${method.toUpperCase()} ${path}`;
    this.routes.set(key, handler);
    this.config.logger(`Registered route: ${key}`, 'debug');
  }

  /**
   * Register an impulse resolver
   */
  public addResolver(type: string, resolver: ImpulseResolver): void {
    this.config.resolvers.set(type, resolver);
    this.config.logger(`Registered resolver for impulse type: ${type}`, 'debug');
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set timeout for request
    req.setTimeout(this.config.timeout, () => {
      this.config.logger(`Request timeout: ${req.method} ${req.url}`, 'warn');
      sendError(res, 'Request timeout', 408);
      req.destroy();
    });

    try {
      // Handle CORS
      const corsHandled = handleCors(req, res, this.config.cors);
      if (corsHandled) {
        return;
      }

      // Parse URL
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method?.toUpperCase() || 'GET';

      // Find matching route
      const routeKey = `${method} ${pathname}`;
      const handler = this.routes.get(routeKey);

      if (handler) {
        this.config.logger(`${method} ${pathname}`, 'debug');
        await handler(req, res);
      } else {
        // Route not found
        this.config.logger(`Route not found: ${method} ${pathname}`, 'warn');
        sendJson(res, {
          error: 'Not found',
          path: pathname,
          method,
          availableRoutes: Array.from(this.routes.keys()),
        }, 404);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.config.logger(`Request error: ${message}`, 'error');

      if (!res.headersSent) {
        sendError(res, 'Internal server error', 500);
      }
    }
  }

  /**
   * Start the HTTP server
   */
  public async start(): Promise<void> {
    if (this.server) {
      throw new Error('Server is already running');
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          this.config.logger(`Unhandled request error: ${error}`, 'error');
          if (!res.headersSent) {
            sendError(res, 'Internal server error', 500);
          }
        });
      });

      // Handle server errors
      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          const msg = `Port ${this.config.port} is already in use`;
          this.config.logger(msg, 'error');
          reject(new Error(msg));
        } else if (error.code === 'EACCES') {
          const msg = `Permission denied to bind to port ${this.config.port}`;
          this.config.logger(msg, 'error');
          reject(new Error(msg));
        } else {
          this.config.logger(`Server error: ${error.message}`, 'error');
          reject(error);
        }
      });

      // Handle client errors (malformed requests)
      this.server.on('clientError', (error, socket) => {
        this.config.logger(`Client error: ${error.message}`, 'warn');
        if (socket.writable) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        }
      });

      // Start listening
      this.server.listen(this.config.port, this.config.host, () => {
        this.config.logger(
          `Server started at http://${this.config.host}:${this.config.port}`,
          'info'
        );
        this.config.logger('Available routes:', 'info');
        for (const route of this.routes.keys()) {
          this.config.logger(`  ${route}`, 'info');
        }
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server gracefully
   */
  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.config.logger('Shutting down server...', 'info');

    return new Promise((resolve, reject) => {
      // Set a timeout for graceful shutdown
      const forceShutdownTimeout = setTimeout(() => {
        this.config.logger('Forcing server shutdown after timeout', 'warn');
        this.server?.closeAllConnections?.();
        resolve();
      }, 5000);

      this.server!.close((error) => {
        clearTimeout(forceShutdownTimeout);
        this.server = null;
        this.isShuttingDown = false;

        if (error) {
          this.config.logger(`Error during shutdown: ${error.message}`, 'error');
          reject(error);
        } else {
          this.config.logger('Server stopped', 'info');
          resolve();
        }
      });
    });
  }

  /**
   * Check if server is running
   */
  public isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * Get server address
   */
  public getAddress(): { host: string; port: number } | null {
    if (!this.server) {
      return null;
    }
    const address = this.server.address();
    if (typeof address === 'string' || address === null) {
      return null;
    }
    return {
      host: address.address,
      port: address.port,
    };
  }

  /**
   * Get the configured port
   */
  public getPort(): number {
    return this.config.port;
  }

  /**
   * Get registered impulse types
   */
  public getRegisteredTypes(): string[] {
    return Array.from(this.config.resolvers.keys());
  }
}
