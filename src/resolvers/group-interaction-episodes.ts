/**
 * Resolver — `obsidian:interaction_episode` (Phase 1, Layer 1).
 *
 * Windows recent `obsidianEvent` impulses (held in the shared in-memory
 * event log) into one or more `obsidianEpisode` impulses. The windowing
 * rule is the inactivity-gap form: events whose adjacent time gap
 * exceeds `window_ms` start a new episode. Episodes carrying fewer
 * than two events are considered trivial and are dropped (single
 * isolated events convey no interaction grouping signal).
 *
 * The `sorted_unique_class_signature` is the sorted, deduplicated set
 * of tokens of the form `<kind>` for non-command events and
 * `command-executed:<command_id>` for command events — chosen so two
 * episodes that fire the same commands in any order share a signature.
 *
 * Spec:
 *   openspec/changes/2026-06-01-obsidian-observe-and-experiment/
 *     specs/obsidian-observation-layer/spec.md
 *     §"obsidianEpisode impulse shape contract"
 *     §"group-interaction-episodes activity contract"
 */

import type { App } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';
import {
  ObsidianEpisode,
  ObsidianEpisodeQueryPointer,
  ObsidianEvent,
  ObsidianEventLog,
  makeId,
} from './observation-types';

interface Ctx {
  log: ObsidianEventLog | null;
}
const ctx: Ctx = { log: null };

export function setGroupInteractionEpisodesContext(log: ObsidianEventLog | null): void {
  ctx.log = log;
}

const DEFAULT_WINDOW_MS = 30_000;

/**
 * Pure windowing logic. Exported for unit tests; takes a fully-formed
 * event list and produces episodes. Events are assumed chronological.
 */
export function groupEvents(
  events: ObsidianEvent[],
  windowMs: number,
  syncRootScope?: string,
): ObsidianEpisode[] {
  const scope = syncRootScope ?? '';
  if (events.length === 0) return [];

  const episodes: ObsidianEpisode[] = [];
  let bucket: ObsidianEvent[] = [];
  let lastTs = Date.parse(events[0].timestamp);

  const flush = () => {
    if (bucket.length < 2) {
      // Trivial clusters are dropped — the spec emits one episode per
      // non-trivial cluster.
      bucket = [];
      return;
    }
    const signature = signatureFor(bucket);
    const episode: ObsidianEpisode = {
      shape: 'obsidian:interaction_episode',
      episode_id: makeId('epi'),
      event_ids: bucket.map((e) => e.event_id),
      sorted_unique_class_signature: signature,
      window_start: bucket[0].timestamp,
      window_end: bucket[bucket.length - 1].timestamp,
      sync_root_scope: scope,
      bridge_eligibility: 'allow',
    };
    episodes.push(episode);
    bucket = [];
  };

  for (const e of events) {
    const ts = Date.parse(e.timestamp);
    if (bucket.length > 0 && ts - lastTs > windowMs) {
      flush();
    }
    bucket.push(e);
    lastTs = ts;
  }
  flush();
  return episodes;
}

/**
 * Build the sorted-unique class signature for a bucket of events.
 * Exported for the unit tests. The signature SHALL be sorted in
 * lexicographic ASCII order and SHALL contain no duplicates.
 */
export function signatureFor(events: ObsidianEvent[]): string[] {
  const set = new Set<string>();
  for (const e of events) {
    if (e.kind === 'command-executed' && e.command_id) {
      set.add(`${e.kind}:${e.command_id}`);
    } else {
      set.add(e.kind);
    }
  }
  return Array.from(set).sort();
}

async function resolveGroupEpisodes(
  pointer: ImpulsePointer,
  _app: App,
): Promise<ResolverResult> {
  const p = pointer as unknown as ObsidianEpisodeQueryPointer;
  if (!ctx.log) {
    throw new Error('group-interaction-episodes: event log not initialized');
  }
  const windowMs = Math.max(1, p.window_ms ?? DEFAULT_WINDOW_MS);
  const events = ctx.log.read({ sync_root_scope: p.sync_root_scope });
  const episodes = groupEvents(events, windowMs, p.sync_root_scope);
  return {
    content: JSON.stringify({ episodes }, null, 2),
    metadata: {
      shape: 'obsidian:interaction_episode',
      summary: `${episodes.length} episode(s) over ${events.length} event(s) @ ${windowMs}ms window`,
      rowCount: episodes.length,
      availableOps: ['probe'],
    },
  };
}

registerResolver('obsidian:interaction_episode', resolveGroupEpisodes);
