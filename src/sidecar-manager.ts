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

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ObsidianVesselSettings } from './settings';

// Injected at build time by esbuild.config.mjs (`define`) from
// sidecar/federation-sidecar.ts and sidecar/package.json, so release installs
// (which ship only main.js/manifest.json/styles.css) can materialize the
// sidecar package on first start.
declare const __SIDECAR_SOURCE__: string;
declare const __SIDECAR_PACKAGE_JSON__: string;

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
    return this.settings.federationDiscoveryUrl || this.settings.discoveryVesselEndpoint || '';
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
    // Always run `bun install`: a no-op when node_modules is complete, and it
    // repairs partial trees left by an interrupted or timed-out install (which
    // otherwise crash the sidecar with "Cannot find package ..." forever).
    this.logger('info', `reconciling sidecar dependencies: ${bunPath} install (cwd=${sidecarDir})`);
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

  private async prepareAndSpawn(): Promise<void> {
    const sidecarDir = this.resolveSidecarDir();
    const scriptPath = path.join(sidecarDir, 'federation-sidecar.ts');
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const bunCandidates = [
      ...(home ? [path.join(home, '.bun', 'bin', 'bun'), path.join(home, '.bun', 'bin', 'bun.exe')] : []),
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
    ];
    const bunPath = this.settings.federationBunPath || bunCandidates.find(p => fs.existsSync(p)) || 'bun';

    const ready = await this.ensureSidecarMaterialized(sidecarDir, bunPath);
    if (this.stopped) return;
    if (!ready) {
      this.scheduleRestart();
      return;
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OBSIDIAN_VESSEL_ID: this.settings.federationVesselId || '',
      RELAY_MULTIADDR: this.settings.federationRelayMultiaddr,
      DISCOVERY_URL: this.discoveryUrl(),
      API_KEY: this.settings.federationApiKey || this.settings.apiKey || '',
      OBSIDIAN_URL: `http://127.0.0.1:${this.opts.serverPort}`,
      FEDERATION_INGRESS_MULTIADDR: this.settings.federationIngressMultiaddr || '',
              OBSIDIAN_PASSTHROUGH_HEALTH_PORT: String(this.settings.federationHealthPort || 8402),
    };

    try {
        const pidPath = path.join(sidecarDir, 'sidecar.pid');
        const stalePid = parseInt(fs.readFileSync(pidPath, 'utf8'), 10);
        if (stalePid > 1) {
          const held = await fetch(`http://127.0.0.1:${this.settings.federationHealthPort || 8402}/health`).then(r => r.ok).catch(() => false);
          if (held) {
            process.kill(stalePid, 'SIGKILL');
            this.logger('info', `killed stale sidecar (pid ${stalePid}) holding the health port`);
            await new Promise(r => setTimeout(r, 300));
          }
          fs.unlinkSync(pidPath);
        }
      } catch { /* no stale sidecar */ }
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

function sidecarBase(settings: ObsidianVesselSettings): string {
  return `http://127.0.0.1:${settings.federationHealthPort || 8402}`;
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
