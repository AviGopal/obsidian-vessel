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
  if (!ctx.log) return { content: JSON.stringify({ present: false, presence_window_ms: windowMs, scanned: false, note: 'event log unavailable' }), metadata: { shape: 'obsidian:presence_rhythm', summary: 'presence unscored' } };
  const now = Date.now();
  const events = ctx.log.read({ limit: 10000 });
  let lastTs = 0;
  const hourHistogram: Record<string, number> = {};
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    if (t > lastTs) lastTs = t;
    const h = String(new Date(t).getUTCHours());
    hourHistogram[h] = (hourHistogram[h] ?? 0) + 1;
  }
  const present = lastTs > 0 && now - lastTs <= windowMs;
  const body = { present, last_event_at: lastTs > 0 ? new Date(lastTs).toISOString() : null, event_count: events.length, hour_histogram_utc: hourHistogram, presence_window_ms: windowMs, scanned: true };
  return { content: JSON.stringify(body), metadata: { shape: 'obsidian:presence_rhythm', summary: present ? 'present' : 'away' } };
}

registerResolver('obsidian:presence_rhythm', resolvePresenceRhythm);
