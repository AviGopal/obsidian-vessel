/**
 * Obsidian Vessel Impulse Resolver Registry
 *
 * This module provides a registry for impulse resolvers and the main
 * resolve function used to load impulse content from Obsidian.
 */
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverFunction, ResolverResult } from './types';

// Import and register all resolvers
import { resolveNote } from './note-resolver';
import { resolveSearch } from './search-resolver';
import { resolveCanvas } from './canvas-resolver';
import { resolveBacklinks } from './backlinks-resolver';
import { resolveFrontmatter } from './frontmatter-resolver';
import { resolveDailyNote } from './daily-note-resolver';
import { resolveGraphQuery } from './graph-resolver';

// =============================================================================
// RESOLVER REGISTRY
// =============================================================================

/**
 * Registry mapping pointer types to resolver functions
 */
const resolvers = new Map<string, ResolverFunction>();

/**
 * Register a resolver for an impulse pointer type
 */
export function registerResolver(type: string, resolver: ResolverFunction): void {
  resolvers.set(type, resolver);
}

/**
 * Get a resolver for a pointer type
 */
export function getResolver(type: string): ResolverFunction | undefined {
  return resolvers.get(type);
}

/**
 * Check if a resolver exists for a type
 */
export function hasResolver(type: string): boolean {
  return resolvers.has(type);
}

/**
 * List all registered resolver types
 */
export function listResolverTypes(): string[] {
  return Array.from(resolvers.keys());
}

/**
 * Resolve an impulse pointer to its content
 *
 * @param pointer - The impulse pointer to resolve
 * @param app - The Obsidian App instance
 * @returns Resolved content with optional metadata
 * @throws Error if no resolver is registered for the pointer type
 */
export async function resolve(pointer: ImpulsePointer, app: App): Promise<ResolverResult> {
  const resolver = resolvers.get(pointer.type);

  if (!resolver) {
    throw new Error(`No resolver for impulse type: ${pointer.type}`);
  }

  return resolver(pointer, app);
}

/**
 * Resolve multiple pointers in parallel
 *
 * @param pointers - Array of impulse pointers to resolve
 * @param app - The Obsidian App instance
 * @returns Array of resolved results
 */
export async function resolveAll(
  pointers: ImpulsePointer[],
  app: App
): Promise<ResolverResult[]> {
  return Promise.all(pointers.map((p) => resolve(p, app)));
}

/**
 * Check if this vessel can resolve a pointer type
 */
export function canResolve(pointer: ImpulsePointer): boolean {
  return hasResolver(pointer.type);
}

// =============================================================================
// REGISTER BUILT-IN RESOLVERS
// =============================================================================

// Note resolver - obsidian:note
registerResolver('obsidian:note', resolveNote);

// Search resolver - obsidian:search
registerResolver('obsidian:search', resolveSearch);

// Canvas resolver - obsidian:canvas
registerResolver('obsidian:canvas', resolveCanvas);

// Backlinks resolver - obsidian:backlinks
registerResolver('obsidian:backlinks', resolveBacklinks);

// Frontmatter resolver - obsidian:frontmatter
registerResolver('obsidian:frontmatter', resolveFrontmatter);

// Daily note resolver - obsidian:daily_note
registerResolver('obsidian:daily_note', resolveDailyNote);

// Graph query resolver - obsidian:graph_query
registerResolver('obsidian:graph_query', resolveGraphQuery);

// Phase 1 observation resolvers (`obsidian:event_observed`,
// `obsidian:interaction_episode`, `obsidian:action_effect_model`) are
// loaded by main.ts via side-effect imports — they cannot self-register
// from this file because doing so would create a circular import (the
// resolver modules import `registerResolver` from here, so loading
// them here before the Map is initialized would trip TDZ).

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type {
  ImpulsePointer,
  ResolverFunction,
  ResolverResult,
  ImpulseMetadata,
  ObsidianNotePointer,
  ObsidianSearchPointer,
  ObsidianCanvasPointer,
  ObsidianBacklinksPointer,
  ObsidianFrontmatterPointer,
  ObsidianDailyNotePointer,
  ObsidianGraphQueryPointer,
  NoteContent,
  SearchResult,
  BacklinkEntry,
  FrontmatterEntry,
  GraphNode,
  GraphEdge,
  GraphResult,
} from './types';
