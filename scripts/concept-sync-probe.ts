/**
 * Standalone probe — exercises concept-db-client + concept-sync +
 * formatter against the live concept-db on port 18260, writing
 * materialized notes to a temp directory using the FS NoteWriter.
 *
 * Run with: bun scripts/concept-sync-probe.ts
 *
 * Used for offline (no-Obsidian) verification of the Phase 1 pipeline
 * during development. Not shipped in the plugin bundle.
 */
import { ConceptDbClient } from '../src/concept-db-client';
import {
  ConceptSyncService,
  makeFsNoteWriter,
} from '../src/sync/concept-sync';
import { DEFAULT_SETTINGS, type MetabobVesselSettings } from '../src/settings';
import { renderConceptNote } from '../src/formatters/concept-formatter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ROOT = path.join(os.tmpdir(), 'concept-vault-probe');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const apiKey = process.env.METABOB_API_KEY ?? '';
if (!apiKey) {
  console.warn(
    '[probe] METABOB_API_KEY not set — concept-db reads will fall into org_id="default" ' +
    '(empty / fixture-only). Substrate concepts are scoped to organizations:substrate. ' +
    'Set the key in env before running this probe. See concept_pL2ZFsPkzZz7.',
  );
}

const settings: MetabobVesselSettings = {
  ...DEFAULT_SETTINGS,
  enableConceptDbSync: true,
  conceptDbEndpoint: 'http://127.0.0.1:18260',
  conceptDbApiKey: apiKey,
  conceptDbSyncRoot: 'concept-db',
  conceptDbSyncIntervalSec: 3600,
  conceptDbSyncSourceTypes: [],
};

const client = new ConceptDbClient(settings.conceptDbEndpoint, apiKey);
const writer = makeFsNoteWriter(ROOT);
const sync = new ConceptSyncService(settings, client, writer);

console.log('--- pull #1');
const n1 = await sync.pullAll();
console.log('pull #1 wrote', n1, 'notes');

console.log('--- listing tree');
function walk(dir: string, depth = 0): void {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    console.log('  '.repeat(depth) + entry + (st.isDirectory() ? '/' : ''));
    if (st.isDirectory()) walk(p, depth + 1);
  }
}
walk(ROOT);

console.log('--- sample note (first .md)');
function findFirstMd(dir: string): string | null {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const found = findFirstMd(p);
      if (found) return found;
    } else if (entry.endsWith('.md')) {
      return p;
    }
  }
  return null;
}
const first = findFirstMd(ROOT);
if (first) {
  console.log('PATH:', first);
  console.log(fs.readFileSync(first, 'utf8'));
} else {
  console.log('(no notes materialized)');
}

console.log('--- pull #2 (idempotency check; should write 0)');
const n2 = await sync.pullAll();
console.log('pull #2 wrote', n2, 'notes');

console.log('--- formatter unit check (synthetic concept w/ neighbors)');
const out = renderConceptNote(
  {
    id: 'concept:ABC123',
    shape: 'vessel_resolve_handler_dual_form',
    source_type: 'vessel_construction_pattern',
    summary: 'Vessel /resolve handlers must accept impulse-wrapper format.',
    content: '# Body\n\nThe rule: ...',
    relevance: 0.7,
    times_loaded: 0,
    times_succeeded: 0,
    times_failed: 0,
    updated_at: '2026-05-30T07:13:22Z',
  },
  [
    {
      id: 'concept:ob81MJDNgNZL',
      edge_type: 'derived_from',
      summary: "Elaborates Core Model's impulses primitive.",
    },
    {
      id: 'concept:IsGiRuTMb-N0',
      edge_type: 'description_of',
      summary: 'MCP tools dispatch through /resolve.',
    },
  ],
);
console.log(out);
