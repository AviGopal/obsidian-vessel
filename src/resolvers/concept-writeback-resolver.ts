/**
 * Resolver — `obsidian:concept_writeback`
 *
 * "Materialize a concept directly in the vault without going through
 * concept-db's REST surface from the caller's side." The caller
 * (typically another vessel) supplies the concept fields; this
 * resolver mints or updates the concept-db record and writes the
 * vault note via the shared concept-sync materializer.
 *
 * Both the ConceptDbClient and the ConceptSyncService are injected by
 * main.ts via `setConceptWritebackResolverContext`.
 */

import type { App } from 'obsidian';
import type {
  ImpulsePointer,
  ResolverResult,
  ObsidianConceptWritebackPointer,
} from './types';
import { registerResolver } from './index';
import type { ConceptDbClient } from '../concept-db-client';
import type { ConceptSyncService } from '../sync/concept-sync';

interface WritebackCtx {
  client: ConceptDbClient | null;
  sync: ConceptSyncService | null;
}

const ctx: WritebackCtx = { client: null, sync: null };

export function setConceptWritebackResolverContext(
  client: ConceptDbClient | null,
  sync: ConceptSyncService | null,
): void {
  ctx.client = client;
  ctx.sync = sync;
}

async function resolveConceptWriteback(
  pointer: ImpulsePointer,
  _app: App,
): Promise<ResolverResult> {
  const p = pointer as ObsidianConceptWritebackPointer;
  if (!ctx.client || !ctx.sync) {
    throw new Error(
      'concept-db frontend not initialized (enable in plugin settings)',
    );
  }

  // Resolve or mint the concept
  let conceptId = p.concept_id;
  let concept = conceptId ? await ctx.client.getConcept(conceptId) : null;

  if (!concept) {
    if (!p.create_if_missing) {
      throw new Error(`Concept not found and create_if_missing=false: ${conceptId}`);
    }
    concept = await ctx.client.createConcept({
      source_type: p.source_type,
      shape: p.shape,
      summary: p.summary,
      content: p.content,
    });
    conceptId = concept.id;
  }

  const wrote = await ctx.sync.materializeConcept(concept);
  return {
    content: JSON.stringify({
      concept_id: concept.id,
      materialized: wrote,
    }),
    metadata: {
      shape: concept.shape,
      summary: concept.summary,
      producedBy: 'concept-db',
    },
  };
}

registerResolver('obsidian:concept_writeback', resolveConceptWriteback);
