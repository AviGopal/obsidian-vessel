// obsidian:presence_rhythm — per-human presence + rhythm derived from the observed event log (scan wired next).
import { ObsidianEventLog } from './observation-types';
import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';
import { registerResolver } from './index';

interface Ctx { log: ObsidianEventLog | null }
const ctx: Ctx = { log: null };
export function setPresenceRhythmContext(log: ObsidianEventLog | null): void { ctx.log = log; }

interface PresenceRhythmPointer { type: string; presence_window_ms?: number }

async function resolvePresenceRhythm(pointer: ImpulsePointer, _app: App): Promise<ResolverResult> {
  const p = pointer as unknown as PresenceRhythmPointer;
  const windowMs = typeof p.presence_window_ms === 'number' ? p.presence_window_ms : 600000;
  return { content: JSON.stringify({ present: false, presence_window_ms: windowMs, scanned: false, note: 'rhythm scan not yet wired (skeleton)' }), metadata: { shape: 'obsidian:presence_rhythm', summary: 'presence skeleton' } };
}

registerResolver('obsidian:presence_rhythm', resolvePresenceRhythm);
