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
import { resolveListNotes } from './list-notes-resolver';
import { resolveCanvas } from './canvas-resolver';
import { resolveUiScreenshot } from './ui-screenshot-resolver';
import { resolveUiLayoutMetrics } from './ui-layout-metrics-resolver';
import { resolveBacklinks } from './backlinks-resolver';
import { resolveFrontmatter } from './frontmatter-resolver';
import { resolveDailyNote } from './daily-note-resolver';
import { resolveGraphQuery } from './graph-resolver';
import { resolveCommandCatalog } from './command-catalog';
import { resolveCapabilityCatalog } from './capability-catalog';

// =============================================================================
// RESOLVER REGISTRY
// =============================================================================

/**
 * Registry mapping pointer types to resolver functions.
 *
 * Lazily initialized inside registry() rather than a top-level
 * `const resolvers = new Map()`: resolver modules sometimes self-register at
 * module top level, and if such a module ends up in an import cycle with this
 * one, the hoisted registerResolver() runs BEFORE this module's initializers —
 * a top-level Map would still be undefined and `.set` would crash plugin load
 * (exactly the 0.5.0 host-vault failure). The lazy guard makes registration
 * safe regardless of module-evaluation order.
 */
let resolvers: Map<string, ResolverFunction> | undefined;

function registry(): Map<string, ResolverFunction> {
  if (!resolvers) resolvers = new Map<string, ResolverFunction>();
  return resolvers;
}

/**
 * Register a resolver for an impulse pointer type
 */
export function registerResolver(type: string, resolver: ResolverFunction): void {
  registry().set(type, resolver);
}

/**
 * Get a resolver for a pointer type
 */
export function getResolver(type: string): ResolverFunction | undefined {
  return registry().get(type);
}

/**
 * Check if a resolver exists for a type
 */
export function hasResolver(type: string): boolean {
  return registry().has(type);
}

/**
 * List all registered resolver types
 */
export function listResolverTypes(): string[] {
  return Array.from(registry().keys());
}

/**
 * Substrate-proxy fallback: when no LOCAL resolver owns a shape, forward the pointer to
 * the substrate so the plugin can resolve ANY substrate shape (system-managed resolvers) —
 * a window into the whole fleet, not just the vault's built-in shapes. Wired by main.ts
 * from the configured substrate endpoint + key; unset (null) → unknown shapes throw as before.
 */
type SubstrateProxy = (pointer: ImpulsePointer) => Promise<ResolverResult | null>;
let substrateProxy: SubstrateProxy | null = null;
export function setSubstrateProxy(fn: SubstrateProxy | null): void {
  substrateProxy = fn;
}

/**
 * Resolve an impulse pointer to its content
 *
 * @param pointer - The impulse pointer to resolve
 * @param app - The Obsidian App instance
 * @returns Resolved content with optional metadata
 * @throws Error if no resolver is registered AND no substrate proxy resolves it
 */
export async function resolve(pointer: ImpulsePointer, app: App): Promise<ResolverResult> {
  const resolver = registry().get(pointer.type);

  if (!resolver) {
    // System-managed fallback: let the substrate resolve shapes this vault doesn't own.
    if (substrateProxy) {
      const proxied = await substrateProxy(pointer);
      if (proxied) return proxied;
    }
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
registerResolver('obsidian:list_notes', resolveListNotes);

// Canvas resolver - obsidian:canvas
registerResolver('obsidian:canvas', resolveCanvas);
registerResolver('obsidian:ui_screenshot', resolveUiScreenshot);
registerResolver('obsidian:ui_layout_metrics', resolveUiLayoutMetrics);

// Backlinks resolver - obsidian:backlinks
registerResolver('obsidian:backlinks', resolveBacklinks);

// Frontmatter resolver - obsidian:frontmatter
registerResolver('obsidian:frontmatter', resolveFrontmatter);

// Daily note resolver - obsidian:daily_note
registerResolver('obsidian:daily_note', resolveDailyNote);

// Graph query resolver - obsidian:graph_query
registerResolver('obsidian:graph_query', resolveGraphQuery);

// Capability catalog resolvers - obsidian:command_catalog, obsidian:capability_catalog
registerResolver('obsidian:command_catalog', resolveCommandCatalog);
registerResolver('obsidian:capability_catalog', resolveCapabilityCatalog);

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
