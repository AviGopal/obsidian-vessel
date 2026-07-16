/**
 * Federation Sidecar Manager
 *
 * Spawns and supervises the libp2p federation sidecar
 * (`sidecar/federation-sidecar.ts`) as a child process. This is what lets the
 * plugin become discoverable/resolvable from a REMOTE substrate hub over a
 * Circuit Relay v2 overlay without bundling libp2p into the plugin's own
 * esbuild bundle — the plugin only manages the process lifecycle; the
 * transport code and its dependencies live entirely in the sibling
 * `sidecar/` package.
 *
 * isDesktopOnly is true for this plugin, so Obsidian runs it in a Node-capable
 * (Electron) context and `child_process` is available (see esbuild.config.mjs
 * — `builtin-modules` are marked external, not bundled).
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { ObsidianVesselSettings } from './settings';

// Injected at build time by esbuild.config.mjs (`define`) from
// sidecar/federation-sidecar.ts and sidecar/package.json, so release installs
// (which ship only main.js/manifest.json/styles.css) can materialize the
// sidecar package on first start.
declare const __SIDECAR_SOURCE__: string;
declare const __SIDECAR_PACKAGE_JSON__: string;
declare const __SIDECAR_BUNDLE__: string;

export interface SidecarManagerOptions {
  /** Absolute path to the vault root. */
  vaultBasePath: string;
  /** Plugin directory, relative to the vault root (or absolute — both handled). */
  pluginDir: string;
  /** Port the plugin's own HTTP server is listening on. */
  serverPort: number;
  /** Log sink; defaults to console with a `[FederationSidecar]` prefix. */
  logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const RESTART_BASE_DELAY_MS = 2000;
const RESTART_MAX_DELAY_MS = 30000;

export class SidecarManager {
  private settings: ObsidianVesselSettings;
  private opts: SidecarManagerOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = true;
  private restartAttempt = 0;
  private forceReinstall = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private logger: NonNullable<SidecarManagerOptions['logger']>;

  constructor(settings: ObsidianVesselSettings, opts: SidecarManagerOptions) {
    this.settings = settings;
    this.opts = opts;
    this.logger = opts.logger || ((level, msg) => console.log(`[FederationSidecar:${level}]`, msg));
  }

  /** Update settings in place (e.g. after the settings tab saves changes). */
  updateSettings(settings: ObsidianVesselSettings): void {
    this.settings = settings;
  }

  /** Discovery URL the sidecar routes through: federation setting first, local substrate discovery otherwise. */
  private discoveryUrl(): string {
    return this.settings.discoveryVesselEndpoint || '';
  }

  start(): void {
    // A configured relay multiaddr implies federation: the toggle stays as an
    // explicit opt-in for local-conduit mode, but setting the relay is enough.
    if (!this.settings.enableFederationSidecar && !this.settings.federationRelayMultiaddr) {
      this.logger('info', 'enableFederationSidecar is off and no relay multiaddr is set — not starting');
      return;
    }
    // A relay is optional: without one the sidecar runs in LOCAL mode as a
    // pure discovery-routed egress conduit. With a relay, the sidecar derives
    // the hub discovery URL from the relay host itself — so a relay multiaddr
    // plus the API key is a complete federation config.
    if (!this.discoveryUrl() && !this.settings.federationRelayMultiaddr) {
      this.logger('warn', 'enableFederationSidecar is on but neither a relay multiaddr nor a discovery URL is set — not starting');
      return;
    }
    this.stopped = false;
    this.restartAttempt = 0;
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 5000);
    }
  }

  /** Stop (if running) and start again — used by the "Restart" settings action. */
  async restart(): Promise<void> {
    this.stop();
    // Give the old process a moment to release its relay reservation/ports.
    await new Promise((r) => setTimeout(r, 500));
    this.start();
  }

  isRunning(): boolean {
    return this.child != null;
  }

  private resolveSidecarDir(): string {
    const { vaultBasePath, pluginDir } = this.opts;
    const pluginDirAbs = path.isAbsolute(pluginDir) ? pluginDir : path.join(vaultBasePath, pluginDir);
    return path.join(pluginDirAbs, 'sidecar');
  }

  /**
   * Materialize the sidecar package into <pluginDir>/sidecar when missing or
   * stale (release installs ship only the plugin bundle — the sidecar sources
   * are embedded at build time and written out here), then `bun install` its
   * dependencies when node_modules is absent. Returns false on failure.
   */
  private async ensureSidecarMaterialized(sidecarDir: string, bunPath: string): Promise<boolean> {
    try {
      fs.mkdirSync(sidecarDir, { recursive: true });
      // Vendored single-file sidecar (all deps bundled at plugin build time):
      // write it and return — no bun install on the user's machine at all.
      // Empty/missing in older builds, which fall through to source + install.
      if (typeof __SIDECAR_BUNDLE__ !== 'undefined' && __SIDECAR_BUNDLE__.length > 0) {
        const bundlePath = path.join(sidecarDir, 'federation-sidecar.bundle.js');
        if (!fs.existsSync(bundlePath) || fs.readFileSync(bundlePath, 'utf8') !== __SIDECAR_BUNDLE__) {
          fs.writeFileSync(bundlePath, __SIDECAR_BUNDLE__);
        }
        return true;
      }
      const scriptPath = path.join(sidecarDir, 'federation-sidecar.ts');
      const pkgPath = path.join(sidecarDir, 'package.json');
      // Builds made before the esbuild define embed ship without the sidecar
      // source; fall back to files already on disk (install.sh copies them)
      // instead of crashing the materialization with a ReferenceError.
      const embedded = typeof __SIDECAR_SOURCE__ !== 'undefined' && typeof __SIDECAR_PACKAGE_JSON__ !== 'undefined';
      if (embedded) {
        if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, 'utf8') !== __SIDECAR_SOURCE__) {
          fs.writeFileSync(scriptPath, __SIDECAR_SOURCE__);
        }
        if (!fs.existsSync(pkgPath) || fs.readFileSync(pkgPath, 'utf8') !== __SIDECAR_PACKAGE_JSON__) {
          fs.writeFileSync(pkgPath, __SIDECAR_PACKAGE_JSON__);
        }
      } else if (!fs.existsSync(scriptPath) || !fs.existsSync(pkgPath)) {
        this.logger('error', 'sidecar source not embedded in this build and not present on disk — reinstall via install.sh or rebuild the plugin');
        return false;
      } else {
        this.logger('info', 'using on-disk sidecar sources (build has no embedded copy)');
      }
    } catch (err) {
      this.logger('error', `sidecar materialization failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (this.forceReinstall) {
      // A module-resolution crash means the tree is broken in a way plain
      // `bun install` (and on Windows even --force) may not repair — remove
      // node_modules and the lockfile so the reinstall is a clean rebuild.
      try {
        fs.rmSync(path.join(sidecarDir, 'node_modules'), { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        fs.rmSync(path.join(sidecarDir, 'bun.lock'), { force: true });
        this.logger('warn', 'removed sidecar node_modules + bun.lock for a clean reinstall');
      } catch (err) {
        this.logger('warn', `could not fully remove node_modules (${err instanceof Error ? err.message : String(err)}) — continuing with bun install --force`);
      }
    }
    // Always run `bun install`: a no-op when node_modules is complete, and it
    // repairs partial trees left by an interrupted or timed-out install (which
    // otherwise crash the sidecar with "Cannot find package ..." forever).
    this.logger('info', `reconciling sidecar dependencies: ${bunPath} install${this.forceReinstall ? ' --force' : ''} (cwd=${sidecarDir})`);
    return await new Promise<boolean>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bunPath, this.forceReinstall ? ['install', '--force'] : ['install'], { cwd: sidecarDir, stdio: 'pipe' });
      } catch (err) {
        this.logger('error', `failed to run bun install: ${err instanceof Error ? err.message : String(err)}`);
        resolve(false);
        return;
      }
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 600_000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) this.forceReinstall = false;
        if (code !== 0) this.logger('error', `bun install exited with ${code}: ${stderr.slice(-500)}`);
        resolve(code === 0);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this.logger('error', `bun install error: ${err.message}`);
        resolve(false);
      });
    });
  }

  private spawnChild(): void {
    void this.prepareAndSpawn();
  }

  /**
   * Ordered bun discovery. Obsidian is a GUI app, so its PATH is stripped of
   * everything the user's shell profile adds (~/.bun, nvm, homebrew on some
   * setups) — a bare `spawn('bun', ...)` fails on exactly the machines that
   * installed bun the normal way. Probe, in order:
   *   (a) the explicit `federationBunPath` settings override,
   *   (b) `which bun` against the user's REAL path (login shell, then plain),
   *   (c) ~/.bun/bin/bun (the official installer location),
   *   (d) the newest ~/.nvm/versions/node/<version>/bin/bun (version-sorted),
   *   (e) the static well-known locations.
   * Returns null when nothing is found, logging every path probed; the winner
   * and its source are logged so a wrong pick is diagnosable from the console.
   */
  private discoverBunPath(): string | null {
    const probed: string[] = [];
    const exists = (p: string): boolean => {
      probed.push(p);
      try { return fs.existsSync(p); } catch { return false; }
    };
    const won = (source: string, p: string): string => {
      this.logger('info', `bun resolved via ${source}: ${p}`);
      return p;
    };

    // (a) explicit settings override ('bun' is the "resolve it for me" default).
    const configured = (this.settings.federationBunPath || '').trim();
    if (configured && configured !== 'bun') {
      if (exists(configured)) return won('settings override (federationBunPath)', configured);
      this.logger('warn', `federationBunPath is set to ${configured} but nothing exists there — continuing discovery`);
    }

    // (b) which/where against the user's real PATH. A login shell (-l) sources
    // the user's profile, recovering PATH entries the GUI launch stripped.
    if (process.platform === 'win32') {
      probed.push('where bun');
      try {
        const r = spawnSync('where', ['bun'], { encoding: 'utf8', timeout: 10_000 });
        const found = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
        if (r.status === 0 && found && fs.existsSync(found)) return won('where bun', found);
      } catch { /* keep probing */ }
    } else {
      const shell = process.env.SHELL || '/bin/sh';
      for (const flag of ['-lc', '-c']) {
        probed.push(`${shell} ${flag} "which bun"`);
        try {
          const r = spawnSync(shell, [flag, 'which bun'], { encoding: 'utf8', timeout: 10_000 });
          const found = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
          if (r.status === 0 && found.startsWith('/') && fs.existsSync(found)) {
            return won(`which bun (${shell} ${flag})`, found);
          }
        } catch { /* keep probing */ }
      }
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';

    // (c) the official bun installer location.
    if (home) {
      for (const cand of [path.join(home, '.bun', 'bin', 'bun'), path.join(home, '.bun', 'bin', 'bun.exe')]) {
        if (exists(cand)) return won('~/.bun/bin', cand);
      }
    }

    // (d) nvm-managed node trees (bun installed via `npm i -g bun` lands
    // here); both the classic layout (~/.nvm/versions/node/<v>/bin) and the
    // nvm.fish layout (~/.local/share/nvm/<v>/bin) are scanned, newest
    // version first so a stale tree never shadows the current one.
    if (home) {
      const parse = (v: string): number[] =>
        (v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0));
      for (const nvmDir of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.local', 'share', 'nvm')]) {
        try {
          const versions = fs.readdirSync(nvmDir)
            .filter((d) => /^v\d+(\.\d+)*$/.test(d))
            .sort((a, b) => {
              const [pa, pb] = [parse(a), parse(b)];
              for (let i = 0; i < 3; i++) { if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0); }
              return 0;
            });
          for (const v of versions) {
            const cand = path.join(nvmDir, v, 'bin', 'bun');
            if (exists(cand)) return won(`nvm (${nvmDir}, ${v})`, cand);
          }
        } catch { probed.push(path.join(nvmDir, '<none readable>')); }
      }
    }

    // (e) static well-known locations.
    for (const cand of ['/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
      if (exists(cand)) return won('static candidate', cand);
    }

    this.logger('error', `bun not found — probed: ${probed.join(', ')}`);
    return null;
  }

  private async prepareAndSpawn(): Promise<void> {
    const sidecarDir = this.resolveSidecarDir();
    const bunPath = this.discoverBunPath();
    if (bunPath === null) {
      this.scheduleRestart();
      return;
    }

    const ready = await this.ensureSidecarMaterialized(sidecarDir, bunPath);
    if (this.stopped) return;
    if (!ready) {
      this.scheduleRestart();
      return;
    }
    const bundlePath = path.join(sidecarDir, 'federation-sidecar.bundle.js');
    const scriptPath = fs.existsSync(bundlePath) ? bundlePath : path.join(sidecarDir, 'federation-sidecar.ts');

    // Clear our own stale sidecar (recorded pid) if it survived a previous
    // session, then pick the health port: the configured one when free,
    // otherwise walk forward — a port held by a process we don't own (second
    // vault, unrelated listener) must never block this plugin's own sidecar.
    const desiredPort = this.settings.federationHealthPort || 8402;
    const pidPath = path.join(sidecarDir, 'sidecar.pid');
    if (!(await portIsFree(desiredPort))) {
      try {
        const stalePid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
        if (stalePid > 1) {
          process.kill(stalePid, 'SIGKILL');
          this.logger('info', `killed stale sidecar (pid ${stalePid}) holding port ${desiredPort}`);
          await new Promise(r => setTimeout(r, 300));
        }
      } catch { /* no pid file, or the process is not ours to kill */ }
    }
    try { fs.unlinkSync(pidPath); } catch { /* absent */ }
    let healthPort = desiredPort;
    if (!(await portIsFree(desiredPort))) {
      let found = 0;
      for (let p = desiredPort + 1; p <= desiredPort + 20; p++) {
        if (await portIsFree(p)) { found = p; break; }
      }
      if (!found) {
        this.logger('error', `no free health port in ${desiredPort}-${desiredPort + 20} — retrying later`);
        this.scheduleRestart();
        return;
      }
      healthPort = found;
      this.logger('warn', `health port ${desiredPort} is held by another process — using ${healthPort} for this session`);
    }
    setActiveSidecarPort(healthPort);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OBSIDIAN_VESSEL_ID: this.settings.vesselId || '',
      RELAY_MULTIADDR: this.settings.federationRelayMultiaddr,
      DISCOVERY_URL: this.discoveryUrl(),
      API_KEY: this.settings.apiKey || '',
      OBSIDIAN_URL: `http://127.0.0.1:${this.opts.serverPort}`,
      FEDERATION_INGRESS_MULTIADDR: this.settings.federationIngressMultiaddr || '',
      OBSIDIAN_PASSTHROUGH_HEALTH_PORT: String(healthPort),
    };

    this.logger('info', `spawning sidecar: ${bunPath} ${scriptPath} (cwd=${sidecarDir})`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bunPath, [scriptPath], { cwd: sidecarDir, env, stdio: 'pipe' });
    } catch (err) {
      this.logger('error', `failed to spawn sidecar: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    try { fs.writeFileSync(path.join(sidecarDir, 'sidecar.pid'), String(child.pid)); } catch { /* best effort */ }

    let recentStderr = '';
    this.child.stdout?.on('data', (chunk: Buffer) => this.logger('info', chunk.toString().trimEnd()));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      recentStderr = (recentStderr + chunk.toString()).slice(-4000);
      this.logger('warn', chunk.toString().trimEnd());
    });

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (/Cannot find (package|module)/i.test(recentStderr)) {
        this.forceReinstall = true;
        this.logger('warn', 'sidecar crashed on module resolution — forcing bun install --force on next start to repair node_modules');
      }
      this.logger('warn', `sidecar exited (code=${code}, signal=${signal}) — restarting`);
      this.scheduleRestart();
    });

    child.on('error', (err) => {
      this.logger('error', `sidecar process error: ${err.message}`);
    });
    setTimeout(() => { if (this.child === child && !this.stopped) this.restartAttempt = 0; }, 60_000);
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    const delay = Math.min(RESTART_BASE_DELAY_MS * Math.pow(2, this.restartAttempt), RESTART_MAX_DELAY_MS);
    this.restartAttempt++;
    this.restartTimer = setTimeout(() => {
      if (!this.stopped) this.spawnChild();
    }, delay);
  }
}


// ============================================================================
// Sidecar egress client — the plugin's single substrate conduit.
//
// All outbound substrate communication routes through the federation
// sidecar's loopback API (see ../sidecar/federation-sidecar.ts). The sidecar
// holds the API key and the discovery URL, resolves the vessel owning any
// shape via discovery, and forwards the request with auth attached — so the
// plugin needs no per-service endpoints or keys. Works identically whether
// the sidecar is federated (relay overlay) or local (discovery-routed HTTP).
//
// Every helper fails soft (null / false) so callers can fall back to their
// legacy direct paths where those still work.
// ============================================================================

export interface SidecarHttpRequest {
  /** Route to a fixed service the sidecar knows natively (currently 'discovery'). */
  service?: 'discovery';
  /** Route to whichever vessel advertises this shape in discovery. */
  shape?: string;
  /** HTTP method; defaults to GET (POST when body is set). */
  method?: string;
  /** Path on the target vessel, e.g. '/v2/goal-paths/stats'. */
  path: string;
  /** JSON body. */
  body?: unknown;
}

export interface SidecarHttpResult {
  status: number;
  ok: boolean;
  via?: string;
  body: any;
}

// The port the running sidecar actually bound (may differ from settings when
// the configured port was held and the manager walked to a free one).
let activeSidecarPort: number | null = null;
export function setActiveSidecarPort(port: number): void { activeSidecarPort = port; }
export function getActiveSidecarPort(settings: ObsidianVesselSettings): number {
  return activeSidecarPort || settings.federationHealthPort || 8402;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function sidecarBase(settings: ObsidianVesselSettings): string {
  return `http://127.0.0.1:${getActiveSidecarPort(settings)}`;
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve an impulse pointer via the sidecar (overlay or discovery-routed). */
export async function sidecarResolve(
  settings: ObsidianVesselSettings,
  pointer: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any | null> {
  return postJson(`${sidecarBase(settings)}/outbound/resolve`, { pointer }, timeoutMs);
}

/** Forward a plain REST request to the vessel owning a shape (or to discovery). */
export async function sidecarHttp(
  settings: ObsidianVesselSettings,
  req: SidecarHttpRequest,
  timeoutMs = 30_000,
): Promise<SidecarHttpResult | null> {
  const r = await postJson(`${sidecarBase(settings)}/outbound/http`, req, timeoutMs);
  return r && typeof r.status === 'number' ? (r as SidecarHttpResult) : null;
}

/**
 * Settings-free variant of sidecarHttp for clients constructed with a bare
 * endpoint string (api-client, goal-host-client, concept-db-client): routes
 * via the module-tracked actually-bound sidecar port. Returns null when the
 * sidecar is not up, so callers fall back to their direct endpoint.
 */
export async function sidecarHttpAuto(
  req: SidecarHttpRequest,
  timeoutMs = 30_000,
): Promise<SidecarHttpResult | null> {
  const r = await postJson(`http://127.0.0.1:${activeSidecarPort || 8402}/outbound/http`, req, timeoutMs);
  return r && typeof r.status === 'number' ? (r as SidecarHttpResult) : null;
}

/**
 * Settings-free variant of sidecarResolve for clients constructed with a bare
 * endpoint string (concept-db-client et al.): POSTs { pointer } to the
 * sidecar's /outbound/resolve, which crosses the federation overlay
 * (lpStream -> HTTP-over-libp2p -> discovery-routed HTTP). Returns the
 * resolved JSON, or null when the sidecar is not up or the resolve failed -
 * callers treat null as "engage explicit fallback".
 */
export async function sidecarResolveAuto(
  pointer: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<any | null> {
  return postJson(`http://127.0.0.1:${activeSidecarPort || 8402}/outbound/resolve`, { pointer }, timeoutMs);
}

/**
 * Pseudo-HTTP outcome of a sidecar resolve, normalized across every transport
 * envelope the conduit can hand back (verified against the live surfaces):
 *  - federation-transport (overlay lpStream): the owner's response arrives as
 *    { content: { shape, produced_by, body, ... }, metadata } — no HTTP status
 *    survives the stream, so one is inferred from the body's error text.
 *  - discovery-routed HTTP: { shape, resolved_by, status, ok, ...ownerResponse }
 *    with goal-host-style owners nesting their payload under `body`.
 *  - v2 vessels answering { content, metadata } verbatim.
 * null means the sidecar itself was unreachable or could not route AT ALL —
 * callers treat that as "engage the (logged) direct fallback", while a non-null
 * !ok outcome is an answer from the owner and must NOT be retried directly.
 */
export interface SidecarResolveOutcome {
  ok: boolean;
  status: number;
  body: unknown;
}

export async function sidecarResolveOutcome(
  pointer: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<SidecarResolveOutcome | null> {
  const r = await sidecarResolveAuto(pointer, timeoutMs);
  if (r === null || typeof r !== 'object') return null;
  const rec = r as Record<string, unknown>;

  // Transport-level failure: the sidecar could not route the pointer at all
  // (no owner in discovery, overlay + HTTP both failed). Same contract as a
  // down sidecar — the caller's direct fallback is the only remaining path.
  if ('error' in rec && !('content' in rec) && !('body' in rec)) return null;

  const errStatus = (errText: string): number =>
    /not.?found|unknown (solicitation|dispatch|shape|execution)|expired/i.test(errText) ? 404 : 500;

  // Federation-transport envelope.
  const outer = rec.content;
  if (
    outer && typeof outer === 'object' && !Array.isArray(outer) &&
    'produced_by' in (outer as Record<string, unknown>) &&
    'body' in (outer as Record<string, unknown>)
  ) {
    const o = outer as Record<string, unknown>;
    const inner = o.body;
    const errText =
      inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).error === 'string'
        ? String((inner as Record<string, unknown>).error)
        : '';
    const status = typeof o.status === 'number' ? o.status : errText ? errStatus(errText) : 200;
    return { ok: !errText && status < 400, status, body: inner };
  }

  // Discovery-routed HTTP (status/ok survive).
  if (typeof rec.status === 'number' || typeof rec.ok === 'boolean') {
    const status = typeof rec.status === 'number' ? rec.status : rec.ok === false ? 500 : 200;
    return { ok: rec.ok !== false && status < 400, status, body: 'body' in rec ? rec.body : rec };
  }

  // v2 { content, metadata } verbatim.
  if ('content' in rec) {
    const failed = 'error' in rec;
    return { ok: !failed, status: failed ? 500 : 200, body: rec.content };
  }
  const failed = 'error' in rec;
  return { ok: !failed, status: failed ? errStatus(String(rec.error ?? '')) : 200, body: rec };
}

/**
 * Convenience over sidecarResolveOutcome for read shapes: the owner's response
 * BODY as an object on success ({} when the owner answered with a non-object
 * body), null when the sidecar was unreachable OR the owner answered with an
 * error — callers then engage their explicit, logged fallback.
 */
export async function sidecarResolveBody(
  pointer: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const outcome = await sidecarResolveOutcome(pointer, timeoutMs);
  if (!outcome || !outcome.ok) return null;
  if (outcome.body && typeof outcome.body === 'object' && !Array.isArray(outcome.body)) {
    return outcome.body as Record<string, unknown>;
  }
  return {};
}

/** True when the sidecar's loopback API is reachable. */
export async function sidecarAvailable(settings: ObsidianVesselSettings): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${sidecarBase(settings)}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
