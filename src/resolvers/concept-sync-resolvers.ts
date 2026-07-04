/**
 * Concept-sync resolvers — expose the concept-sync capabilities as
 * discovery-advertised impulse shapes instead of bespoke HTTP routes.
 *
 * Folds the route-only capabilities POST /actions/sync, POST /actions/rebuild,
 * and GET /observations/concept-status (src/main.ts) into the impulse contract:
 *
 *   - obsidian:concept_sync     (sync):    pull all concept notes from concept-db.
 *   - obsidian:concept_rebuild  (rebuild): clear timestamps and re-materialise
 *                                          every concept note.
 *   - obsidian:concept_status   (observe): aggregate stats over the concept-db
 *                                          sync root (edges, signal, relevance).
 *
 * Resolvers receive `(pointer, app)`; the plugin instance (for `conceptSync`
 * and `settings`) is reached via `app.plugins.plugins['obsidian-vessel']` so no
 * plugin-instance context parameter is needed (same trick as the reload_plugin
 * and dispatch_goal resolvers in workspace-resolvers.ts).
 */

import type { App } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';

interface ConceptSyncPluginSurface {
  conceptSync?: {
    pullAll: () => Promise<number>;
    forceRebuild: (app: App) => Promise<{ rebuilt: number }>;
  };
  settings?: { conceptDbSyncRoot?: string };
}

function getVesselPlugin(app: App): ConceptSyncPluginSurface | undefined {
  return (app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
    .plugins?.plugins?.['obsidian-vessel'] as ConceptSyncPluginSurface | undefined;
}

/** obsidian:concept_sync — pull all concept notes (mirrors POST /actions/sync). */
export async function resolveConceptSync(
  _pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const plugin = getVesselPlugin(app);
  if (!plugin?.conceptSync) {
    throw new Error('Concept sync not enabled');
  }
  const synced = await plugin.conceptSync.pullAll();
  return {
    content: JSON.stringify({ synced }),
    metadata: {
      shape: 'obsidian:concept_sync',
      summary: `Synced ${synced} concept notes`,
      availableOps: ['sync'],
      synced,
    },
  };
}

/** obsidian:concept_rebuild — force rebuild (mirrors POST /actions/rebuild). */
export async function resolveConceptRebuild(
  _pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const plugin = getVesselPlugin(app);
  if (!plugin?.conceptSync) {
    throw new Error('Concept sync not enabled');
  }
  const result = await plugin.conceptSync.forceRebuild(app);
  return {
    content: JSON.stringify({ rebuilt: result.rebuilt }),
    metadata: {
      shape: 'obsidian:concept_rebuild',
      summary: `Rebuilt ${result.rebuilt} concept notes`,
      availableOps: ['rebuild'],
      rebuilt: result.rebuilt,
    },
  };
}

/**
 * obsidian:concept_status — aggregate stats over the concept-db sync root
 * (mirrors GET /observations/concept-status).
 */
export async function resolveConceptStatus(
  _pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const plugin = getVesselPlugin(app);
  const syncRoot = plugin?.settings?.conceptDbSyncRoot || 'concept-db';
  const prefix = syncRoot + '/';
  const conceptFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));

  let totalNotes = 0;
  let notesWithEdges = 0;
  let notesWithSignal = 0;
  let relevanceSum = 0;
  let relevanceCount = 0;
  let familyNotes = 0;
  let vesselNotes = 0;
  let lowestRelevance: { path: string; relevance: number } | null = null;

  for (const file of conceptFiles) {
    totalNotes++;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;

    if (fm.edges && typeof fm.edges === 'object' && Object.keys(fm.edges).length > 0) {
      notesWithEdges++;
    }
    if (typeof fm.loaded === 'number' && fm.loaded > 0) {
      notesWithSignal++;
    }
    if (typeof fm.relevance === 'number') {
      relevanceSum += fm.relevance;
      relevanceCount++;
      if (lowestRelevance === null || fm.relevance < lowestRelevance.relevance) {
        lowestRelevance = { path: file.path, relevance: fm.relevance };
      }
    }
    if (fm.source_type === 'activity_family') familyNotes++;
    if (fm.source_type === 'vessel') vesselNotes++;
  }

  const stats = {
    syncRoot,
    totalNotes,
    notesWithEdges,
    notesWithSignal,
    averageRelevance: relevanceCount > 0 ? relevanceSum / relevanceCount : null,
    lowestRelevance,
    familyNotes,
    vesselNotes,
  };
  return {
    content: JSON.stringify(stats),
    metadata: {
      shape: 'obsidian:concept_status',
      summary: `${totalNotes} concept notes, ${notesWithEdges} with edges, ${notesWithSignal} with signal`,
      availableOps: ['observe'],
      ...stats,
    },
  };
}

registerResolver('obsidian:concept_sync', resolveConceptSync);
registerResolver('obsidian:concept_rebuild', resolveConceptRebuild);
registerResolver('obsidian:concept_status', resolveConceptStatus);
