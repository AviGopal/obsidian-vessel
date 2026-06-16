/**
 * Tests for `group-interaction-episodes` — the windowing resolver.
 *
 * Validates:
 *   - non-trivial clusters emit one episode each;
 *   - the signature is sorted + deduplicated;
 *   - command-executed tokens carry the command_id;
 *   - clusters of one event are dropped.
 */

import { describe, expect, test } from 'bun:test';
import {
  groupEvents,
  signatureFor,
} from '../../src/resolvers/group-interaction-episodes';
import { buildObsidianEvent } from '../../src/resolvers/observe-obsidian-events';
import type { ObsidianEvent } from '../../src/resolvers/observation-types';

function evt(
  kind: ObsidianEvent['kind'],
  iso: string,
  opts: { command_id?: string; path?: string } = {},
): ObsidianEvent {
  return buildObsidianEvent({
    kind,
    rawPayload: { kind, iso },
    timestamp: iso,
    commandId: opts.command_id,
    path: opts.path,
  });
}

describe('signatureFor', () => {
  test('produces a sorted, deduplicated set of tokens', () => {
    const events = [
      evt('editor-change', '2026-06-01T00:00:00.000Z'),
      evt('editor-change', '2026-06-01T00:00:01.000Z'),
      evt('file-modify', '2026-06-01T00:00:02.000Z'),
      evt('command-executed', '2026-06-01T00:00:03.000Z', { command_id: 'editor:toggle-bold' }),
      evt('command-executed', '2026-06-01T00:00:04.000Z', { command_id: 'editor:toggle-bold' }),
    ];
    const sig = signatureFor(events);
    expect(sig).toEqual([
      'command-executed:editor:toggle-bold',
      'editor-change',
      'file-modify',
    ]);
    // Sorted ascending.
    const sorted = [...sig].sort();
    expect(sig).toEqual(sorted);
    // Deduplicated.
    expect(new Set(sig).size).toBe(sig.length);
  });
});

describe('groupEvents', () => {
  test('produces 2 episodes from 12 events spanning two idle gaps', () => {
    // Cluster A: 6 events @ t=0..5s, then 60s gap, Cluster B: 6 events.
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    const events: ObsidianEvent[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(evt('editor-change', new Date(base + i * 1000).toISOString()));
    }
    for (let i = 0; i < 6; i++) {
      events.push(
        evt('file-modify', new Date(base + 60_000 + i * 1000).toISOString(), {
          path: `Notes/${i}.md`,
        }),
      );
    }
    const episodes = groupEvents(events, /* window_ms */ 30_000);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].event_ids).toHaveLength(6);
    expect(episodes[1].event_ids).toHaveLength(6);
    // event_ids must be ordered chronologically.
    const firstTs = episodes[0].event_ids.map((id) => events.find((e) => e.event_id === id)!.timestamp);
    expect(firstTs).toEqual([...firstTs].sort());
    // window_end is the timestamp of the last event in the bucket.
    expect(episodes[0].window_end).toBe(events[5].timestamp);
    expect(episodes[1].window_start).toBe(events[6].timestamp);
    expect(episodes[0].bridge_eligibility).toBe('allow');
  });

  test('drops single-event clusters', () => {
    const e1 = evt('editor-change', '2026-06-01T00:00:00.000Z');
    const e2 = evt('editor-change', '2026-06-01T00:05:00.000Z'); // 5 min gap
    const episodes = groupEvents([e1, e2], 30_000);
    expect(episodes).toHaveLength(0);
  });

  test('returns no episodes for empty input', () => {
    expect(groupEvents([], 30_000)).toEqual([]);
  });

  test('propagates sync_root_scope through to the episode', () => {
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    const events = [
      evt('file-modify', new Date(base).toISOString(), { path: 'Notes/a.md' }),
      evt('file-modify', new Date(base + 1000).toISOString(), { path: 'Notes/b.md' }),
    ];
    const eps = groupEvents(events, 30_000, 'Notes/');
    expect(eps[0].sync_root_scope).toBe('Notes/');
  });
});
