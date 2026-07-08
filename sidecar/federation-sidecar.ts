// federation-sidecar.ts — libp2p Circuit Relay v2 passthrough for the
// operator-host Obsidian plugin. Spawned and supervised by the plugin itself
// (see ../src/sidecar-manager.ts) as a separate child process, so the plugin's
// own esbuild bundle never has to carry libp2p as a dependency.
//
// Makes the plugin's local HTTP server (http://127.0.0.1:<serverPort>, NATed,
// unreachable from a remote substrate) discoverable and resolvable from a
// remote hub over a Circuit Relay v2 reservation: registers with the hub's
// discovery-vessel advertising protocol:"libp2p" + the circuit multiaddr, then
// proxies each resolved shape to the plugin's HTTP server. Two families are
// bridged:
//   1. Named action/observation routes (obsidian_status, obsidian_dispatch_goal
//      …) → the specific REST route in ../src/main.ts.
//   2. The plugin's colon-form RESOLVER shapes (obsidian:note, obsidian:
//      workspace_state, obsidian:write_note …), fetched live from the plugin's
//      GET /manifest → proxied to POST /resolve. This is the impulse-contract
//      surface: whatever resolvers the plugin registers (including ones the
//      substrate authors into it later) become discoverable/resolvable from any
//      substrate that peers with the hub, WITHOUT editing this file — the
//      manifest is the source of truth.
//
// This is the single registration surface for the operator-host vessel. The
// intended routing (per the operator's topology) is entirely relay-mediated:
//   plugin → this sidecar (libp2p) → relay@hub → hub discovery
//   spoke goal-host (peers hub) → local federation egress → relay → this sidecar → plugin
// No host.docker.internal direct path is required; the vessel is reachable from
// any peer of the hub identically.
//
// Env (all set by SidecarManager when it spawns this process):
//   OBSIDIAN_VESSEL_ID              stable vessel id (seeds the libp2p identity)
//   RELAY_MULTIADDR                 the substrate relay's public multiaddr    [required]
//   DISCOVERY_URL                   discovery-vessel base URL to register with [required]
//   API_KEY                         ApiKey for the discovery registration
//   OBSIDIAN_URL                    the plugin's own HTTP server base URL
//   OBSIDIAN_PASSTHROUGH_HEALTH_PORT  plain-HTTP /health port (default 8402)
import { createVesselLibp2p, serveResolveHttp, type VesselLibp2p } from '@avigopal/libp2p-federation-transport';

const VESSEL_ID = process.env.OBSIDIAN_VESSEL_ID || 'obsidian-host-vessel';
const RELAY = process.env.RELAY_MULTIADDR || '';
const DISCOVERY = (process.env.DISCOVERY_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || process.env.METABOB_API_KEY || '';
const OBSIDIAN = (process.env.OBSIDIAN_URL || 'http://127.0.0.1:27182').replace(/\/+$/, '');
const HEALTH_PORT = parseInt(process.env.OBSIDIAN_PASSTHROUGH_HEALTH_PORT || '8402', 10);

if (!RELAY || !DISCOVERY) {
  console.error('[federation-sidecar] set RELAY_MULTIADDR and DISCOVERY_URL');
  process.exit(1);
}

// Named action/observation routes. Kept in lockstep with the action/observation
// route registration in ../src/main.ts; add an entry here when a new named
// obsidian_* action/observation route is exposed. (The colon-form RESOLVER
// shapes are NOT listed here — they are discovered dynamically from the
// plugin's /manifest and proxied to POST /resolve; see below.)
const ROUTES: Record<string, { method: 'GET' | 'POST'; path: string; description: string }> = {
  obsidian_status: { method: 'GET', path: '/observations/status', description: 'live status of the operator-host Obsidian vault/plugin (active note, sync state, goal-dispatch open)' },
  obsidian_concept_status: { method: 'GET', path: '/observations/concept-status', description: 'concept-sync status of the operator-host Obsidian vault' },
  obsidian_dispatch_goal: { method: 'POST', path: '/actions/dispatch-goal', description: 'dispatch a goal typed into / on behalf of the operator-host Obsidian surface' },
  obsidian_open_note: { method: 'POST', path: '/actions/open-note', description: 'open a note in the operator-host Obsidian UI' },
  obsidian_sync: { method: 'POST', path: '/actions/sync', description: 'trigger a vault sync on the operator-host Obsidian' },
};

// Colon-form resolver shapes advertised by the plugin's GET /manifest. Refreshed
// on each registration cycle so substrate-authored resolvers appear without a
// sidecar rebuild. Fail-open: on error, keep the last known set.
let manifestShapes: string[] = [];

async function fetchManifestShapes(): Promise<string[]> {
  try {
    const res = await fetch(OBSIDIAN + '/manifest', { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return manifestShapes;
    const body: any = await res.json().catch(() => ({}));
    const shapes: unknown = body?.shapes;
    if (Array.isArray(shapes)) {
      // Only the resolver (colon-form) shapes; named routes are handled by ROUTES.
      manifestShapes = shapes.filter((s): s is string => typeof s === 'string' && s.includes(':') && !(s in ROUTES));
    }
  } catch {
    /* keep last known set */
  }
  return manifestShapes;
}

const vl: VesselLibp2p = await createVesselLibp2p({ vesselId: VESSEL_ID, relayMultiaddr: RELAY, enableHttp: true });

await serveResolveHttp(vl, async (pointer: any) => {
  const t = String(pointer?.type ?? '');

  // 1. Named action/observation route.
  const route = ROUTES[t];
  if (route) {
    try {
      const init: RequestInit = route.method === 'POST'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pointer?.body ?? pointer?.payload ?? {}) }
        : { method: 'GET' };
      const res = await fetch(OBSIDIAN + route.path, { ...init, signal: AbortSignal.timeout(10_000) });
      const body = await res.json().catch(() => ({}));
      return { shape: t, produced_by: VESSEL_ID, status: res.status, ok: res.ok, body, note: 'resolved on the operator host against the live Obsidian plugin (implicit-vessel surface)' };
    } catch (e) {
      return { error: 'obsidian plugin unreachable: ' + String((e as Error)?.message ?? e) };
    }
  }

  // 2. Colon-form resolver shape → proxy to the plugin's impulse-contract
  //    /resolve endpoint. Accept any obsidian:* shape (or a currently-advertised
  //    manifest shape) so a resolver added to the plugin resolves even before
  //    the next manifest refresh.
  if (t.startsWith('obsidian:') || manifestShapes.includes(t)) {
    try {
      const res = await fetch(OBSIDIAN + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // impulse-contract wrapped form; the plugin's handleResolve accepts it.
        body: JSON.stringify({ impulse: { pointer: { ...(pointer ?? {}), type: t } } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.json().catch(() => ({}));
      return { shape: t, produced_by: VESSEL_ID, status: res.status, ok: res.ok, body, note: 'resolved on the operator host against the live Obsidian plugin resolver (impulse-contract /resolve)' };
    } catch (e) {
      return { error: 'obsidian plugin unreachable: ' + String((e as Error)?.message ?? e) };
    }
  }

  return { error: 'unknown obsidian shape: ' + t };
});

// Wait for the relay reservation -> advertisable circuit multiaddr.
let circuit = '';
for (let i = 0; i < 40; i++) {
  const c = vl.advertiseMultiaddrs().find((m) => m.includes('p2p-circuit'));
  if (c) { circuit = c; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!circuit) console.warn('[federation-sidecar] no circuit multiaddr yet — registration will advertise none');

try {
  Bun.serve({
    port: HEALTH_PORT,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/health') {
        return Response.json({ status: 'ok', service: VESSEL_ID, obsidian: OBSIDIAN, transport: vl.health(), libp2p_peer_id: vl.peerId, libp2p_multiaddr: circuit, advertised_shapes: [...Object.keys(ROUTES), ...manifestShapes] });
      }
      return new Response('not found', { status: 404 });
    },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[federation-sidecar] FATAL: cannot bind health port ${HEALTH_PORT} (${msg}). ` +
    `Another sidecar instance is likely holding it (orphan from a previous session, or a second vault). ` +
    `Kill the stale process or set a different federationHealthPort in the plugin settings.`);
  process.exit(3);
}

async function register() {
  const resolverShapes = await fetchManifestShapes();
  const shapes = [...Object.keys(ROUTES), ...resolverShapes];
  const shape_descriptions: Record<string, string> = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.description]));
  for (const s of resolverShapes) shape_descriptions[s] = `operator-host Obsidian resolver shape "${s}" (proxied to the plugin's /resolve on the operator vault)`;
  try {
    const r = await fetch(DISCOVERY + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'ApiKey ' + API_KEY },
      body: JSON.stringify({
        vesselId: VESSEL_ID,
        vesselName: VESSEL_ID,
        version: '0.1.0',
        endpoint: `http://127.0.0.1:${HEALTH_PORT}`, // NATed loopback — real reachability is the circuit
        shapes,
        resolve_endpoint: '/v2/impulses/resolve',
        resolve_request_format: 'pointer',
        auth_scheme: 'none',
        protocol: 'libp2p',
        libp2p_peer_id: vl.peerId,
        libp2p_multiaddr: circuit ? [circuit] : [],
        systemVessel: true,
        shape_descriptions,
      }),
    });
    console.log(`[federation-sidecar] register -> ${r.status} (${shapes.length} shapes: ${Object.keys(ROUTES).length} named + ${resolverShapes.length} resolver)`);
  } catch (e) {
    console.log('[federation-sidecar] register err', String(e));
  }
}
await register();
setInterval(register, 120_000);

console.log(`[federation-sidecar] up id=${VESSEL_ID} peer=${vl.peerId} health=:${HEALTH_PORT} circuit=${circuit || '(none yet)'} -> obsidian ${OBSIDIAN}`);
