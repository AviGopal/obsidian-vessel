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
import * as path from 'path';
import { ObsidianVesselSettings } from './settings';

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

  start(): void {
    if (!this.settings.enableFederationSidecar) {
      this.logger('info', 'enableFederationSidecar is off — not starting');
      return;
    }
    if (!this.settings.federationRelayMultiaddr || !this.settings.federationDiscoveryUrl) {
      this.logger('warn', 'enableFederationSidecar is on but federationRelayMultiaddr/federationDiscoveryUrl are unset — not starting');
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

  private spawnChild(): void {
    const sidecarDir = this.resolveSidecarDir();
    const scriptPath = path.join(sidecarDir, 'federation-sidecar.ts');
    const bunPath = this.settings.federationBunPath || 'bun';

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OBSIDIAN_VESSEL_ID: this.settings.federationVesselId || 'obsidian-host-vessel',
      RELAY_MULTIADDR: this.settings.federationRelayMultiaddr,
      DISCOVERY_URL: this.settings.federationDiscoveryUrl,
      API_KEY: this.settings.federationApiKey || this.settings.apiKey || '',
      OBSIDIAN_URL: `http://127.0.0.1:${this.opts.serverPort}`,
      OBSIDIAN_PASSTHROUGH_HEALTH_PORT: String(this.settings.federationHealthPort || 8402),
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

    child.stdout?.on('data', (chunk: Buffer) => this.logger('info', chunk.toString().trimEnd()));
    child.stderr?.on('data', (chunk: Buffer) => this.logger('warn', chunk.toString().trimEnd()));

    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.logger('warn', `sidecar exited (code=${code}, signal=${signal}) — restarting`);
      this.scheduleRestart();
    });

    child.on('error', (err) => {
      this.logger('error', `sidecar process error: ${err.message}`);
    });

    this.restartAttempt = 0;
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
