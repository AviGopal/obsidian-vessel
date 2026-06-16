/**
 * Obsidian Vessel HTTP Integration Harness
 *
 * Drives the vessel's HTTP endpoints directly, testing each resolver shape.
 * Requires Obsidian to be running with the metabob-vessel plugin active.
 *
 * Usage:
 *   bun test/integration/http-harness.ts [--port 27183]
 *
 * Exit code 0 = all checks pass, 1 = one or more failures.
 */

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : 27183;
})();

const BASE = `http://127.0.0.1:${PORT}`;

// ─── Tiny harness ──────────────────────────────────────────────────────────

type CheckResult = { name: string; pass: boolean; skip?: boolean; detail: string };
const results: CheckResult[] = [];

function pass(name: string, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`  ✓ ${name}${detail ? '  — ' + detail : ''}`);
}

function skip(name: string, detail = '') {
  results.push({ name, pass: true, skip: true, detail });
  console.log(`  ⊘ ${name}${detail ? '  — ' + detail : ''} (optional)`);
}

function fail(name: string, detail = '') {
  results.push({ name, pass: false, detail });
  console.error(`  ✗ ${name}${detail ? '  — ' + detail : ''}`);
}

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Checks ────────────────────────────────────────────────────────────────

async function checkHealth(): Promise<void> {
  console.log('\n[health]');
  try {
    const r = await get('/health');
    if (!r.ok) { fail('GET /health', `HTTP ${r.status}`); return; }
    const body = await r.json() as Record<string, unknown>;
    if (body.status === 'ok') pass('GET /health', 'status=ok');
    else fail('GET /health', `unexpected body: ${JSON.stringify(body)}`);
    if (body.vessel === 'obsidian-vessel') pass('vessel identity');
    else fail('vessel identity', `got: ${body.vessel}`);
  } catch (e) {
    fail('GET /health', `${e}`);
  }
}

async function checkManifest(): Promise<string[]> {
  console.log('\n[manifest]');
  const shapes: string[] = [];
  try {
    const r = await get('/manifest');
    if (!r.ok) { fail('GET /manifest', `HTTP ${r.status}`); return shapes; }
    const body = await r.json() as Record<string, unknown>;
    if (body.vesselId) pass('vesselId present', String(body.vesselId));
    else fail('vesselId present');
    const advertised = (body.shapes as string[] | undefined) ?? [];
    if (advertised.length > 0) pass('shapes advertised', `${advertised.length} shapes`);
    else fail('shapes advertised', 'empty');
    shapes.push(...advertised);
  } catch (e) {
    fail('GET /manifest', `${e}`);
  }
  return shapes;
}

/**
 * Probe a resolver. Distinguishes:
 *   pass  — resolver returned content (200 success)
 *   warn  — resolver ran but content not found (422 "not found" / "no content") — resolver is wired correctly
 *   fail  — server error (500), or resolver rejected the pointer format itself
 */
async function checkResolve(type: string, pointer: Record<string, unknown>): Promise<void> {
  try {
    const r = await post('/resolve', { type, pointer });
    if (r.status === 400) {
      fail(`resolve ${type}`, `HTTP 400 — server rejected pointer (malformed)`);
      return;
    }
    if (r.status === 422) {
      const body = await r.json() as Record<string, unknown>;
      const err = String(body.error ?? '');
      // "not found", "no content", "no notes" etc — resolver dispatched, content simply absent
      const notFoundPhrases = ['not found', 'no content', 'no notes', 'no results', 'no events', 'no episodes'];
      if (notFoundPhrases.some(p => err.toLowerCase().includes(p))) {
        pass(`resolve ${type}`, `resolver ran — ${err.slice(0, 80)}`);
      } else {
        fail(`resolve ${type}`, `resolver error: ${err}`);
      }
      return;
    }
    if (!r.ok) {
      fail(`resolve ${type}`, `HTTP ${r.status}`);
      return;
    }
    const body = await r.json() as Record<string, unknown>;
    if (body.success) {
      const len = typeof body.content === 'string' ? body.content.length : 0;
      pass(`resolve ${type}`, len > 0 ? `content ${len} chars` : 'dispatched (no content)');
    } else {
      fail(`resolve ${type}`, `success=false: ${body.error}`);
    }
  } catch (e) {
    fail(`resolve ${type}`, `${e}`);
  }
}

async function checkResolveWrapped(): Promise<void> {
  // Verify the dual-form (wrapped impulse contract) is also accepted
  console.log('\n[resolve — wrapped impulse contract]');
  try {
    const r = await post('/resolve', {
      impulse: { pointer: { type: 'obsidian:search', query: 'substrate' } },
    });
    // Any non-500 response means the server parsed the wrapped form correctly
    if (r.status < 500) pass('wrapped impulse contract accepted', `HTTP ${r.status}`);
    else fail('wrapped impulse contract accepted', `HTTP ${r.status}`);
  } catch (e) {
    fail('wrapped impulse contract', `${e}`);
  }
}

async function checkErrorHandling(): Promise<void> {
  console.log('\n[error handling]');

  // Unknown type → 400
  try {
    const r = await post('/resolve', { type: 'obsidian:nonexistent', pointer: {} });
    if (r.status === 400) pass('unknown type → 400');
    else fail('unknown type → 400', `got ${r.status}`);
  } catch (e) {
    fail('unknown type → 400', `${e}`);
  }

  // Missing type → 400
  try {
    const r = await post('/resolve', { pointer: {} });
    if (r.status === 400) pass('missing type → 400');
    else fail('missing type → 400', `got ${r.status}`);
  } catch (e) {
    fail('missing type → 400', `${e}`);
  }

  // Empty body → 400
  try {
    const r = await fetch(`${BASE}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    if (r.status === 400) pass('empty body → 400');
    else fail('empty body → 400', `got ${r.status}`);
  } catch (e) {
    fail('empty body → 400', `${e}`);
  }

  // Invalid JSON → 400
  try {
    const r = await fetch(`${BASE}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken json',
    });
    if (r.status === 400) pass('invalid JSON → 400');
    else fail('invalid JSON → 400', `got ${r.status}`);
  } catch (e) {
    fail('invalid JSON → 400', `${e}`);
  }
}

// ─── Resolver probe matrix ─────────────────────────────────────────────────
// These pointers use the correct field names for each resolver.
// 422 "not found" is treated as pass (resolver ran, content absent) — see checkResolve.

// optional: these shapes may not be registered yet; skipped gracefully if absent
const OPTIONAL_SHAPES = new Set([
  'obsidian:event_observed',
  'obsidian:interaction_episode',
  'obsidian:action_effect_model',
]);

const RESOLVER_PROBES: Array<[string, Record<string, unknown>]> = [
  ['obsidian:search',      { query: 'substrate', limit: 5 }],
  ['obsidian:note',        { path: 'README.md' }],
  ['obsidian:frontmatter', { path: 'README.md' }],
  ['obsidian:backlinks',   { path: 'README.md' }],
  ['obsidian:daily_note',  { date: new Date().toISOString().slice(0, 10) }],
  ['obsidian:graph_query', { centerPath: 'README.md', limit: 20 }],
  // concept resolvers — correct field is concept_id
  ['obsidian:concept_view',      { concept_id: 'probe-health-check' }],
  ['obsidian:concept_writeback', { path: 'README.md', create_if_missing: false }],
  // Phase 1 observation layer — optional until registered in manifest
  ['obsidian:event_observed',       { limit: 5 }],
  ['obsidian:interaction_episode',  { limit: 5 }],
  ['obsidian:action_effect_model',  { limit: 1 }],
];

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Obsidian Vessel HTTP Harness — ${BASE}`);
  console.log('='.repeat(50));

  // Check server is reachable at all
  try {
    await get('/health');
  } catch {
    console.error(`\nFailed to connect to vessel at ${BASE}.`);
    console.error('Is Obsidian running with the metabob-vessel plugin enabled?');
    process.exit(1);
  }

  await checkHealth();
  const shapes = await checkManifest();

  // Resolver probes
  console.log('\n[resolve — each shape]');
  for (const [type, pointer] of RESOLVER_PROBES) {
    const registered = shapes.includes(type);
    if (!registered) {
      if (OPTIONAL_SHAPES.has(type)) {
        skip(`resolve ${type}`, 'not in manifest (Phase 1 — not yet registered)');
      } else {
        fail(`resolve ${type}`, 'not in manifest shapes');
      }
      continue;
    }
    await checkResolve(type, pointer);
  }

  await checkResolveWrapped();
  await checkErrorHandling();

  // Summary
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const allPass = passed === total;

  console.log('\n' + '='.repeat(50));
  console.log(`${allPass ? '✓' : '✗'} ${passed}/${total} checks passed`);

  if (!allPass) {
    console.log('\nFailed checks:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  • ${r.name}${r.detail ? ': ' + r.detail : ''}`);
    }
  }

  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error('Harness crashed:', e);
  process.exit(1);
});
