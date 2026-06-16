/**
 * CORS Middleware for HTTP Server
 *
 * Handles Cross-Origin Resource Sharing (CORS) headers and preflight requests.
 * Supports wildcard matching for localhost development (e.g., 'http://localhost:*')
 */

import type { IncomingMessage, ServerResponse } from 'http';

export interface CorsOptions {
  /** Allowed origins (supports wildcards like 'http://localhost:*') */
  allowedOrigins: string[];
  /** Allowed HTTP methods */
  allowedMethods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Whether to allow credentials */
  credentials?: boolean;
  /** Max age for preflight cache (seconds) */
  maxAge?: number;
}

const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const DEFAULT_HEADERS = ['Content-Type', 'Authorization', 'Accept'];

/**
 * Check if an origin matches an allowed pattern
 * Supports wildcard '*' for port matching (e.g., 'http://localhost:*')
 */
function matchOrigin(origin: string, pattern: string): boolean {
  // Exact match
  if (pattern === origin) {
    return true;
  }

  // Wildcard match for all origins
  if (pattern === '*') {
    return true;
  }

  // Wildcard port matching (e.g., 'http://localhost:*')
  if (pattern.includes(':*')) {
    const patternBase = pattern.replace(':*', '');
    // Extract origin without port
    const originMatch = origin.match(/^(https?:\/\/[^:]+)/);
    if (originMatch && originMatch[1] === patternBase) {
      return true;
    }
    // Also match if origin has a port
    const originWithPortMatch = origin.match(/^(https?:\/\/[^:]+):\d+$/);
    if (originWithPortMatch && originWithPortMatch[1] === patternBase) {
      return true;
    }
  }

  return false;
}

/**
 * Check if request origin is allowed
 */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    // No origin header (same-origin request or non-browser client)
    return true;
  }

  return allowedOrigins.some(pattern => matchOrigin(origin, pattern));
}

/**
 * Set CORS headers on response
 */
export function setCorsHeaders(
  res: ServerResponse,
  origin: string | undefined,
  options: CorsOptions
): void {
  const {
    allowedOrigins,
    allowedMethods = DEFAULT_METHODS,
    allowedHeaders = DEFAULT_HEADERS,
    credentials = false,
    maxAge = 86400,
  } = options;

  // Determine the origin to return
  let allowOrigin = '';
  if (allowedOrigins.includes('*')) {
    allowOrigin = '*';
  } else if (origin && isOriginAllowed(origin, allowedOrigins)) {
    allowOrigin = origin;
  }

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  }

  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', allowedHeaders.join(', '));

  if (credentials && allowOrigin !== '*') {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Max-Age', maxAge.toString());
}

/**
 * Handle CORS for a request
 * Returns true if this was a preflight request that was handled
 */
export function handleCors(
  req: IncomingMessage,
  res: ServerResponse,
  options: CorsOptions
): boolean {
  const origin = req.headers.origin;

  // Check if origin is allowed
  if (!isOriginAllowed(origin, options.allowedOrigins)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return true;
  }

  // Set CORS headers for all requests
  setCorsHeaders(res, origin, options);

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}

/**
 * Create CORS middleware function
 */
export function createCorsMiddleware(options: CorsOptions) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    return handleCors(req, res, options);
  };
}
