/**
 * Resolver — `obsidian:concept_view`
 *
 * "Give me the vault-rendered version of concept X." Returns the
 * markdown body of the concept's vault note (if one exists), otherwise
 * fetches the concept from concept-db and renders it on the fly via
 * the same formatter.
 *
 * The shared ConceptDbClient is injected by main.ts via
 * `setConceptDbResolverContext`.
 */

import type { App, TFile } from 'obsidian';
import type {
  ImpulsePointer,
  ResolverResult,
  ObsidianConceptViewPointer,
} from './types';
import { registerResolver } from './index';
import type { ConceptDbClient } from '../concept-db-client';
import { shortConceptId } from '../concept-db-client';
import {
  conceptNotePath,
  renderConceptNote,
} from '../formatters/concept-formatter';
import type { MetabobVesselSettings } from '../settings';

interface ResolverCtx {
  client: ConceptDbClient | null;
  settings: MetabobVesselSettings | null;
}

const ctx: ResolverCtx = { client: null, settings: null };

/**
 * main.ts calls this after constructing the ConceptDbClient. The
 * resolvers fail gracefully (clear error) when the context is unset.
 */
export function setConceptDbResolverContext(
  client: ConceptDbClient | null,
  settings: MetabobVesselSettings | null,
): void {
  ctx.client = client;
  ctx.settings = settings;
}

async function resolveConceptView(
  pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const p = pointer as ObsidianConceptViewPointer;
  if (!p.concept_id) {
    throw new Error('obsidian:concept_view requires a concept_id');
  }
  if (!ctx.client || !ctx.settings) {
    throw new Error(
      'concept-db frontend not initialized (enable in plugin settings)',
    );
  }

  // First try the vault note (fastest path; reflects any operator edits)
  const concept = await ctx.client.getConcept(p.concept_id);
  if (!concept) throw new Error(`Concept not found: ${p.concept_id}`);

  const notePath = conceptNotePath(concept, ctx.settings.conceptDbSyncRoot);
  const file = app.vault.getAbstractFileByPath(notePath);
  if (file && 'extension' in file) {
    const content = await app.vault.read(file as TFile);
    return {
      content,
      metadata: {
        shape: concept.shape,
        summary: concept.summary,
        producedBy: 'concept-db',
      },
    };
  }

  // Vault note doesn't exist (sync may be disabled or behind); render
  // fresh from concept-db.
  const include = p.include_neighbors !== false;
  const neighbors = include
    ? await ctx.client.getNeighbors(concept.id).catch(() => [])
    : [];
  const rendered = renderConceptNote(concept, neighbors);
  return {
    content: rendered,
    metadata: {
      shape: concept.shape,
      summary: concept.summary,
      producedBy: 'concept-db',
    },
  };
}

registerResolver('obsidian:concept_view', resolveConceptView);
