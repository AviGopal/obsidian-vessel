// federation-sidecar.ts — the plugin's single substrate conduit, spawned and
// supervised by the plugin itself (see ../src/sidecar-manager.ts) as a separate
// child process, so the plugin's own esbuild bundle never has to carry libp2p.
//
// The sidecar is the ONE place that holds the API key and the discovery URL.
// Everything else is looked up: given a shape, it asks discovery which vessel
// owns it, remaps the registered endpoint to a reachable host:port, and
// forwards the request with auth attached. The plugin talks only to the
// sidecar's loopback port and never needs per-service endpoints or keys.
//
// Two operating modes, selected by whether RELAY_MULTIADDR is set:
//
//   LOCAL (no relay): pure egress conduit. No libp2p node is created; the
//   loopback API below is served, and every outbound resolve/HTTP call is
//   routed via discovery lookup + direct HTTP. The plugin registers itself
//   with discovery as before (no double registration from here).
//
//   FEDERATED (relay set): everything LOCAL does, plus a libp2p Circuit
//   Relay v2 reservation that makes the plugin's local HTTP server
//   discoverable and resolvable from a remote hub. Registers with the hub's
//   discovery advertising protocol:"libp2p" + the circuit multiaddr, and
//   prefers the overlay (hub ingress) for outbound resolves, falling back to
//   discovery-routed HTTP.
//
// Loopback API (127.0.0.1:<OBSIDIAN_PASSTHROUGH_HEALTH_PORT>, CORS-open so the
// Obsidian renderer at app://obsidian.md can call it directly):
//   GET  /health            — liveness + transport + advertised shapes
//   POST /outbound/resolve  — { pointer } → resolve via overlay or discovery
//   POST /outbound/http     — { service?|shape?, method?, path, body? } →
//                             plain REST forwarded to the owning vessel
//
// Env — the complete federated config is TWO values; everything else derives:
//   API_KEY (or METABOB_API_KEY)    ApiKey attached to every forwarded request [required]
//   RELAY_MULTIADDR                 the substrate relay's public multiaddr — the libp2p
//                                   peer location [required for FEDERATED; omit → LOCAL
//                                   mode, which then needs DISCOVERY_URL]
// Derived when unset (each env still wins as an explicit override):
//   DISCOVERY_URL                   ← http://<relay host>:18100
//   OBSIDIAN_VESSEL_ID              ← obsidian-<hostname>-vessel (host-unique; seeds
//                                     the libp2p identity — a shared default collides)
//   FEDERATION_INGRESS_MULTIADDR    ← auto-discovered from hub discovery (federation_probe)
//   OBSIDIAN_URL                    ← http://127.0.0.1:27182
//   OBSIDIAN_PASSTHROUGH_HEALTH_PORT  ← 8402

import { hostname } from 'node:os';

// A shared default vessel id would seed IDENTICAL libp2p keys on every host
// (observed peer-id collision); derive a stable host-unique id instead.
const VESSEL_ID = process.env.OBSIDIAN_VESSEL_ID
  || `obsidian-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-vessel`;
const RELAY = process.env.RELAY_MULTIADDR || '';
// Derive the hub discovery URL from the relay's host when not given explicitly —
// the relay and the hub control plane live on the same public host by convention,
// so RELAY_MULTIADDR + API key is a complete federation config.
function deriveDiscoveryFromRelay(relay: string): string {
  const m = /^\/ip4\/([0-9.]+)\//.exec(relay) || /^\/dns4?\/([^/]+)\//.exec(relay);
  return m ? `http://${m[1]}:18100` : '';
}
const DISCOVERY = ((process.env.DISCOVERY_URL || '').replace(/\/+$/, '')) || deriveDiscoveryFromRelay(RELAY);
const API_KEY = process.env.API_KEY || process.env.METABOB_API_KEY || '';
const OBSIDIAN = (process.env.OBSIDIAN_URL || 'http://127.0.0.1:27182').replace(/\/+$/, '');
const HEALTH_PORT = parseInt(process.env.OBSIDIAN_PASSTHROUGH_HEALTH_PORT || '8402', 10);
let INGRESS = process.env.FEDERATION_INGRESS_MULTIADDR || '';
const LOCAL_MODE = !RELAY;

if (!DISCOVERY) {
  console.error('[federation-sidecar] set RELAY_MULTIADDR (discovery derives from its host) or DISCOVERY_URL for local-conduit mode');
  process.exit(1);
}

// Auto-discover the hub federation-transport ingress: ask discovery who serves
// federation_probe over libp2p and take its circuit multiaddr. Runs once at
// startup; an explicit FEDERATION_INGRESS_MULTIADDR still wins.
async function discoverIngress(): Promise<string> {
  if (INGRESS || !DISCOVERY) return INGRESS;
  try {
    const r = await fetch(DISCOVERY + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
      body: JSON.stringify({ pointer: { type: 'vesselCapability', shape: 'federation_probe' } }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json().catch(() => ({}));
    const row = (j?.content?.vessels ?? []).find((v: any) =>
      v?.protocol === 'libp2p' && Array.isArray(v?.libp2p_multiaddr) && v.libp2p_multiaddr[0]
      && String(v.vesselId ?? '') !== VESSEL_ID);
    return row ? String(row.libp2p_multiaddr[0]) : '';
  } catch { return ''; }
}
if (!INGRESS && !LOCAL_MODE) {
  INGRESS = await discoverIngress();
  if (INGRESS) console.log('[federation-sidecar] auto-discovered hub ingress ...' + INGRESS.slice(-24));
}

// ── Discovery-routed HTTP egress ─────────────────────────────────────────────
// Given a shape, ask discovery who owns it and derive a reachable base URL.
// Vessels register their in-container endpoints (e.g. http://127.0.0.1:8080);
// from outside the container the convention is host = discovery's host and
// port 8xxx → 18xxx. Endpoints already carrying a routable host:port pass
// through unchanged when they match the discovery host.
const discoveryUrl = new URL(DISCOVERY);

function remapEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
    const discoveryPort = parseInt(discoveryUrl.port || '80', 10);
    u.hostname = discoveryUrl.hostname;
    if (port >= 8000 && port < 10000 && discoveryPort >= 10000) {
      // Host-mapping convention: in-container 8xxx maps to host 8xxx + OFFSET,
      // where OFFSET is derivable from discovery's own mapping (its container
      // port is always 8100). +10000 for the default 18xxx layout, +20000 when
      // the substrate runs with PORT_OFFSET=10000 (28xxx), etc.
      u.port = String(port + (discoveryPort - 8100));
    }
    return u.origin;
  } catch {
    return endpoint.replace(/\/+$/, '');
  }
}

interface ShapeOwner { base: string; resolvePath: string; vesselId: string; multiaddrs: string[] }
const ownersCache = new Map<string, { owners: ShapeOwner[]; ts: number }>();
const OWNER_CACHE_TTL_MS = 60_000;
const isLoopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u);

function ownerFromRow(v: any, idOf: (x: any) => string): ShapeOwner {
  // Remap the (possibly in-container) endpoint ourselves: the offset is derived
  // from discovery's own mapped port, which stays correct when the substrate runs
  // on shifted host ports. public_endpoint is only trusted when it isn't loopback.
  const pub = typeof v.public_endpoint === 'string' ? v.public_endpoint.replace(/\/+$/, '') : '';
  return {
    base: pub && !isLoopback(pub) ? pub : remapEndpoint(String(v.endpoint)),
    // resolve_endpoint may be advertised as a full (loopback) URL; take only its
    // path so it can't concatenate with base into an invalid ("fetch() URL is
    // invalid") fetch URL.
    resolvePath: (() => { const re = String(v.resolve_endpoint || '/v2/impulses/resolve'); try { return /^https?:\/\//.test(re) ? new URL(re).pathname : re; } catch { return '/v2/impulses/resolve'; } })(),
    vesselId: idOf(v) || 'unknown',
    multiaddrs: Array.isArray(v.libp2p_multiaddr) ? v.libp2p_multiaddr.filter((m: unknown) => typeof m === 'string') : [],
  };
}

// Return ALL owners of a shape, ranked for failover: overlay-dialable rows
// (protocol:libp2p + circuit multiaddr) first — a federated shape is served by
// several instances and any one may be offline, so the resolver tries them in
// turn — then genuinely-remote HTTP endpoints. A single loopback row (endpoint
// 127.0.0.1, resolve_endpoint often a full loopback URL) is useless off-box on
// its own; committing to it strands cross-host resolves (fleetActivityFeed →
// empty metrics/boredom in the panel).
async function lookupShapeOwners(shape: string): Promise<ShapeOwner[]> {
  const cached = ownersCache.get(shape);
  if (cached && Date.now() - cached.ts < OWNER_CACHE_TTL_MS) return cached.owners;
  try {
    const res = await fetch(DISCOVERY + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
      body: JSON.stringify({ pointer: { type: 'vesselCapability', shape } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const body: any = await res.json().catch(() => ({}));
    const vessels: any[] = body?.content?.vessels ?? body?.vessels ?? [];
    // Never route back to ourselves (the plugin's own shapes resolve locally).
    const idOf = (x: any) => String(x?.vesselId ?? x?.vessel_id ?? '');
    const owners = vessels
      .filter((x) => x?.endpoint && idOf(x) !== VESSEL_ID && !idOf(x).startsWith('obsidian-'))
      .map((v) => ownerFromRow(v, idOf))
      // multiaddr-bearing owners first (overlay failover), stable otherwise.
      .sort((a, b) => (b.multiaddrs.length ? 1 : 0) - (a.multiaddrs.length ? 1 : 0));
    ownersCache.set(shape, { owners, ts: Date.now() });
    return owners;
  } catch {
    return [];
  }
}

async function lookupShapeOwner(shape: string): Promise<ShapeOwner | null> {
  return (await lookupShapeOwners(shape))[0] ?? null;
}

async function resolveViaDiscoveryHttp(pointer: any): Promise<any> {
  const shape = String(pointer?.type ?? '');
  const owners = await lookupShapeOwners(shape);
  if (owners.length === 0) return { error: `no vessel advertises shape "${shape}" in discovery (${DISCOVERY})` };
  const errors: string[] = [];
  // (1) Overlay failover: try each federated instance's circuit(s) until one
  // answers. Several instances serve the same shape and some are offline.
  if (vl && resolveViaLibp2pFn) {
    for (const owner of owners) {
      for (const ma of owner.multiaddrs) {
        try {
          const res = await resolveViaLibp2pFn(vl, ma, pointer);
          return { shape, resolved_by: owner.vesselId, ok: true, ...(typeof res === 'object' && res !== null ? res : { body: res }) };
        } catch (e) { errors.push(`overlay ${owner.vesselId}: ${String((e as Error)?.message ?? e)}`); }
      }
    }
  }
  // (2) HTTP fallback to genuinely-remote (non-loopback) endpoints only — never a
  // host-laundered loopback (dead off-box, location independence / law 11).
  for (const owner of owners) {
    if (isLoopback(owner.base)) continue;
    try {
      const res = await fetch(owner.base + owner.resolvePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => ({}));
      return { shape, resolved_by: owner.vesselId, status: res.status, ok: res.ok, ...(typeof body === 'object' && body !== null ? body : { body }) };
    } catch (e) { errors.push(`http ${owner.vesselId} (${owner.base}): ${String((e as Error)?.message ?? e)}`); }
  }
  return { error: `no reachable route for "${shape}" (${owners.length} candidate(s) tried): ${errors.slice(0, 4).join('; ')}` };
}

// ── libp2p transport (federated mode only) ──────────────────────────────────
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

const obsidianResolveHandler = async (pointer: any): Promise<any> => {
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
};

// Loaded lazily so LOCAL mode never touches libp2p at all. Assigned by
// initLibp2p() AFTER the loopback API is already serving — the conduit must be
// reachable the moment the process starts (the plugin's on-load syncs race the
// relay reservation otherwise); overlay-dependent paths just see vl=null until
// the transport is up and fall back to discovery-routed HTTP in the meantime.
let vl: any = null;
let circuit = '';
let resolveViaLibp2pFn: any = null;
let resolveViaHttpFn: any = null;

async function initLibp2p(): Promise<void> {
  const { createVesselLibp2p, serveResolve, serveResolveHttp, resolveViaLibp2p, resolveViaHttp } =
    await import('@avigopal/libp2p-federation-transport');
  resolveViaLibp2pFn = resolveViaLibp2p;
  resolveViaHttpFn = resolveViaHttp;
  const node = await createVesselLibp2p({ vesselId: VESSEL_ID, relayMultiaddr: RELAY, enableHttp: true });
  // Serve the plugin's shapes over BOTH transports: lpStream (serveResolve — large
  // bodies like concept views survive after the sendAll fix) and legacy HTTP.
  await serveResolve(node, obsidianResolveHandler);
  await serveResolveHttp(node, obsidianResolveHandler);
  vl = node;

  // Wait for the relay reservation -> advertisable circuit multiaddr.
  for (let i = 0; i < 40; i++) {
    const c = node.advertiseMultiaddrs().find((m: string) => m.includes('p2p-circuit'));
    if (c) { circuit = c; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!circuit) console.warn('[federation-sidecar] no circuit multiaddr yet — registration will advertise none');
}

// ── Loopback API ─────────────────────────────────────────────────────────────
// CORS-open: the Obsidian renderer's origin is app://obsidian.md and Chromium
// preflights cross-origin fetches. This port binds loopback only, so the
// process boundary — not the origin — is the trust boundary.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsJson(payload: unknown, status = 200): Response {
  return Response.json(payload as any, { status, headers: CORS_HEADERS });
}

try {
  Bun.serve({
    port: HEALTH_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (u.pathname === '/health') {
        return corsJson({
          status: 'ok',
          service: VESSEL_ID,
          mode: LOCAL_MODE ? 'local' : 'federated',
          obsidian: OBSIDIAN,
          discovery: DISCOVERY,
          transport: vl ? vl.health() : null,
          libp2p_peer_id: vl ? vl.peerId : null,
          libp2p_multiaddr: circuit || null,
          ingress: INGRESS || null,
          advertised_shapes: [...Object.keys(ROUTES), ...manifestShapes],
        });
      }
      // OUTBOUND resolve: the plugin POSTs { pointer } (optionally { target }).
      // Federated: dial the hub ingress over libp2p. Local (or overlay failure):
      // discovery lookup + direct HTTP to the owning vessel, API key attached.
      if (u.pathname === '/outbound/resolve' && req.method === 'POST') {
        try {
          const body: any = await req.json().catch(() => ({}));
          const pointer = body?.pointer ?? body;
          if (!pointer || !pointer.type) return corsJson({ error: 'missing pointer.type' }, 400);
          const target = String(body?.target || INGRESS || '');
          if (vl && target) {
            // lpStream first (carries multi-KB hub responses reliably after the
            // sendAll fix); legacy HTTP second; discovery-routed HTTP last.
            try { return corsJson(await resolveViaLibp2pFn(vl, target, pointer)); }
            catch {
              try { return corsJson(await resolveViaHttpFn(vl, target, pointer)); }
              catch { /* fall through to discovery routing */ }
            }
          }
          return corsJson(await resolveViaDiscoveryHttp(pointer));
        } catch (e) {
          return corsJson({ error: 'outbound resolve failed: ' + String((e as Error)?.message ?? e) }, 502);
        }
      }
      // OUTBOUND plain REST: { service?: 'discovery', shape?, method?, path, body? }.
      // The target base URL comes from discovery (shape ownership), never from
      // plugin config — this is what lets the plugin drop per-service endpoints.
      if (u.pathname === '/outbound/http' && req.method === 'POST') {
        try {
          const spec: any = await req.json().catch(() => ({}));
          const path = String(spec?.path ?? '');
          if (!path.startsWith('/')) return corsJson({ error: 'missing or invalid path' }, 400);
          let base = '';
          let via = '';
          if (spec?.service === 'discovery') {
            base = DISCOVERY;
            via = 'discovery';
          } else if (spec?.shape) {
            const owner = await lookupShapeOwner(String(spec.shape));
            if (!owner) return corsJson({ error: `no vessel advertises shape "${spec.shape}"` }, 502);
            // Owners behind a federation transport are HTTP-unreachable (peer
            // loopback endpoint) but overlay-dialable. Impulse-resolve requests
            // translate cleanly onto the overlay's resolve protocol; do that
            // instead of dialling a dead endpoint.
            const bodyObj: any = spec?.body;
            const isResolve = spec.path === owner.resolvePath && bodyObj && typeof bodyObj === 'object' && (bodyObj.impulse || bodyObj.pointer);
            if (vl && resolveViaLibp2pFn && owner.multiaddrs.length > 0 && isResolve) {
              try {
                const pointer = { type: String(spec.shape), ...(bodyObj.impulse?.pointer ?? bodyObj.impulse ?? bodyObj.pointer) };
                const res = await resolveViaLibp2pFn(vl, owner.multiaddrs[0], pointer);
                return corsJson({ status: 200, ok: true, via: owner.vesselId, body: res?.content ?? res });
              } catch {
                /* fall through to plain HTTP */
              }
            }
            base = owner.base;
            via = owner.vesselId;
          } else {
            return corsJson({ error: 'specify service:"discovery" or a shape to route by' }, 400);
          }
          const method = String(spec?.method || (spec?.body != null ? 'POST' : 'GET')).toUpperCase();
          const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
            body: spec?.body != null ? JSON.stringify(spec.body) : undefined,
            signal: AbortSignal.timeout(30_000),
          });
          const body = await res.json().catch(() => null);
          return corsJson({ status: res.status, ok: res.ok, via, body });
        } catch (e) {
          return corsJson({ error: 'outbound http failed: ' + String((e as Error)?.message ?? e) }, 502);
        }
      }
      return new Response('not found', { status: 404, headers: CORS_HEADERS });
    },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[federation-sidecar] FATAL: cannot bind health port ${HEALTH_PORT} (${msg}). ` +
    `Another sidecar instance is likely holding it (orphan from a previous session, or a second vault). ` +
    `Kill the stale process or set a different federationHealthPort in the plugin settings.`);
  process.exit(3);
}

// ── libp2p init + discovery registration ────────────────────────────────────
// In LOCAL mode the plugin registers itself with discovery directly (its HTTP
// server is reachable from the substrate via the advertised host); registering
// here too would double-register the same vessel.
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
if (!LOCAL_MODE) {
  await initLibp2p();
  await register();
  setInterval(register, 120_000);
} else {
  // Keep the advertised-shapes list in /health fresh even without registration.
  await fetchManifestShapes();
  setInterval(fetchManifestShapes, 120_000);
}

console.log(`[federation-sidecar] up id=${VESSEL_ID} mode=${LOCAL_MODE ? 'local' : 'federated'} health=:${HEALTH_PORT}${vl ? ` peer=${vl.peerId} circuit=${circuit || '(none yet)'}` : ''} -> obsidian ${OBSIDIAN}, discovery ${DISCOVERY}`)
