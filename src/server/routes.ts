/**
 * Route Handlers for Obsidian Vessel HTTP Server
 *
 * Provides handlers for health check, manifest, and impulse resolution endpoints.
 * Integrates with the existing Obsidian impulse resolver system.
 */

import type { IncomingMessage, ServerResponse } from 'http';

/** Vessel manifest structure (matches vessel.json schema) */
export interface VesselManifest {
  vesselId: string;
  vesselName: string;
  version: string;
  shapes?: string[];
  capabilities?: Array<{
    type: string;
    shapes?: string[];
    port?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Impulse resolution request body */
export interface ResolveRequest {
  /** Impulse type (e.g., 'obsidian:note', 'obsidian:search') */
  type: string;
  /** Pointer data specific to the type */
  pointer: Record<string, unknown>;
  /** Optional resolution options */
  options?: Record<string, unknown>;
}

/** Impulse resolution result */
export interface ResolveResult {
  success: boolean;
  content?: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

/**
 * Resolver function type
 *
 * This is a wrapper type that adapts HTTP requests to the internal resolver system.
 * The actual Obsidian resolvers use (ImpulsePointer, App) signature, but this HTTP
 * wrapper provides a simplified interface for external callers.
 */
export type ImpulseResolver = (
  pointer: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<ResolveResult>;

/** Route handler context */
export interface RouteContext {
  /** Vessel manifest */
  manifest: VesselManifest;
  /** Map of impulse type to HTTP resolver wrapper function */
  resolvers: Map<string, ImpulseResolver>;
  /** Logger function */
  log: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

/**
 * Parse JSON request body
 */
export async function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (!body.trim()) {
          reject(new Error('Empty request body'));
          return;
        }
        const parsed = JSON.parse(body);
        resolve(parsed as T);
      } catch (error) {
        reject(new Error('Invalid JSON in request body'));
      }
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Send JSON response
 */
export function sendJson(
  res: ServerResponse,
  data: unknown,
  status: number = 200
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

/**
 * Send error response
 */
export function sendError(
  res: ServerResponse,
  message: string,
  status: number = 500
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: message,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Handle GET /health endpoint
 * Returns vessel health status
 */
export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  _context: RouteContext
): void {
  sendJson(res, {
    status: 'ok',
    vessel: 'obsidian-vessel',
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle GET /manifest endpoint
 * Returns the vessel manifest
 */
export function handleManifest(
  _req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext
): void {
  sendJson(res, context.manifest);
}

/**
 * Handle POST /resolve endpoint
 * Routes impulse resolution to type-specific resolver
 */
export async function handleResolve(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext
): Promise<void> {
  try {
    // Parse request body
    const rawBody = await parseJsonBody<ResolveRequest & {
      impulse?: { pointer?: { type?: string; [k: string]: unknown }; options?: unknown };
    }>(req);

    // Accept both forms (vessel_resolve_handler_dual_form, concept_y-CPpfVcAhL0):
    //   flat:    { type, pointer, options? }
    //   wrapped: { impulse: { pointer: { type, ... }, options? } }  ← compliant impulse-contract
    const wrappedPointer = rawBody?.impulse?.pointer;
    const body: ResolveRequest = wrappedPointer
      ? {
          type: rawBody.type ?? wrappedPointer.type ?? '',
          pointer: { ...(wrappedPointer as Record<string, unknown>) },
          options: (rawBody.options ?? rawBody.impulse?.options) as ResolveRequest['options'],
        }
      : rawBody;

    // Validate request
    if (!body.type) {
      sendError(res, 'Missing required field: type', 400);
      return;
    }

    if (!body.pointer) {
      sendError(res, 'Missing required field: pointer', 400);
      return;
    }

    // Find resolver for this impulse type
    const resolver = context.resolvers.get(body.type);

    if (!resolver) {
      context.log(`No resolver found for impulse type: ${body.type}`, 'warn');
      sendError(res, `Unsupported impulse type: ${body.type}`, 400);
      return;
    }

    // Execute resolution
    context.log(`Resolving impulse type: ${body.type}`, 'debug');
    const result = await resolver(body.pointer, body.options);

    if (result.success) {
      sendJson(res, {
        success: true,
        content: result.content,
        metadata: result.metadata,
      });
    } else {
      sendJson(res, {
        success: false,
        error: result.error || 'Resolution failed',
      }, 422);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    context.log(`Resolution error: ${message}`, 'error');

    if (message.includes('Invalid JSON') || message.includes('Empty request')) {
      sendError(res, message, 400);
    } else if (message.includes('too large')) {
      sendError(res, message, 413);
    } else {
      sendError(res, message, 500);
    }
  }
}

/**
 * Create a route handler map
 */
export function createRouteHandlers(context: RouteContext) {
  return {
    'GET /health': (req: IncomingMessage, res: ServerResponse) =>
      handleHealth(req, res, context),
    'GET /manifest': (req: IncomingMessage, res: ServerResponse) =>
      handleManifest(req, res, context),
    'POST /resolve': (req: IncomingMessage, res: ServerResponse) =>
      handleResolve(req, res, context),
  };
}
