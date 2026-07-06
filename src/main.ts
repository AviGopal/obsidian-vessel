import { App, Plugin, PluginManifest, TFile, Notice, requestUrl } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import { GoalDispatchView, VIEW_TYPE_GOAL_DISPATCH } from './views/goal-dispatch-view';
import { GoalInputModal } from './views/goal-input-modal';
import { ObsidianVesselSettings, DEFAULT_SETTINGS } from './settings';
import { ObsidianVesselSettingTab } from './settings-tab';
import { HTTPServer } from './server/index';
import { sendJson, sendError, parseJsonBody } from './server/routes';
import { VesselClient } from './vessel-client';
import { SidecarManager } from './sidecar-manager';
import { ActivityAPIClient } from './api-client';
import { SyncService } from './sync/index';
import { ConceptSyncService, makeObsidianNoteWriter } from './sync/concept-sync';
import { ConceptWritebackService } from './sync/concept-writeback';
import { ConceptBusListener } from './sync/concept-bus-listener';
import { ActivityFamilySyncService } from './sync/activity-family-sync';
import { VesselSyncService } from './sync/vessel-sync';
import { syncImprovements } from './sync/improvement-sync';
import { ConceptDbClient } from './concept-db-client';
import { ExecutionCanvasBuilder } from './canvas/index';
import { ConceptCanvasBuilder } from './canvas/concept-canvas';
import { ExecutionFormatter, TemplateFormatter } from './formatters/index';
import { StatusBarManager } from './status-bar';
import { registerCommands } from './commands';
import { resolve, listResolverTypes } from './resolvers/index';
import { ExecutionTrace, ActivityTemplate } from './types';
import type { ImpulsePointer, ResolverResult } from './resolvers/types';

// Augment Obsidian's App type to include commands API
declare module 'obsidian' {
  interface App {
    commands: {
      commands: Record<string, { id: string; name: string }>;
      executeCommandById(id: string): boolean;
    };
    setting: {
      open(): void;
      openTabById(id: string): void;
    };
  }
}

// Import all resolvers to register them
// These modules self-register with the resolver registry on import
import './resolvers/note-resolver';
import './resolvers/search-resolver';
import './resolvers/canvas-resolver';
import './resolvers/backlinks-resolver';
import './resolvers/frontmatter-resolver';
import './resolvers/daily-note-resolver';
import './resolvers/graph-resolver';
import './resolvers/concept-view-resolver';
import './resolvers/concept-writeback-resolver';
import './resolvers/observe-obsidian-events';
import './resolvers/group-interaction-episodes';
import './resolvers/probe-obsidian-action-effects';
import './resolvers/execute-command';
import './resolvers/command-catalog';
import './resolvers/workspace-resolvers';
import './resolvers/concept-sync-resolvers';
import './resolvers/write-note-resolver';
import './resolvers/ui-view-resolver';
import { setPresenceRhythmContext } from './resolvers/presence-rhythm-resolver';
import { setConceptDbResolverContext } from './resolvers/concept-view-resolver';
import { setConceptWritebackResolverContext } from './resolvers/concept-writeback-resolver';
import {
  setObserveObsidianEventsContext,
  setSubstrateWritePrefixes,
  startObserveObsidianEvents,
  stopObserveObsidianEvents,
} from './resolvers/observe-obsidian-events';
import { setGroupInteractionEpisodesContext } from './resolvers/group-interaction-episodes';
import { ObsidianEventLog } from './resolvers/observation-types';
import { VaultTouchLedger } from './server/vault-touch-ledger';
import { SolicitationManager } from './solicitations/solicitation-manager';

/**
 * Current status of the vessel plugin
 */
export interface VesselStatus {
  /** Whether connected to the activity API */
  apiConnected: boolean;
  /** Whether realtime sync is connected */
  realtimeConnected: boolean;
  /** Whether the HTTP server is running */
  serverRunning: boolean;
  /** ISO timestamp of last successful sync */
  lastSyncedAt: string | null;
  /** Number of executions synced */
  syncedCount: number;
  /** Number of impulse resolutions performed */
  resolutionCount: number;
  /** Whether a sync is currently in progress */
  syncing: boolean;
}

/**
 * Obsidian Vessel Plugin for Obsidian
 *
 * This plugin transforms Obsidian into a vessel for the Obsidian activity system,
 * enabling:
 * - Impulse resolution from vault content (notes, search, canvas, backlinks, etc.)
 * - Execution trace syncing and visualization
 * - Activity template management
 * - Real-time activity monitoring
 *
 * Architecture:
 * - HTTPServer: Exposes impulse resolution endpoints to external systems
 * - VesselClient: Registers with activity-api and maintains heartbeat
 * - SyncService: Syncs execution traces bidirectionally
 * - Resolvers: Type-specific impulse resolution (note, search, canvas, etc.)
 */
export default class ObsidianVesselPlugin extends Plugin {
  settings: ObsidianVesselSettings;

  // Services
  httpServer: HTTPServer | null = null;
  vesselClient: VesselClient | null = null;
  sidecarManager: SidecarManager | null = null;
  apiClient: ActivityAPIClient | null = null;
  syncService: SyncService | null = null;
  canvasBuilder: ExecutionCanvasBuilder | null = null;
  conceptCanvasBuilder: ConceptCanvasBuilder | null = null;
  statusBarManager: StatusBarManager | null = null;

  // Concept-DB frontend services
  conceptDbClient: ConceptDbClient | null = null;
  conceptSync: ConceptSyncService | null = null;
  conceptWriteback: ConceptWritebackService | null = null;
  conceptBusListener: ConceptBusListener | null = null;

  // Activity Family and Vessel sync services
  activityFamilySync: ActivityFamilySyncService | null = null;
  vesselSync: VesselSyncService | null = null;

  // Phase 1 observation layer — shared event log + workspace observer.
  // The log is bounded (cap = 10_000) and survives plugin lifetime so
  // both the windowing and probe resolvers see the same events.
  obsidianEventLog: ObsidianEventLog | null = null;
  private stopObservation: (() => void) | null = null;

  // Vault-touch ledger: in-memory record of every substrate resolve against
  // this vault (read via obsidian:vault_touches; pulsed on the status bar).
  vaultTouchLedger: VaultTouchLedger | null = null;

  // Human-as-resolver (WS5): pending solicitations awaiting the human's answer,
  // rendered as cards in the goal-dispatch panel.
  solicitationManager: SolicitationManager | null = null;

  // Formatters
  executionFormatter: ExecutionFormatter | null = null;
  templateFormatter: TemplateFormatter | null = null;

  // State
  private startTime: number = Date.now();
  private resolutionCount: number = 0;
  private syncing: boolean = false;

  /**
   * Plugin load lifecycle
   *
   * Initialization phases are ordered by dependency:
   * 1. Settings must load first (everything depends on config)
   * 2. Formatters are stateless, can initialize early
   * 3. API client needed for vessel client and sync
   * 4. Vessel client registers us with the backend
   * 5. HTTP server exposes resolution endpoints
   * 6. Sync service needs API client
   * 7. Canvas builder needs app and settings
   * 8. UI components (settings tab, commands, status bar)
   * 9. Initial sync (delayed to let Obsidian finish loading)
   */
  private improvementSyncTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Substrate-improvement note: PULLED on an interval by the plugin
   * (never pushed by the substrate, never in the boredom rotation).
   * Restores the substrate-authored e985897 wiring, completed with the
   * settings fields and the syncImprovements implementation it required.
   */
  private scheduleImprovementSync(): void {
    if (this.improvementSyncTimer !== null) {
      clearInterval(this.improvementSyncTimer);
      this.improvementSyncTimer = null;
    }
    if (!this.settings.enableImprovementSync) return;
    const intervalMs = Math.max(5, this.settings.improvementSyncIntervalMinutes) * 60 * 1000;
    const writeNote = async (path: string, content: string): Promise<void> => {
      const { TFile } = await import('obsidian');
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        const folder = path.substring(0, path.lastIndexOf('/'));
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
          try {
            await this.app.vault.createFolder(folder);
          } catch {
            // may have been created concurrently
          }
        }
        await this.app.vault.create(path, content);
      }
    };
    syncImprovements(this.settings, writeNote).catch((e: unknown) =>
      console.error('[obsidian-vessel] improvement sync error', e)
    );
    this.improvementSyncTimer = setInterval(() => {
      syncImprovements(this.settings, writeNote).catch((e: unknown) =>
        console.error('[obsidian-vessel] improvement sync error', e)
      );
    }, intervalMs);
  }

  async onload() {
    console.log('[Obsidian Vessel] Loading plugin...');

    // Phase 1: Load settings
    // Settings must be loaded first as all other components depend on configuration
    await this.loadSettings();

    // Phase 2: Initialize formatters
    // Formatters are stateless utilities, safe to initialize early
    this.executionFormatter = new ExecutionFormatter(this.settings);
    this.templateFormatter = new TemplateFormatter();

    // Phase 3: Initialize API client
    // API client is needed for vessel registration and sync
    this.apiClient = new ActivityAPIClient(
      this.settings.activityApiUrl,
      this.settings.apiKey
    );

    // Phase 4: Initialize vessel client
    // Manages our registration with the activity-api backend
    this.vesselClient = new VesselClient(this.settings);

    // Phase 5: Start HTTP server (if enabled)
    // Server must start before registration so we can receive resolution requests
    if (this.settings.serverEnabled) {
      await this.startHTTPServer();
    }

    // Phase 6: Register with activity-api
    // This makes us discoverable to other vessels and the backend
    await this.registerVessel();

    // Phase 6b: Start the federation sidecar (opt-in)
    // Makes this plugin reachable from a REMOTE substrate hub over a libp2p
    // relay circuit, in addition to the local-container registration above.
    if (this.settings.enableFederationSidecar) {
      this.startFederationSidecar();
    }

    // Phase 7: Initialize sync service
    // Sync service handles bidirectional execution trace synchronization
    this.syncService = new SyncService(
      this.app,
      this.settings,
      this.apiClient,
      this,
      this.executionFormatter!
    );
    await this.syncService.initialize();

    // Phase 8: Initialize canvas builder
    // Canvas builder creates visual execution graphs
    this.canvasBuilder = new ExecutionCanvasBuilder(this.app, this.settings);
    this.conceptCanvasBuilder = new ConceptCanvasBuilder(this.app, this.settings);

    // Phase 8b: Initialize concept-db frontend (opt-in)
    if (this.settings.enableConceptDbSync) {
      await this.initializeConceptDbFrontend();
    }

    // Phase 8c-ext: Activity Family and Vessel sync services (opt-in)
    if (this.settings.enableActivityFamilySync && this.apiClient) {
      this.activityFamilySync = new ActivityFamilySyncService(this.app, this.settings, this.apiClient);
      await this.activityFamilySync.start();
    }
    if (this.settings.enableVesselSync) {
      this.vesselSync = new VesselSyncService(this.app, this.settings);
      await this.vesselSync.start();
    }

    // Substrate-improvement note (see sync/improvement-sync.ts)
    this.scheduleImprovementSync();

    // Phase 8c: Phase 1 observation layer.
    // Always on — the resolvers are inert until queried, and the
    // workspace subscriptions feed the shared event log so downstream
    // activities (`group-interaction-episodes`,
    // `probe-obsidian-action-effects`) have data to consume.
    this.initializeObservationLayer();
    this.startPresenceAdvertiser();

    // Phase 8d: Goal verdict watcher — closes the human feedback loop from
    // goal notes into the oracle corpus (goal_verification_labels). When a
    // completed Goals/<executionId>.md note gets a human_verdict frontmatter
    // value, forward it as a goal_verification_label_write impulse.
    this.registerEvent(
      this.app.metadataCache.on('changed', (file, _data, cache) => {
        void this.handleGoalVerdictChange(file, cache);
      }),
    );

    // Phase 9: Register UI components
    // Settings tab for configuration
    this.addSettingTab(new ObsidianVesselSettingTab(this.app, this));

    // Register Goal Dispatch sidebar view
    this.registerView(
      VIEW_TYPE_GOAL_DISPATCH,
      (leaf) => new GoalDispatchView(leaf, this),
    );

    // Register all commands (sync, status, create note, etc.)
    registerCommands(this);

    // Register goal dispatch command
    if (this.settings.enableGoalDispatch) {
      this.addCommand({
        id: 'dispatch-goal',
        name: 'Dispatch goal to substrate',
        callback: () => {
          new GoalInputModal(this.app, async (goal) => {
            await this.activateGoalDispatchView();
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GOAL_DISPATCH);
            const leaf = leaves[0];
            if (leaf && leaf.view instanceof GoalDispatchView) {
              await (leaf.view as GoalDispatchView).dispatchGoal(goal);
            }
          }).open();
        },
      });
    }

    // Commands for activity family and vessel sync
    this.addCommand({
      id: 'sync-activity-families',
      name: 'Sync Activity Families',
      callback: async () => {
        if (!this.activityFamilySync) {
          new Notice('Activity Family Sync is not enabled (check settings)');
          return;
        }
        try {
          await this.activityFamilySync.syncAll();
          new Notice('Activity families synced');
        } catch (err) {
          new Notice(`Activity family sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.addCommand({
      id: 'sync-vessels',
      name: 'Sync Vessels',
      callback: async () => {
        if (!this.vesselSync) {
          new Notice('Vessel Sync is not enabled (check settings)');
          return;
        }
        try {
          await this.vesselSync.syncAll();
          new Notice('Vessels synced');
        } catch (err) {
          new Notice(`Vessel sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    this.addCommand({
      id: 'rebuild-vault',
      name: 'Rebuild Vault (force re-sync all concept notes)',
      callback: async () => {
        if (!this.conceptSync) {
          new Notice('Concept DB sync is not enabled (check settings)');
          return;
        }
        new Notice('Rebuilding vault — re-syncing all concept notes...');
        try {
          const result = await this.conceptSync.forceRebuild(this.app);
          new Notice(`Vault rebuilt: ${result.rebuilt} notes updated`);
        } catch (err) {
          new Notice(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    // Phase 10: Setup status bar
    // Status bar shows connection state and sync status
    const statusBarEl = this.addStatusBarItem();
    this.statusBarManager = new StatusBarManager(this, statusBarEl);
    this.statusBarManager.start();

    // Phase 11: Add ribbon icons
    // Existing: quick access to status command
    this.addRibbonIcon('activity', 'Obsidian Vessel', () => {
      // Execute the status command when clicked
      const command = this.app.commands.commands['obsidian-vessel:status'];
      if (command) {
        this.app.commands.executeCommandById('obsidian-vessel:status');
      }
    });

    // Goal dispatch ribbon icon
    if (this.settings.enableGoalDispatch) {
      this.addRibbonIcon('bot', 'Goal Dispatch', () => {
        this.activateGoalDispatchView();
      });
    }

    // Phase 12: Initial sync (if configured)
    // Delay to let Obsidian fully initialize its workspace
    if (this.settings.syncOnStart) {
      setTimeout(() => {
        this.syncService?.syncHistorical().catch(error => {
          console.error('[Obsidian Vessel] Initial sync failed:', error);
        });
      }, 2000);
    }

    console.log('[Obsidian Vessel] Plugin loaded successfully');
    console.log(`[Obsidian Vessel] Registered resolver types: ${listResolverTypes().join(', ')}`);
  }

  /**
   * Plugin unload lifecycle
   *
   * Graceful shutdown sequence:
   * 1. Stop status bar updates
   * 2. Deregister from backend (removes heartbeat)
   * 3. Cleanup sync service (close WebSocket, etc.)
   * 4. Stop HTTP server
   */
  async onunload() {
    if (this.improvementSyncTimer !== null) {
      clearInterval(this.improvementSyncTimer);
      this.improvementSyncTimer = null;
    }

    console.log('[Obsidian Vessel] Unloading plugin...');

    // Stop status bar updates first (UI cleanup)
    this.statusBarManager?.stop();

    // Deregister from backend (graceful disconnect)
    try {
      await this.vesselClient?.deregister();
    } catch (error) {
      console.error('[Obsidian Vessel] Error during deregistration:', error);
    }

    // Cleanup sync service (close connections)
    this.syncService?.cleanup();

    // Stop concept-db frontend services
    this.conceptBusListener?.stop();
    this.conceptWriteback?.stop();
    this.conceptSync?.stop();

    // Stop activity family and vessel sync services
    this.activityFamilySync?.stop();
    this.vesselSync?.stop();

    // Stop the Phase 1 observation layer (unsubscribes workspace + vault
    // handlers and clears the resolver context).
    try {
      this.stopObservation?.();
      stopObserveObsidianEvents();
      setObserveObsidianEventsContext(null, null);
      setGroupInteractionEpisodesContext(null);
      setPresenceRhythmContext(null);
    } catch (error) {
      console.error('[Obsidian Vessel] Error stopping observation layer:', error);
    }
    this.obsidianEventLog = null;
    this.stopObservation = null;

    // Stop the federation sidecar child process (if running)
    try {
      this.sidecarManager?.stop();
    } catch (error) {
      console.error('[Obsidian Vessel] Error stopping federation sidecar:', error);
    }

    // Stop HTTP server last (may have pending requests)
    try {
      await this.httpServer?.stop();
    } catch (error) {
      console.error('[Obsidian Vessel] Error stopping HTTP server:', error);
    }

    // Clear references
    this.httpServer = null;
    this.sidecarManager = null;
    this.vesselClient = null;
    this.apiClient = null;
    this.syncService = null;
    this.canvasBuilder = null;
    this.statusBarManager = null;
    this.executionFormatter = null;
    this.templateFormatter = null;

    console.log('[Obsidian Vessel] Plugin unloaded');
  }

  /**
   * Load settings from Obsidian data store
   */
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.shapes = Array.from(new Set([...DEFAULT_SETTINGS.shapes, ...(this.settings.shapes ?? [])]));
  }

  /**
   * Save settings to Obsidian data store
   */
  async saveSettings() {
    await this.saveData(this.settings);

    // Notify services of settings change
    if (this.executionFormatter) {
      this.executionFormatter = new ExecutionFormatter(this.settings);
    }
  }

  /**
   * Start the HTTP server for impulse resolution
   */
  private async startHTTPServer() {
    try {
      // Create resolvers map that wraps our registry
      const resolvers = new Map<string, (pointer: any) => Promise<{ success: boolean; content?: string; metadata?: any; error?: string }>>();

      for (const shape of this.settings.shapes) {
        resolvers.set(shape, async (pointer) => {
          try {
            this.resolutionCount++;
            this.vesselClient?.incrementResolutions();
            // Add the type to the pointer so the resolver knows which shape to use
            const pointerWithType = { ...pointer, type: shape };
            const result = await resolve(pointerWithType, this.app);
            const content = typeof result === 'string' ? result : result.content;
            const metadata = typeof result === 'object' ? result.metadata : undefined;
            return { success: true, content, metadata };
          } catch (error: any) {
            return { success: false, error: error.message };
          }
        });
      }

      // Vault-touch ledger: serve the ring buffer as the obsidian:vault_touches
      // read shape and pulse the status bar on every touch. Never written into
      // the vault (churn + echo-suppression conflicts).
      this.vaultTouchLedger = this.vaultTouchLedger ?? new VaultTouchLedger(500);
      const ledger = this.vaultTouchLedger;
      resolvers.set('obsidian:vault_touches', async (pointer) => {
        const rows = ledger.read({
          limit: typeof pointer?.limit === 'number' ? pointer.limit : 100,
          since: typeof pointer?.since === 'string' ? pointer.since : undefined,
          mode: pointer?.mode === 'read' || pointer?.mode === 'write' ? pointer.mode : undefined,
        });
        return {
          success: true,
          content: JSON.stringify(rows),
          metadata: { shape: 'obsidian:vault_touches', rowCount: rows.length, summary: `${rows.length} vault touches (of ${ledger.size()} recorded)` },
        };
      });
      ledger.subscribe((touch) => {
        this.statusBarManager?.showMessage(`⇅ substrate ${touch.mode}: ${touch.shape.replace('obsidian:', '')}`, 1500);
      });

      // Human-as-resolver (WS5): accept human_input solicitations and hold them
      // for the panel; the answer is POSTed back to goal-host via
      // solicitationResponse_write, with typing heartbeats extending the deadline.
      // Registered ALWAYS (capability), while discovery ADVERTISEMENT of the
      // human shapes is presence-conditioned (startPresenceAdvertiser).
      this.solicitationManager = this.solicitationManager ?? new SolicitationManager({
        goalHostEndpoint: this.settings.goalHostEndpoint,
        apiKey: this.settings.apiKey,
        notify: (m: string) => new Notice(m),
      });
      const solicitations = this.solicitationManager;
      const acceptSolicitation = async (pointer: any) => {
        const q = typeof pointer?.question_markdown === 'string' ? pointer.question_markdown : '';
        // Rendering-contract validator (substrate-self-detection): refuse bodies
        // that are not decision-ready markdown — raw JSON blobs are a rendering
        // failure, distinct from the human declining.
        if (!q || /```json|^\s*\{"/m.test(q)) {
          return { success: false, error: 'insufficient_context: solicitation body is not decision-ready markdown (raw JSON or empty)' };
        }
        const sol = solicitations.accept(pointer ?? {});
        if (!sol) return { success: false, error: 'invalid solicitation: solicitation_id and question_markdown are required' };
        return {
          success: true,
          content: JSON.stringify({ accepted: true, solicitation_id: sol.solicitationId, will_respond_via: 'solicitationResponse_write' }),
          metadata: { shape: 'human_input', summary: 'solicitation accepted; awaiting human answer' },
        };
      };
      resolvers.set('human_input', acceptSolicitation);
      resolvers.set('human_judgment', acceptSolicitation);

      this.httpServer = new HTTPServer({
        port: this.settings.serverPort,
        cors: {
          allowedOrigins: this.settings.allowedOrigins,
        },
        manifest: {
          vesselId: this.settings.vesselId || 'obsidian-vessel',
          vesselName: this.settings.vesselName,
          version: '0.1.2',
          shapes: this.settings.shapes,
        },
        resolvers,
        vaultTouches: this.vaultTouchLedger,
        // System-managed resolvers: shapes this vault doesn't own are forwarded to the
        // substrate (activity-api) so the plugin is a window into the whole fleet, not
        // just its built-in shapes. Inert when no activityApiUrl is configured.
        substrateProxy: this.settings.activityApiUrl
          ? async (pointer) => {
              try {
                const base = this.settings.activityApiUrl.replace(/\/+$/, '');
                const resp = await fetch(`${base}/v2/impulses/resolve`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    ...(this.settings.apiKey ? { Authorization: `ApiKey ${this.settings.apiKey}` } : {}),
                  },
                  body: JSON.stringify({ impulse: { pointer } }),
                });
                if (!resp.ok) return null;
                const j = (await resp.json()) as { content?: unknown; body?: unknown; metadata?: unknown };
                const content = j?.content ?? j?.body ?? null;
                if (content == null) return null;
                return { success: true, content, metadata: j?.metadata };
              } catch {
                return null;
              }
            }
          : undefined,
      });

      await this.httpServer.start();
      this.registerActionObservationRoutes(this.httpServer);
      console.log(`[Obsidian Vessel] HTTP server started on port ${this.settings.serverPort}`);
    } catch (error) {
      console.error('[Obsidian Vessel] Failed to start HTTP server:', error);

      // Show user-friendly error
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Obsidian: Failed to start HTTP server - ${errorMessage}`);

      // Server failure is not fatal - we can still work in offline mode
      this.httpServer = null;
    }
  }

  /**
   * Register action + observation HTTP endpoints on the running server.
   *
   * DEPRECATED compatibility surface: each route is a thin delegate over the
   * equivalent discovery-advertised impulse shape (obsidian:concept_sync,
   * obsidian:concept_rebuild, obsidian:reload_plugin, obsidian:open_note,
   * obsidian:dispatch_goal, obsidian:concept_status). The canonical surface is
   * POST /resolve with those shapes — capability gating, provenance tagging,
   * and trace recording apply there automatically. These routes remain only
   * for existing callers (dev-vessel seed template, federation sidecar,
   * obsidian-plugin-reload.sh) and should not gain new consumers.
   */
  private registerActionObservationRoutes(server: HTTPServer): void {
    // ── POST /actions/sync ── delegate → obsidian:concept_sync ──────────
    server.addRoute('POST', '/actions/sync', async (_req, res) => {
      try {
        const result = await resolve({ type: 'obsidian:concept_sync' } as unknown as ImpulsePointer, this.app);
        const content = typeof result === 'string' ? result : result.content;
        const parsed = JSON.parse(content || '{}') as { synced?: number };
        sendJson(res, { success: true, synced: parsed.synced ?? 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, { success: false, synced: 0, errors: [msg] });
      }
    });

    // ── POST /actions/rebuild ── delegate → obsidian:concept_rebuild ────
    server.addRoute('POST', '/actions/rebuild', async (_req, res) => {
      try {
        const result = await resolve({ type: 'obsidian:concept_rebuild' } as unknown as ImpulsePointer, this.app);
        const content = typeof result === 'string' ? result : result.content;
        const parsed = JSON.parse(content || '{}') as { rebuilt?: number };
        sendJson(res, { success: true, rebuilt: parsed.rebuilt ?? 0 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, { success: false, rebuilt: 0, errors: [msg] });
      }
    });

    // ── POST /actions/reload-plugin ── delegate → obsidian:reload_plugin ─
    // The resolver responds immediately and defers the disable→enable by
    // 150ms so this JSON flushes before the plugin (and its HTTP server)
    // unloads. This is the deploy cutover for substrate-authored features.
    server.addRoute('POST', '/actions/reload-plugin', async (_req, res) => {
      const pluginId = this.manifest.id || 'obsidian-vessel';
      try {
        await resolve({ type: 'obsidian:reload_plugin' } as unknown as ImpulsePointer, this.app);
        sendJson(res, { success: true, reloading: pluginId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, msg, 500);
      }
    });

    // ── POST /actions/open-note ── delegate → obsidian:open_note ────────
    server.addRoute('POST', '/actions/open-note', async (req, res) => {
      try {
        const body = await parseJsonBody<{ path?: string }>(req);
        if (!body.path || typeof body.path !== 'string') {
          sendError(res, 'Missing required field: path', 400);
          return;
        }
        await resolve({ type: 'obsidian:open_note', path: body.path } as unknown as ImpulsePointer, this.app);
        sendJson(res, { success: true, path: body.path });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, msg, 500);
      }
    });

    // ── POST /actions/dispatch-goal ── delegate → obsidian:dispatch_goal ─
    server.addRoute('POST', '/actions/dispatch-goal', async (req, res) => {
      try {
        const body = await parseJsonBody<{ goal?: string }>(req).catch(() => ({})) as { goal?: string };
        if (body.goal) {
          // Resolver activates the goal-dispatch view and enqueues the goal
          // fire-and-forget, mirroring the previous inline behaviour.
          await resolve({ type: 'obsidian:dispatch_goal', goal: body.goal } as unknown as ImpulsePointer, this.app);
        } else {
          await this.activateGoalDispatchView();
        }
        sendJson(res, { success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, msg, 500);
      }
    });

    // ── GET /observations/status ────────────────────────────────────────
    server.addRoute('GET', '/observations/status', (_req, res) => {
      try {
        const activeFile = this.app.workspace.getActiveFile()?.path ?? null;
        const syncStatus = this.conceptSync?.getStatus();
        const realtimeSyncStatus = this.syncService?.getStatus();
        const goalLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GOAL_DISPATCH);
        sendJson(res, {
          activeFile,
          lastSyncAt: syncStatus?.lastPullAt ?? null,
          totalConceptNotes: syncStatus?.syncedCount ?? 0,
          serverPort: this.settings.serverPort,
          websocketConnected: realtimeSyncStatus?.realtimeConnected ?? false,
          goalDispatchOpen: goalLeaves.length > 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, msg, 500);
      }
    });

    // ── GET /observations/concept-status ── delegate → obsidian:concept_status ─
    server.addRoute('GET', '/observations/concept-status', async (_req, res) => {
      try {
        const result = await resolve({ type: 'obsidian:concept_status' } as unknown as ImpulsePointer, this.app);
        const content = typeof result === 'string' ? result : result.content;
        const stats = JSON.parse(content || '{}') as {
          totalNotes?: number;
          notesWithEdges?: number;
          notesWithSignal?: number;
          averageRelevance?: number | null;
          lowestRelevance?: { path: string; relevance: number } | null;
          familyNotes?: number;
          vesselNotes?: number;
        };
        // Preserve the historical route contract: `avgRelevance`, rounded to 2dp.
        const avgRelevance = typeof stats.averageRelevance === 'number'
          ? Math.round(stats.averageRelevance * 100) / 100
          : 0;
        sendJson(res, {
          totalNotes: stats.totalNotes ?? 0,
          notesWithEdges: stats.notesWithEdges ?? 0,
          notesWithSignal: stats.notesWithSignal ?? 0,
          avgRelevance,
          lowestRelevance: stats.lowestRelevance ?? null,
          familyNotes: stats.familyNotes ?? 0,
          vesselNotes: stats.vesselNotes ?? 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(res, msg, 500);
      }
    });
  }

  /**
   * Register this vessel with the activity-api backend
   */
  private async registerVessel() {
    if (!this.vesselClient) return;

    try {
      // Get vault path for identification
      const adapter = this.app.vault.adapter as { basePath?: string };
      const vaultPath = adapter.basePath || '';

      const success = await this.vesselClient.register(
        vaultPath,
        this.settings.serverPort
      );

      if (success) {
        // Start heartbeat to maintain registration
        this.vesselClient.startHeartbeat();
        console.log('[Obsidian Vessel] Registered with activity-api');
      } else {
        console.warn('[Obsidian Vessel] Registration returned false');
      }
    } catch (error) {
      // Registration failure is not fatal - we work in offline mode
      console.error('[Obsidian Vessel] Failed to register:', error);
      // Don't show notice - this is expected when API is unavailable
    }
  }

  /**
   * Start the libp2p federation sidecar as a managed child process (opt-in).
   * See src/sidecar-manager.ts for the spawn/supervise/restart logic and
   * sidecar/federation-sidecar.ts for the transport + shape-route mapping.
   */
  private startFederationSidecar(): void {
    if (this.sidecarManager) {
      this.sidecarManager.updateSettings(this.settings);
      this.sidecarManager.start();
      return;
    }

    const adapter = this.app.vault.adapter as { basePath?: string };
    const vaultBasePath = adapter.basePath || '';
    const pluginDir = this.manifest.dir || '';

    this.sidecarManager = new SidecarManager(this.settings, {
      vaultBasePath,
      pluginDir,
      serverPort: this.settings.serverPort,
      logger: (level, msg) => {
        const line = `[Obsidian Vessel][sidecar] ${msg}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
      },
    });
    this.sidecarManager.start();
  }

  /**
   * Restart the federation sidecar — used by the "Restart Federation Sidecar"
   * settings action, and safe to call even if it isn't currently running.
   */
  async restartFederationSidecar(): Promise<void> {
    if (!this.sidecarManager) {
      this.startFederationSidecar();
      return;
    }
    this.sidecarManager.updateSettings(this.settings);
    await this.sidecarManager.restart();
  }

  /**
   * Reconnect to the backend
   * Used when settings change or connection is lost
   */
  async reconnect() {
    console.log('[Obsidian Vessel] Reconnecting...');

    // Deregister first
    try {
      await this.vesselClient?.deregister();
    } catch (error) {
      console.error('[Obsidian Vessel] Error during deregistration:', error);
    }

    // Re-initialize vessel client with new settings
    this.vesselClient = new VesselClient(this.settings);

    // Re-initialize API client with new settings
    this.apiClient = new ActivityAPIClient(
      this.settings.activityApiUrl,
      this.settings.apiKey
    );

    // Re-register
    await this.registerVessel();

    // Re-initialize sync service
    this.syncService?.cleanup();
    this.syncService = new SyncService(
      this.app,
      this.settings,
      this.apiClient,
      this,
      this.executionFormatter!
    );
    await this.syncService.initialize();

    console.log('[Obsidian Vessel] Reconnection complete');
  }

  /**
   * Restart the HTTP server
   * Used when server settings change
   */
  async restartServer() {
    console.log('[Obsidian Vessel] Restarting HTTP server...');

    // Stop existing server
    try {
      await this.httpServer?.stop();
    } catch (error) {
      console.error('[Obsidian Vessel] Error stopping HTTP server:', error);
    }

    this.httpServer = null;

    // Start new server if enabled
    if (this.settings.serverEnabled) {
      await this.startHTTPServer();
    }

    console.log('[Obsidian Vessel] HTTP server restart complete');
  }

  /**
   * Initialize the concept-db frontend services (Phase 1+3+4 wiring).
   *
   * Idempotent: stops any existing instances before constructing new
   * ones so this can be called again after settings changes.
   */
  async initializeConceptDbFrontend(): Promise<void> {
    // Stop existing instances if any
    this.conceptBusListener?.stop();
    this.conceptWriteback?.stop();
    this.conceptSync?.stop();

    const apiKey = this.settings.conceptDbApiKey || this.settings.apiKey;
    this.conceptDbClient = new ConceptDbClient(
      this.settings.conceptDbEndpoint,
      apiKey,
    );

    const writer = makeObsidianNoteWriter(this.app);
    this.conceptSync = new ConceptSyncService(
      this.settings,
      this.conceptDbClient,
      writer,
    );
    await this.conceptSync.start();

    if (this.settings.enableConceptDbWriteback) {
      this.conceptWriteback = new ConceptWritebackService(
        this.app,
        this.settings,
        this.conceptDbClient,
      );
      this.conceptWriteback.start();
    }

    // Phase 4: subscribe to the activity-api WS bus for live updates
    this.conceptBusListener = new ConceptBusListener(
      this.settings,
      this.conceptSync,
      this.conceptDbClient,
    );
    this.conceptBusListener.start();

    // Make the client/sync available to the impulse resolvers
    setConceptDbResolverContext(this.conceptDbClient, this.settings);
    setConceptWritebackResolverContext(this.conceptDbClient, this.conceptSync);
  }

  /**
   * Initialize the Phase 1 Obsidian observation layer.
   *
   * Creates the shared `ObsidianEventLog`, injects it into the three
   * observation resolvers, and starts the workspace + vault event
   * subscriptions. Idempotent: re-invocation tears down existing
   * subscriptions first.
   */
  initializeObservationLayer(): void {
    try {
      this.stopObservation?.();
    } catch (error) {
      console.error('[Obsidian Vessel] Error tearing down prior observation layer:', error);
    }

    const log = new ObsidianEventLog(10_000);
    this.obsidianEventLog = log;
    setObserveObsidianEventsContext(this.app, log);
    // Durable flood fix: the observer skips the substrate's OWN writes (concept-sync
    // root + substrate-owned folders incl. the write_note reflection namespace) so
    // operator-interaction signal is never evicted from the log.
    const syncRoot = (this.settings.conceptDbSyncRoot || 'concept-db').replace(/\/+$/, '');
    setSubstrateWritePrefixes([`${syncRoot}/`, 'substrate/', 'Substrate/']);
    setGroupInteractionEpisodesContext(log);
    setPresenceRhythmContext(log);
    this.stopObservation = startObserveObsidianEvents();
    console.log('[Obsidian Vessel] Observation layer started (event log cap=10000)');
  }

  /**
   * Presence-conditioned human-shape advertisement (WS4). NO static audience
   * config: when a human is recently active in this vault, re-register with
   * human_input / human_judgment in the discovery shape list; after a
   * sustained idle window, withdraw them. Hysteresis: advertise fast
   * (activity within 2 min), withdraw slow (idle 12 min). The advertised
   * resolve_timeout_ms follows presence quality: actively interacting → 120s,
   * present-but-quiet → 600s. The headless in-container instance never
   * observes human events, so it never advertises human shapes — correct by
   * construction.
   */
  startPresenceAdvertiser(): void {
    const HUMAN_SHAPES = ['human_input', 'human_judgment'];
    const ADVERTISE_WITHIN_MS = 2 * 60 * 1000;
    const WITHDRAW_AFTER_MS = 12 * 60 * 1000;
    const check = async (): Promise<void> => {
      const log = this.obsidianEventLog;
      if (!log || !this.vesselClient || !this.vesselClient.isRegistered()) return;
      const events = log.read({ limit: 10_000 });
      let lastTs = 0;
      for (const e of events) {
        const t = Date.parse(e.timestamp);
        if (!isNaN(t) && t > lastTs) lastTs = t;
      }
      const idleMs = lastTs > 0 ? Date.now() - lastTs : Number.POSITIVE_INFINITY;
      const advertised = HUMAN_SHAPES.every((s) => this.settings.shapes.includes(s));
      const wantAdvertise = advertised ? idleMs < WITHDRAW_AFTER_MS : idleMs < ADVERTISE_WITHIN_MS;
      const wantTimeout = idleMs < ADVERTISE_WITHIN_MS ? 120_000 : 600_000;
      let nextShapes: string[] | null = null;
      if (wantAdvertise && !advertised) {
        nextShapes = [...this.settings.shapes.filter((s) => !HUMAN_SHAPES.includes(s)), ...HUMAN_SHAPES];
      } else if (!wantAdvertise && advertised) {
        nextShapes = this.settings.shapes.filter((s) => !HUMAN_SHAPES.includes(s));
      }
      const timeoutChanged = wantAdvertise && this.settings.resolveTimeoutMs !== wantTimeout;
      if (!nextShapes && !timeoutChanged) return;
      // Build a FRESH settings object: VesselClient holds a reference to the
      // current one, so in-place mutation would defeat updateSettings' change
      // detection and no re-registration would happen.
      const next = {
        ...this.settings,
        shapes: nextShapes ?? [...this.settings.shapes],
        ...(wantAdvertise ? { resolveTimeoutMs: wantTimeout } : {}),
      };
      this.settings = next;
      console.log(`[Obsidian Vessel] presence advertiser: human shapes ${wantAdvertise ? 'ON' : 'OFF'} (idle ${Math.round(idleMs / 1000)}s, resolve_timeout_ms ${next.resolveTimeoutMs ?? 10000})`);
      await this.vesselClient.updateSettings(next);
    };
    this.registerInterval(window.setInterval(() => { void check(); }, 60_000));
  }

  /**
   * Get current vessel status
   */
  getStatus(): VesselStatus {
    const syncStatus = this.syncService?.getStatus();

    return {
      apiConnected: this.vesselClient?.isRegistered() || false,
      realtimeConnected: syncStatus?.realtimeConnected || false,
      serverRunning: this.httpServer !== null,
      lastSyncedAt: syncStatus?.lastSyncedAt || null,
      syncedCount: syncStatus?.syncedCount || 0,
      resolutionCount: this.resolutionCount,
      syncing: this.syncing
    };
  }

  /**
   * Get uptime in milliseconds
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Set syncing state
   */
  setSyncing(syncing: boolean) {
    this.syncing = syncing;
  }

  /**
   * Create a note from an execution trace
   *
   * @param executionId - The execution trace ID
   * @returns The created file, or null if failed
   */
  async createNoteFromExecution(executionId: string): Promise<TFile | null> {
    if (!this.apiClient || !this.executionFormatter) {
      new Notice('API client or formatter not initialized');
      return null;
    }

    try {
      // Fetch execution trace from API
      const execution = await this.apiClient.getExecutionTrace(executionId);
      if (!execution) {
        new Notice(`Execution not found: ${executionId}`);
        return null;
      }

      // Format as markdown
      const content = this.executionFormatter.format(execution);

      // Build file path with date organization
      const date = new Date(execution.executed_at).toISOString().split('T')[0];
      const path = `${this.settings.executionNotesFolder}/${date}/${executionId}.md`;

      // Ensure folder exists
      const folderPath = path.substring(0, path.lastIndexOf('/'));
      await this.ensureFolderExists(folderPath);

      // Create the file
      const file = await this.app.vault.create(path, content);

      // Open the new file
      await this.app.workspace.openLinkText(path, '', true);

      new Notice(`Created note: ${file.basename}`);
      return file;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Obsidian Vessel] Failed to create note:', error);
      new Notice(`Failed to create note: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Create a note from an activity template
   *
   * @param template - The activity template
   * @returns The created/updated file, or null if failed
   */
  async createNoteFromTemplate(template: ActivityTemplate): Promise<TFile | null> {
    if (!this.templateFormatter) {
      new Notice('Template formatter not initialized');
      return null;
    }

    try {
      // Format as markdown
      const content = this.templateFormatter.format(template);

      // Build file path
      const path = `${this.settings.activityTemplatesFolder}/${template.activity_id}.md`;

      // Ensure folder exists
      const folderPath = path.substring(0, path.lastIndexOf('/'));
      await this.ensureFolderExists(folderPath);

      // Check if file already exists
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        // Update existing file
        await this.app.vault.modify(existing, content);
        await this.app.workspace.openLinkText(path, '', true);
        new Notice(`Updated template note: ${existing.basename}`);
        return existing;
      }

      // Create new file
      const file = await this.app.vault.create(path, content);
      await this.app.workspace.openLinkText(path, '', true);
      new Notice(`Created template note: ${file.basename}`);
      return file;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Obsidian Vessel] Failed to create template note:', error);
      new Notice(`Failed to create template note: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Open the execution canvas view
   * Shows recent executions as a visual graph
   */
  async openExecutionCanvas(): Promise<void> {
    if (!this.canvasBuilder || !this.apiClient) {
      new Notice('Canvas builder or API client not initialized');
      return;
    }

    try {
      // Fetch recent executions
      const response = await this.apiClient.listExecutionTraces({ limit: 20 });

      if (!response?.executions || response.executions.length === 0) {
        new Notice('No execution traces found');
        return;
      }

      // Build canvas
      await this.canvasBuilder.buildExecutionCanvas(response.executions);

      // Open canvas file
      const path = `${this.settings.canvasFolder}/executions.canvas`;
      await this.app.workspace.openLinkText(path, '', true);

      new Notice(`Opened execution canvas with ${response.executions.length} traces`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Obsidian Vessel] Failed to open canvas:', error);
      new Notice(`Failed to open canvas: ${errorMessage}`);
    }
  }

  /**
   * Open the composition canvas view
   * Shows activity relationships and impulse flows as a visual graph
   */
  async openCompositionCanvas(): Promise<void> {
    if (!this.canvasBuilder || !this.apiClient) {
      new Notice('Canvas builder or API client not initialized');
      return;
    }

    try {
      // Fetch composition graph
      const graph = await this.apiClient.getCompositionGraph({ limit: 50 });

      if (!graph?.nodes || graph.nodes.length === 0) {
        new Notice('No composition graph data found');
        return;
      }

      // Build canvas
      await this.canvasBuilder.buildCompositionCanvas(graph);

      // Open canvas file
      const path = `${this.settings.canvasFolder}/composition-graph.canvas`;
      await this.app.workspace.openLinkText(path, '', true);

      new Notice(`Opened composition canvas with ${graph.totalNodes} activities and ${graph.totalEdges} relationships`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Obsidian Vessel] Failed to open composition canvas:', error);
      new Notice(`Failed to open composition canvas: ${errorMessage}`);
    }
  }

  /**
   * Ensure a folder path exists, creating intermediate folders as needed
   */
  private async ensureFolderExists(folderPath: string): Promise<void> {
    const parts = folderPath.split('/').filter(p => p.length > 0);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);

      if (!existing) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (error) {
          // Folder might have been created by another process
          if (!this.app.vault.getAbstractFileByPath(currentPath)) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Manually trigger a sync
   */
  async triggerSync(): Promise<void> {
    if (!this.syncService) {
      new Notice('Sync service not initialized');
      return;
    }

    this.syncing = true;
    try {
      await this.syncService.syncHistorical();
      new Notice('Sync completed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Sync failed: ${errorMessage}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Open (or reveal) the Goal Dispatch sidebar panel.
   */
  async activateGoalDispatchView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GOAL_DISPATCH);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_GOAL_DISPATCH, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  /**
   * Get available resolver types
   */
  getResolverTypes(): string[] {
    return listResolverTypes();
  }

  // ── Goal verdict feedback loop ───────────────────────────────────────────
  // Echo-loop guards (the plugin must not react to its own note writes):
  // the affordance append is gated by `verdict_prompted: true`; submission
  // fires only when `human_verdict` holds a valid value AND `verdict_submitted`
  // is not yet true (set on success, so a verdict submits exactly once); an
  // in-flight path set plus a per-session attempted set debounce concurrent
  // metadata events and prevent failure retry loops.

  private verdictInFlight = new Set<string>();
  private verdictAttempted = new Set<string>();

  /**
   * Handle a metadataCache `changed` event for goal notes. Appends the
   * "Your verdict" affordance on terminal status, and forwards a human
   * verdict (`human_verdict: reached | not_reached | partial`) exactly once
   * into goal_verification_labels via activity-api — the same oracle-corpus
   * surface the MCP cockpit's provide_feedback tool uses.
   */
  async handleGoalVerdictChange(file: TFile, cache: CachedMetadata | null): Promise<void> {
    try {
      if (!file.path.startsWith('Goals/') || !file.path.endsWith('.md')) return;
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      if (!fm || !fm.executionId) return;
      if (this.verdictInFlight.has(file.path)) return;

      const status = typeof fm.status === 'string' ? fm.status : 'running';
      if (status === 'running') return;
      const verdict = typeof fm.human_verdict === 'string' ? fm.human_verdict.trim() : '';

      if (!fm.verdict_prompted && fm.verdict_submitted !== true && !verdict) {
        this.verdictInFlight.add(file.path);
        try {
          await this.appendVerdictAffordance(file);
        } finally {
          this.verdictInFlight.delete(file.path);
        }
        return;
      }

      if (
        ['reached', 'not_reached', 'partial'].includes(verdict) &&
        fm.verdict_submitted !== true &&
        !this.verdictAttempted.has(file.path)
      ) {
        this.verdictInFlight.add(file.path);
        this.verdictAttempted.add(file.path);
        try {
          await this.submitGoalVerdict(file, fm, verdict);
        } finally {
          this.verdictInFlight.delete(file.path);
        }
      }
    } catch (error) {
      console.error('[Obsidian Vessel] Goal verdict handling failed:', error);
    }
  }

  private async appendVerdictAffordance(file: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.verdict_prompted = true;
      if (fm.human_verdict === undefined) fm.human_verdict = '';
    });
    const callout = [
      '',
      '> [!question] Your verdict',
      '> Was this goal actually achieved? Set the `human_verdict` property above to',
      '> `reached`, `not_reached`, or `partial` (optionally add a `verdict_note`).',
      "> It will be recorded as a ground-truth label in the substrate's oracle corpus.",
      '',
    ].join('\n');
    await this.app.vault.process(file, (data) => data + callout);
  }

  private async submitGoalVerdict(
    file: TFile,
    fm: Record<string, unknown>,
    verdict: string,
  ): Promise<void> {
    const activityApiUrl = this.settings.activityApiUrl;
    if (!activityApiUrl) return;

    const executionId = String(fm.executionId);
    const goal = typeof fm.goal === 'string' && fm.goal.trim()
      ? fm.goal
      : 'goal for execution ' + executionId;

    // Derive activity_id from the durable execution trace (the note does not
    // carry the selected template).
    let activityId: string | undefined;
    try {
      const trace = await this.apiClient?.getExecutionTrace(executionId);
      activityId = trace?.activity_id ?? trace?.variant_id ?? undefined;
    } catch {
      // trace lookup is best-effort
    }
    if (!activityId) {
      await this.appendVerdictResult(file, false, 'could not derive activity_id from the execution trace — verdict not recorded');
      return;
    }

    const verdictMap: Record<string, string> = {
      reached: 'achieved',
      not_reached: 'not_achieved',
      partial: 'partial',
    };
    const rawConf = typeof fm.verdict_confidence === 'number' ? fm.verdict_confidence : 0.9;
    const confidence = Math.min(Math.max(rawConf, 0), 1);
    const note = typeof fm.verdict_note === 'string' && fm.verdict_note.trim()
      ? fm.verdict_note.trim()
      : 'human verdict from goal note';

    const pointer = {
      type: 'goal_verification_label_write',
      goal,
      execution_id: executionId,
      activity_id: activityId,
      verdict: verdictMap[verdict],
      confidence,
      labeler: 'human',
      notes: note + ' [operator: obsidian-vessel-human]',
    };

    let ok = false;
    let detail = '';
    try {
      const resp = await requestUrl({
        url: activityApiUrl.replace(/\/+$/, '') + '/v2/impulses/resolve',
        method: 'POST',
        headers: {
          'Authorization': 'ApiKey ' + this.settings.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ impulse: { pointer } }),
        throw: false,
      });
      const body = resp.json as { success?: boolean; error?: string } | undefined;
      ok = resp.status < 300 && body?.success !== false;
      if (!ok) detail = body?.error ?? 'HTTP ' + resp.status;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    if (ok) {
      await this.app.fileManager.processFrontMatter(file, (f) => {
        f.verdict_submitted = true;
      });
    }
    await this.appendVerdictResult(
      file,
      ok,
      ok
        ? 'Verdict `' + verdict + '` recorded in the oracle corpus (goal_verification_labels).'
        : 'Verdict submission failed: ' + detail,
    );
  }

  private async appendVerdictResult(file: TFile, ok: boolean, message: string): Promise<void> {
    const callout = [
      '',
      '> [!' + (ok ? 'success' : 'warning') + '] ' + (ok ? 'Feedback recorded' : 'Feedback not recorded'),
      '> ' + message,
      '',
    ].join('\n');
    await this.app.vault.process(file, (data) => data + callout);
  }
}
