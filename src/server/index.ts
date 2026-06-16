/**
 * HTTP Server Module for Obsidian Vessel
 *
 * Provides HTTP server for impulse resolution and vessel discovery.
 */

export { HTTPServer, type HTTPServerConfig } from './http-server';
export { handleCors, createCorsMiddleware, isOriginAllowed, type CorsOptions } from './cors';
export {
  parseJsonBody,
  sendJson,
  sendError,
  handleHealth,
  handleManifest,
  handleResolve,
  createRouteHandlers,
  type RouteContext,
  type VesselManifest,
  type ResolveRequest,
  type ResolveResult,
  type ImpulseResolver,
} from './routes';
