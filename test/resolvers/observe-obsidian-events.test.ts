/**
 * Tests for the Phase 1 observation layer — `observe-obsidian-events`.
 *
 * Focuses on the pure conversion path (raw Obsidian event → sanitised
 * `obsidianEvent` impulse). The workspace + vault subscription wiring
 * itself is exercised by the in-Obsidian probe vault per the openspec
 * acceptance criteria; here we verify the contract that determines
 * what crosses the bridge.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildObsidianEvent,
} from '../../src/resolvers/observe-obsidian-events';
import {
  ObsidianEventLog,
  sanitiseSyncRootRelativePath,
} from '../../src/resolvers/observation-types';
import { sha256Hex } from '../../src/resolvers/observation-hash';

describe('buildObsidianEvent', () => {
  test('produces sha256 payload_hash and never includes raw text', () => {
    const raw = { body: 'this is a 4KB editor change with sensitive text' };
    const event = buildObsidianEvent({
      kind: 'editor-change',
      rawPayload: raw,
    });
    expect(event.shape).toBe('obsidian:event_observed');
    expect(event.kind).toBe('editor-change');
    expect(event.payload_hash).toBe(sha256Hex(JSON.stringify(raw)));
    expect(event.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.bridge_eligibility).toBe('deny');
    expect((event as unknown as { text?: string }).text).toBeUndefined();
    expect((event as unknown as { body?: string }).body).toBeUndefined();
  });

  test('sets command_id only for command-executed events', () => {
    const cmd = buildObsidianEvent({
      kind: 'command-executed',
      rawPayload: { id: 'editor:toggle-bold' },
      commandId: 'editor:toggle-bold',
    });
    expect(cmd.command_id).toBe('editor:toggle-bold');

    const other = buildObsidianEvent({
      kind: 'active-leaf-change',
      rawPayload: {},
      commandId: 'editor:toggle-bold', // should be ignored for non-command kinds
    });
    expect(other.command_id).toBeUndefined();
  });

  test('attaches sync_root_relative_path only when the path is vault-relative', () => {
    const relative = buildObsidianEvent({
      kind: 'file-modify',
      rawPayload: {},
      path: 'Notes/2026/intro.md',
    });
    expect(relative.sync_root_relative_path).toBe('Notes/2026/intro.md');

    const absolute = buildObsidianEvent({
      kind: 'file-modify',
      rawPayload: {},
      path: '/home/avi/vault/Notes/2026/intro.md',
    });
    expect(absolute.sync_root_relative_path).toBeUndefined();

    const dotDot = buildObsidianEvent({
      kind: 'file-modify',
      rawPayload: {},
      path: '../escape.md',
    });
    expect(dotDot.sync_root_relative_path).toBeUndefined();
  });

  test('payload_hash is stable for identical payloads and differs for different ones', () => {
    const a = buildObsidianEvent({ kind: 'editor-change', rawPayload: { n: 1 } });
    const b = buildObsidianEvent({ kind: 'editor-change', rawPayload: { n: 1 } });
    const c = buildObsidianEvent({ kind: 'editor-change', rawPayload: { n: 2 } });
    expect(a.payload_hash).toBe(b.payload_hash);
    expect(a.payload_hash).not.toBe(c.payload_hash);
  });
});

describe('sanitiseSyncRootRelativePath', () => {
  test('rejects POSIX absolute paths', () => {
    expect(sanitiseSyncRootRelativePath('/etc/passwd')).toBeUndefined();
  });
  test('rejects Windows absolute paths', () => {
    expect(sanitiseSyncRootRelativePath('C:\\Users\\Avi\\notes')).toBeUndefined();
  });
  test('rejects parent-traversal paths', () => {
    expect(sanitiseSyncRootRelativePath('../../etc/passwd')).toBeUndefined();
    expect(sanitiseSyncRootRelativePath('a/../b')).toBeUndefined();
  });
  test('accepts vault-relative paths', () => {
    expect(sanitiseSyncRootRelativePath('Notes/x.md')).toBe('Notes/x.md');
  });
  test('returns undefined for empty input', () => {
    expect(sanitiseSyncRootRelativePath(undefined)).toBeUndefined();
    expect(sanitiseSyncRootRelativePath('')).toBeUndefined();
  });
});

describe('ObsidianEventLog', () => {
  test('appends and reads in chronological order', () => {
    const log = new ObsidianEventLog(100);
    log.append(buildObsidianEvent({ kind: 'editor-change', rawPayload: {}, timestamp: '2026-06-01T00:00:00.000Z' }));
    log.append(buildObsidianEvent({ kind: 'file-modify', rawPayload: {}, timestamp: '2026-06-01T00:00:01.000Z' }));
    expect(log.size()).toBe(2);
    const events = log.read();
    expect(events.map((e) => e.kind)).toEqual(['editor-change', 'file-modify']);
  });

  test('respects the cap by dropping the oldest entries', () => {
    const log = new ObsidianEventLog(3);
    for (let i = 0; i < 6; i++) {
      log.append(
        buildObsidianEvent({
          kind: 'editor-change',
          rawPayload: { i },
          timestamp: new Date(2026, 5, 1, 0, 0, i).toISOString(),
        }),
      );
    }
    expect(log.size()).toBe(3);
  });

  test('filters by sync_root_scope', () => {
    const log = new ObsidianEventLog();
    log.append(buildObsidianEvent({ kind: 'file-modify', rawPayload: {}, path: 'Inbox/a.md' }));
    log.append(buildObsidianEvent({ kind: 'file-modify', rawPayload: {}, path: 'Notes/b.md' }));
    log.append(buildObsidianEvent({ kind: 'file-modify', rawPayload: {}, path: 'Notes/c.md' }));
    const inbox = log.read({ sync_root_scope: 'Inbox/' });
    const notes = log.read({ sync_root_scope: 'Notes/' });
    expect(inbox).toHaveLength(1);
    expect(notes).toHaveLength(2);
  });
});
