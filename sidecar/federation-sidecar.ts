// federation-sidecar.ts — libp2p Circuit Relay v2 passthrough for the
// operator-host Obsidian plugin. Spawned and supervised by the plugin itself
// (see ../src/sidecar-manager.ts) as a separate child process, so the plugin's
// own esbuild bundle never has to carry libp2p as a dependency.
//
// Makes the plugin's local HTTP server (http://127.0.0.1:<serverPort>, NATed,
// unreachable from a remote substrate) discoverable and resolvable from a
// remote hub over a Circuit Relay v2 reservation: registers with the hub's
// discovery-vessel advertising protocol:"libp2p" + the circuit multiaddr, then
// proxies each resolved shape to the matching REST route already exposed by
// the plugin's HTTP server (repos/obsidian-vessel/src/main.ts
// registerActionObservationRoutes).
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

// shape -> plugin route. Kept in lockstep with registerActionObservationRoutes
// in ../src/main.ts; add an entry here when a new obsidian_* shape is exposed.
const ROUTES: Record<string, { method: 'GET' | 'POST'; path: string; description: string }> = {
  obsidian_status: { method: 'GET', path: '/observations/status', description: 'live status of the operator-host Obsidian vault/plugin (active note, sync state, goal-dispatch open)' },
  obsidian_concept_status: { method: 'GET', path: '/observations/concept-status', description: 'concept-sync status of the operator-host Obsidian vault' },
  obsidian_dispatch_goal: { method: 'POST', path: '/actions/dispatch-goal', description: 'dispatch a goal typed into / on behalf of the operator-host Obsidian surface' },
  obsidian_open_note: { method: 'POST', path: '/actions/open-note', description: 'open a note in the operator-host Obsidian UI' },
  obsidian_sync: { method: 'POST', path: '/actions/sync', description: 'trigger a vault sync on the operator-host Obsidian' },
};

const vl: VesselLibp2p = await createVesselLibp2p({ vesselId: VESSEL_ID, relayMultiaddr: RELAY, enableHttp: true });

await serveResolveHttp(vl, async (pointer: any) => {
  const t = String(pointer?.type ?? '');
  const route = ROUTES[t];
  if (!route) return { error: 'unknown obsidian shape: ' + t };
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
});

// Wait for the relay reservation -> advertisable circuit multiaddr.
let circuit = '';
for (let i = 0; i < 40; i++) {
  const c = vl.advertiseMultiaddrs().find((m) => m.includes('p2p-circuit'));
  if (c) { circuit = c; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!circuit) console.warn('[federation-sidecar] no circuit multiaddr yet — registration will advertise none');

Bun.serve({
  port: HEALTH_PORT,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/health') {
      return Response.json({ status: 'ok', service: VESSEL_ID, obsidian: OBSIDIAN, transport: vl.health(), libp2p_peer_id: vl.peerId, libp2p_multiaddr: circuit });
    }
    return new Response('not found', { status: 404 });
  },
});

async function register() {
  try {
    const r = await fetch(DISCOVERY + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'ApiKey ' + API_KEY },
      body: JSON.stringify({
        vesselId: VESSEL_ID,
        vesselName: VESSEL_ID,
        version: '0.1.0',
        endpoint: `http://127.0.0.1:${HEALTH_PORT}`, // NATed loopback — real reachability is the circuit
        shapes: Object.keys(ROUTES),
        resolve_endpoint: '/v2/impulses/resolve',
        resolve_request_format: 'pointer',
        auth_scheme: 'none',
        protocol: 'libp2p',
        libp2p_peer_id: vl.peerId,
        libp2p_multiaddr: circuit ? [circuit] : [],
        systemVessel: true,
        shape_descriptions: Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.description])),
      }),
    });
    console.log('[federation-sidecar] register ->', r.status);
  } catch (e) {
    console.log('[federation-sidecar] register err', String(e));
  }
}
await register();
setInterval(register, 120_000);

console.log(`[federation-sidecar] up id=${VESSEL_ID} peer=${vl.peerId} health=:${HEALTH_PORT} circuit=${circuit || '(none yet)'} -> obsidian ${OBSIDIAN}`);
