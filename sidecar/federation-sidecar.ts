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
//   FEDERATION_INGRESS_MULTIADDR    ← auto-discovered from hub discovery (federation_probe);
//                                     discovery supersedes a set value (a pin is only the
//                                     fallback when discovery has no ingress row)
//   OBSIDIAN_URL                    ← http://127.0.0.1:27182
//   OBSIDIAN_PASSTHROUGH_HEALTH_PORT  ← 8402

import { hostname } from 'node:os';

// RESILIENCE: libp2p internals emit 'error' events on streams/sockets with no
// listener (relay dial timeouts etc.) — without these guards that becomes
// ERR_UNHANDLED_ERROR and the whole sidecar exits, taking the vault's goal
// tracking dark until respawn. Log and continue; never exit from a peer fault.
process.on('uncaughtException', (err) => { console.error('[federation-sidecar] uncaughtException (continuing):', (err as Error)?.message ?? String(err)); });
process.on('unhandledRejection', (reason) => { console.error('[federation-sidecar] unhandledRejection (continuing):', (reason as Error)?.message ?? String(reason)); });


// A shared default vessel id would seed IDENTICAL libp2p keys on every host
// (observed peer-id collision); derive a stable host-unique id instead.
const VESSEL_ID = process.env.OBSIDIAN_VESSEL_ID
  || `obsidian-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-vessel`;
let RELAY = process.env.RELAY_MULTIADDR || '';
// Derive the hub discovery URL from the relay's host when not given explicitly —
// the relay and the hub control plane live on the same public host by convention,
// so RELAY_MULTIADDR + API key is a complete federation config.
function deriveDiscoveryFromRelay(relay: string): string {
  const m = /^\/ip4\/([0-9.]+)\//.exec(relay) || /^\/dns4?\/([^/]+)\//.exec(relay);
  return m ? `http://${m[1]}:18100` : '';
}
const DISCOVERY = ((process.env.DISCOVERY_URL || '').replace(/\/+$/, '')) || deriveDiscoveryFromRelay(RELAY);
const API_KEY = process.env.API_KEY || process.env.METABOB_API_KEY || '';
// "Just point and go": pointed at a DISCOVERY with no explicit relay, read the
// relay anchor from its public GET /bootstrap and PREFER the p2p overlay — so the
// whole config is {discoveryVesselEndpoint, apiKey} and the relay is never a
// stale hand-copied multiaddr (law 1: read it at use time, not frozen in config).
if (!RELAY && DISCOVERY) {
  try {
    const r = await fetch(`${DISCOVERY}/bootstrap`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const b = await r.json() as { relay_multiaddrs?: string[] };
      if (b.relay_multiaddrs?.length) {
        RELAY = b.relay_multiaddrs[0]!;
        console.log(`[federation-sidecar] relay from ${DISCOVERY}/bootstrap: ${RELAY} (preferring p2p overlay)`);
      }
    }
  } catch (e) {
    console.warn(`[federation-sidecar] bootstrap fetch failed (${(e as Error).message}); staying in local-conduit mode`);
  }
}
const OBSIDIAN = (process.env.OBSIDIAN_URL || 'http://127.0.0.1:27182').replace(/\/+$/, '');
const HEALTH_PORT = parseInt(process.env.OBSIDIAN_PASSTHROUGH_HEALTH_PORT || '8402', 10);
let INGRESS = process.env.FEDERATION_INGRESS_MULTIADDR || '';
const LOCAL_MODE = !RELAY;

if (!DISCOVERY) {
  console.error('[federation-sidecar] set RELAY_MULTIADDR (discovery derives from its host) or DISCOVERY_URL for local-conduit mode');
  process.exit(1);
}

// Auto-discover the hub federation-transport ingress: ask discovery who serves
// federation_probe over libp2p and take its circuit multiaddr. Discovery is
// authoritative: a pinned FEDERATION_INGRESS_MULTIADDR fossilizes the peer ids
// of one hub deployment and silently severs every overlay resolve after a hub
// redeploy (dials to the dead peer hang), so the pin is only a fallback for
// when discovery has no answer.
async function discoverIngress(): Promise<string> {
  if (!DISCOVERY) return '';
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
if (!LOCAL_MODE) {
  const discovered = await discoverIngress();
  if (discovered && discovered !== INGRESS) {
    if (INGRESS) console.log('[federation-sidecar] pinned ingress ...' + INGRESS.slice(-24) + ' superseded by discovered ...' + discovered.slice(-24));
    else console.log('[federation-sidecar] auto-discovered hub ingress ...' + discovered.slice(-24));
    INGRESS = discovered;
  } else if (!discovered && INGRESS) {
    console.log('[federation-sidecar] discovery had no ingress row — keeping pinned ...' + INGRESS.slice(-24));
  }
}

// A dial to a dead peer id (stale ingress after a hub redeploy) hangs libp2p
// indefinitely — bound every overlay attempt so failure falls through to the
// next route instead of freezing the caller.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

// When the overlay ingress stops answering mid-life (hub redeployed under us),
// re-ask discovery for the current one. Deduped so a burst of failing resolves
// triggers at most one refresh at a time.
let ingressRefreshing = false;
function refreshIngress(): void {
  if (ingressRefreshing) return;
  ingressRefreshing = true;
  void discoverIngress().then((d) => {
    if (d && d !== INGRESS) {
      console.log('[federation-sidecar] ingress refreshed ...' + INGRESS.slice(-24) + ' -> ...' + d.slice(-24));
      INGRESS = d;
    }
  }).finally(() => { ingressRefreshing = false; });
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

// Dispatch-scoped state (activeDispatches, goalWalkState, goal_execution) is
// PER-goal-host in-memory data: "first dialable owner" answers from whichever
// substrate wins the dial race, so a degraded local circuit silently swaps the
// panel onto a foreign goal-host whose store holds none of this vault's
// dispatches (observed: hub list 6h stale rendered as the whole fleet board).
// Two remedies: aggregate polls MERGE all owners' lists (dedup by dispatchId,
// each row tagged resolved_by; any successful subset beats an empty answer),
// and per-dispatch polls PIN to the owner that answered for that dispatch id
// before (learned from prior responses), falling back to the normal failover
// order when the pinned owner stops answering.
const AGGREGATE_MERGE_SHAPES = new Set(['activeDispatches']);
const dispatchOwnerCache = new Map<string, string>(); // dispatchId -> vesselId
const rememberDispatchOwner = (id: unknown, vesselId: string) => {
  if (typeof id !== 'string' || !id || !vesselId) return;
  if (dispatchOwnerCache.size > 500) { const k = dispatchOwnerCache.keys().next().value; if (k) dispatchOwnerCache.delete(k); }
  dispatchOwnerCache.set(id, vesselId);
};
const dispatchIdOf = (pointer: any): string =>
  String(pointer?.dispatchId ?? pointer?.dispatch_id ?? pointer?.executionId ?? pointer?.execution_id ?? '');
const dispatchesOf = (r: any): any[] | null => {
  for (const b of [r?.content?.body, r?.body, r?.content, r]) {
    if (b && typeof b === 'object' && Array.isArray((b as any).dispatches)) return (b as any).dispatches;
  }
  return null;
};

// One owner, full route (overlay circuits first, HTTP fallback) — the same
// order resolveViaDiscoveryHttp uses across owners, scoped to a single owner.
async function resolveViaOwner(owner: ShapeOwner, pointer: any, shape: string): Promise<any> {
  const errors: string[] = [];
  if (vl && resolveViaLibp2pFn) {
    for (const ma of owner.multiaddrs) {
      try {
        const res = await withTimeout(resolveViaLibp2pFn(vl, ma, pointer), 10_000, 'overlay resolve');
        return { shape, resolved_by: owner.vesselId, ok: true, ...(typeof res === 'object' && res !== null ? res : { body: res }) };
      } catch (e) { errors.push(`overlay: ${String((e as Error)?.message ?? e)}`); }
    }
  }
  if (!(isLoopback(owner.base) && owner.multiaddrs.length > 0)) {
    try {
      const res = await fetch(owner.base + owner.resolvePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(12_000),
      });
      const body = await res.json().catch(() => ({}));
      return { shape, resolved_by: owner.vesselId, status: res.status, ok: res.ok, ...(typeof body === 'object' && body !== null ? body : { body }) };
    } catch (e) { errors.push(`http: ${String((e as Error)?.message ?? e)}`); }
  }
  throw new Error(errors.join('; ') || 'no route for owner ' + owner.vesselId);
}

// The board polls every ~7s; an unbounded merge (each owner chain can burn
// overlay 10s + http 12s) stacks overlapping polls and starves the conduit —
// observed as ERR_CONNECTION_RESET/502 in the renderer. Bound each owner chain
// hard and memoise the merged result briefly so overlapping polls coalesce.
const MERGE_OWNER_TIMEOUT_MS = 6_000;
const mergeMemo = new Map<string, { at: number; result: any }>();
async function resolveMergedAcrossOwners(owners: ShapeOwner[], pointer: any, shape: string): Promise<any> {
  const memo = mergeMemo.get(shape);
  if (memo && Date.now() - memo.at < 3_000) return memo.result;
  const settled = await Promise.allSettled(owners.map((o) => withTimeout(resolveViaOwner(o, pointer, shape), MERGE_OWNER_TIMEOUT_MS, 'merge owner ' + o.vesselId)));
  const merged = new Map<string, any>();
  let answered = 0;
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    const rows = dispatchesOf(s.value);
    if (!rows) return;
    answered++;
    for (const row of rows) {
      const id = String(row?.dispatchId ?? '');
      const tagged = { ...row, resolved_by: owners[i]!.vesselId };
      rememberDispatchOwner(id, owners[i]!.vesselId);
      // Newer startedAt wins on id collision (same dispatch mirrored on two hosts).
      const prev = id ? merged.get(id) : undefined;
      if (!prev || Number(row?.startedAt ?? 0) >= Number(prev?.startedAt ?? 0)) merged.set(id || `anon-${i}-${merged.size}`, tagged);
    }
  });
  if (answered === 0) return null; // caller falls through to the single-owner path (its errors are more informative)
  const dispatches = [...merged.values()].sort((a, b) => Number(b?.startedAt ?? 0) - Number(a?.startedAt ?? 0));
  const body = { dispatches, merged_from: answered, owners: owners.length };
  const result = { shape, resolved_by: `merged(${answered}/${owners.length})`, ok: true, content: { shape, produced_by: 'federation-sidecar merge', body }, body };
  mergeMemo.set(shape, { at: Date.now(), result });
  return result;
}

async function resolveViaDiscoveryHttp(pointer: any): Promise<any> {
  const shape = String(pointer?.type ?? '');
  let owners = await lookupShapeOwners(shape);
  if (owners.length === 0) return { error: `no vessel advertises shape "${shape}" in discovery (${DISCOVERY})` };
  // Aggregate views: merge every owner's answer instead of racing to the first.
  if (AGGREGATE_MERGE_SHAPES.has(shape) && owners.length > 1) {
    const merged = await resolveMergedAcrossOwners(owners, pointer, shape);
    if (merged) return merged;
  }
  // Per-dispatch pinning: route to the owner that served this dispatch before.
  const pinned = dispatchOwnerCache.get(dispatchIdOf(pointer));
  if (pinned) owners = [...owners.filter((o) => o.vesselId === pinned), ...owners.filter((o) => o.vesselId !== pinned)];
  const errors: string[] = [];
  // (1) Overlay failover: try each federated instance's circuit(s) until one
  // answers. Several instances serve the same shape and some are offline.
  if (vl && resolveViaLibp2pFn) {
    for (const owner of owners) {
      for (const ma of owner.multiaddrs) {
        try {
          const res = await withTimeout(resolveViaLibp2pFn(vl, ma, pointer), 10_000, 'overlay resolve');
          rememberDispatchOwner((res as any)?.content?.body?.dispatchId ?? (res as any)?.body?.dispatchId ?? dispatchIdOf(pointer), owner.vesselId);
          return { shape, resolved_by: owner.vesselId, ok: true, ...(typeof res === 'object' && res !== null ? res : { body: res }) };
        } catch (e) { errors.push(`overlay ${owner.vesselId}: ${String((e as Error)?.message ?? e)}`); }
      }
    }
  }
  // (2) HTTP fallback. Skip a loopback base ONLY when the owner also has an
  // overlay (multiaddr) route — that owner is overlay-only (its 127.0.0.1 is a
  // host-laundered, off-box-dead address) and was already tried in the overlay
  // loop above. A loopback owner with NO multiaddrs is a host-published HTTP
  // endpoint (e.g. goal-host at 127.0.0.1:18210 on a same-machine host); it is
  // genuinely reachable and is the ONLY route to that shape, so it must be
  // dialed rather than discarded. Without this, multi-owner shapes like
  // fleetActivityFeed resolve to nothing and the panel's metrics/pulse go blank.
  for (const owner of owners) {
    if (isLoopback(owner.base) && owner.multiaddrs.length > 0) continue;
    try {
      const res = await fetch(owner.base + owner.resolvePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: 'ApiKey ' + API_KEY } : {}) },
        body: JSON.stringify({ impulse: { pointer } }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await res.json().catch(() => ({}));
      rememberDispatchOwner((body as any)?.body?.dispatchId ?? (body as any)?.dispatchId ?? dispatchIdOf(pointer), owner.vesselId);
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
          // Dispatch-scoped state must NOT take the ingress shortcut: the hub
          // ingress proxies to ITS OWN goal-host, silently substituting a foreign
          // (often stale) executionStore for this vault's view — the "board shows
          // only old data / no details for other hosts" defect. Route these
          // through the discovery path, which merges all owners (activeDispatches)
          // or pins to the dispatch-owning substrate (goalWalkState et al).
          const DISPATCH_SCOPED = AGGREGATE_MERGE_SHAPES.has(String(pointer.type))
            || ['goalWalkState', 'goal_execution', 'fleetActivityFeed'].includes(String(pointer.type))
            || !!dispatchOwnerCache.get(dispatchIdOf(pointer));
          if (DISPATCH_SCOPED && !body?.target) return corsJson(await resolveViaDiscoveryHttp(pointer));
          if (vl && target) {
            // lpStream first (carries multi-KB hub responses reliably after the
            // sendAll fix); legacy HTTP second; discovery-routed HTTP last.
            // Both attempts are time-bounded: a stale target peer hangs the
            // dial forever, and an unbounded first leg starves every fallback.
            try { return corsJson(await withTimeout(resolveViaLibp2pFn(vl, target, pointer), 10_000, 'overlay resolve')); }
            catch {
              try { return corsJson(await withTimeout(resolveViaHttpFn(vl, target, pointer), 8_000, 'overlay http resolve')); }
              catch { refreshIngress(); /* fall through to discovery routing */ }
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
                const res: any = await withTimeout(resolveViaLibp2pFn(vl, owner.multiaddrs[0], pointer), 10_000, 'overlay resolve');
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
  // Re-derive the circuit every cycle: the reservation can land AFTER
  // initLibp2p's bounded wait (relay down at boot) or change when the relay
  // restarts — a stale/empty value here advertises an undialable row (ma:0)
  // and severs the inbound direction for the life of the process.
  if (vl) {
    const c = vl.advertiseMultiaddrs().find((m: string) => m.includes('p2p-circuit'));
    if (c) circuit = c;
  }
  const resolverShapes = await fetchManifestShapes();
  const shapes = [...Object.keys(ROUTES), ...resolverShapes];
  const shape_descriptions: Record<string, string> = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, v.description]));
  for (const s of resolverShapes) shape_descriptions[s] = `operator-host Obsidian resolver shape "${s}" (proxied to the plugin's /resolve on the operator vault)`;
  // Register with EVERY discovery in the namespace, not only the hub: a
  // spoke's goal-target inference and reach gate read their OWN registry's
  // shape vocabulary, so a vault registered only at the hub is invisible to
  // spoke walks (inferred_target_shapes:[] on every vault goal) even when the
  // circuit is dialable. EXTRA_DISCOVERY_URLS is a comma-separated list of
  // additional discovery endpoints (e.g. the local spoke's :18100).
  // Default the extra list to the conventional local-spoke discovery: the
  // operator host often runs its own substrate, and its walks need the vault's
  // shapes in their OWN vocabulary. Best-effort — a missing local discovery
  // just logs and moves on. Override/extend via EXTRA_DISCOVERY_URLS; set it
  // to "none" to disable.
  const extraRaw = process.env.EXTRA_DISCOVERY_URLS ?? 'http://localhost:18100';
  const discoveries = [...new Set([DISCOVERY, ...(extraRaw === 'none' ? [] : extraRaw
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean))])];
  for (const d of discoveries) {
    try {
      const r = await fetch(d + '/register', {
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
          // Explicit TTL comfortably above the 120s re-register cadence: with
          // the server default the entry can expire in the gap between cycles,
          // making the vault flap out of the registry (and out of hub walks).
          ttl: 300,
        }),
      });
      console.log(`[federation-sidecar] register@${d} -> ${r.status} (${shapes.length} shapes: ${Object.keys(ROUTES).length} named + ${resolverShapes.length} resolver)`);
    } catch (e) {
      console.log(`[federation-sidecar] register@${d} err`, String(e));
    }
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
