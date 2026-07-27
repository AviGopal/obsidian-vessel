/**
 * Plugin Settings for Obsidian Vessel
 *
 * Settings interface and defaults for the Obsidian vessel plugin.
 * These control connection, sync behavior, note formatting, and canvas generation.
 */

export { syncImprovements } from './sync/improvement-sync';

export interface ObsidianVesselSettings {
  // ==========================================================================
  // Connection Settings
  // ==========================================================================

  /** URL of the activity API endpoint */

  /** API key for authentication */
  apiKey: string;

  // ==========================================================================
  // Sync Preferences
  // ==========================================================================

  /** Folder for execution trace notes */

  /** Folder for activity template notes */

  /** Folder for generated canvases */
  canvasFolder: string;

  /** Folder for execution trace notes */
  traceNoteFolder: string;

  /** Folder for activity template notes */
  templateNoteFolder: string;

  /** Template content for generated notes */
  noteTemplate: string;

  /** Whether to sync on plugin load */

  /** Interval between automatic syncs (in minutes) */
  syncIntervalMinutes: number;

  /** Batch size for sync operations */
  syncBatchSize: number;

  /** Preserve user-added content when updating notes */
  preserveUserContent: boolean;

  // ==========================================================================
  // Vessel Registration Settings
  // ==========================================================================

  /** Unique identifier for this vessel instance */
  vesselId: string;

  /** Human-readable name for this vessel */
  vesselName: string;

  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;

  /** Registration TTL in seconds (how long the registration is valid) */
  registrationTtl: number;

  /**
   * Advertised resolver timeout (ms) for the discovery resolve contract.
   * Presence-conditioned: set dynamically by the presence advertiser
   * (actively interacting → short; present-but-quiet → long). Undefined ⇒ 10000.
   */
  resolveTimeoutMs?: number;

  /** Impulse shapes this vessel can resolve */
  shapes: string[];

  /**
   * Whether this instance sits in front of a real human (a monitored,
   * interactively-used vault). Only a human vessel advertises the
   * `human_input` / `human_judgment` shapes to discovery — the headless
   * in-container instance sets this false so solicitations route ONLY to the
   * host vault the human actually reads, regardless of synthetic event
   * activity a headless/automated Obsidian may generate. Default true: a
   * normal desktop Obsidian user is a human.
   */
  isHumanVessel: boolean;

  // ==========================================================================
  // HTTP Server Settings
  // ==========================================================================

  /** Whether the HTTP server is enabled for impulse resolution */
  serverEnabled: boolean;

  /** Port for the HTTP server */
  serverPort: number;

  /** Allowed CORS origins (supports wildcards) */
  allowedOrigins: string[];

  // ==========================================================================
  // Note Formatting Settings
  // ==========================================================================

  /** Include tool call details in execution notes */

  /** Include file diffs in execution notes */

  // ==========================================================================
  // Canvas Settings
  // ==========================================================================

  /** Layout algorithm for activity canvases */

  /** Maximum nodes per canvas */

  // ==========================================================================
  // Concept-DB Frontend Settings
  // ==========================================================================

  /** Enable mirroring concept-db into the vault (opt-in). */
  enableConceptDbSync: boolean;

  /** Vault sub-folder where concept notes live. */
  conceptDbSyncRoot: string;

  /** Pull interval in seconds. */
  conceptDbSyncIntervalSec: number;

  /** Enable vault → concept-db writeback (opt-in, requires sync also on). */
  enableConceptDbWriteback: boolean;

  /**
   * If non-empty, restrict sync to these source_type values. Empty array
   * means "all source_types EXCEPT impulse_signature" (which would
   * dominate the vault).
   */
  conceptDbSyncSourceTypes: string[];

  // ==========================================================================
  // Goal Dispatch Settings
  // ==========================================================================

  /** Enable the Goal Dispatch sidebar and command. */
  enableGoalDispatch: boolean;

  // ==========================================================================
  // Activity Family Sync Settings
  // ==========================================================================

  /** Enable syncing activity families from activity-api into the vault. */
  enableActivityFamilySync: boolean;

  /** Vault folder for activity family notes. */
  activityFamilyFolder: string;

  // ==========================================================================
  // Vessel Sync Settings
  // ==========================================================================

  /** Enable syncing vessel registry from discovery-vessel into the vault. */
  enableVesselSync: boolean;

  /** Vault folder for vessel notes. */
  vesselFolder: string;

  /** Materialize the substrate STRUCTURE (vessel↔shape topology + activity
   * composition graph) as tagged, wikilinked notes for Obsidian's native graph. */
  enableGraphBackbone: boolean;

  /**
   * Substrate discovery endpoint — the single required network setting
   * (alongside the API key). The federation sidecar fetches
   * <endpoint>/bootstrap to obtain relay_multiaddrs, identity_endpoint and
   * prefer_transport. Never derived from the relay; the relay is derived from
   * this.
   */
  discoveryVesselEndpoint: string;

  // ==========================================================================
  // Federation Sidecar Settings
  // ==========================================================================

  /**
   * Enable spawning the libp2p federation sidecar (bundled under
   * `sidecar/federation-sidecar.ts`) as a managed child process. This makes
   * the plugin's local HTTP server reachable from a REMOTE substrate (a hub
   * across the internet, not just the local container) over a Circuit Relay
   * v2 overlay, without bundling libp2p into the plugin's own esbuild bundle.
   * The sidecar starts whenever a relay multiaddr (or discovery URL) is configured.
   */

  /** Circuit Relay v2 multiaddr to reserve on, e.g. `/ip4/<host>/tcp/30333/p2p/<relay-peer-id>`. */
  federationRelayMultiaddr: string;
  /** The hub federation-transport ingress circuit multiaddr; when set with the sidecar on, all outbound resolve/dispatch routes over libp2p to the hub instead of dialing host:ports. */
  federationIngressMultiaddr: string;

  /** Plain-HTTP liveness port for the sidecar (loopback only; real reachability is the relay circuit). */
  federationHealthPort: number;

  /** Path to the `bun` executable used to run the sidecar (default: resolved from PATH). */
  federationBunPath: string;

  // ==========================================================================
  // Improvement Note Settings
  // ==========================================================================

  /** Enable the periodic substrate-improvement note (pulled by the plugin). */
  enableImprovementSync: boolean;

  /** Minutes between improvement-note pulls. */
  improvementSyncIntervalMinutes: number;
}

/**
 * Generate a unique vessel ID for registration.
 */
export function generateVesselId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `obsidian-vessel-${timestamp}-${random}`;
}

/**
 * Default settings for the Obsidian Vessel plugin.
 */
export const DEFAULT_SETTINGS: ObsidianVesselSettings = {
  // Connection
  apiKey: '',

  // Vessel registration
  vesselId: '',  // Will be generated on first load if empty
  vesselName: 'Obsidian Vessel',
  heartbeatInterval: 30000,  // 30 seconds
  registrationTtl: 300,      // 5 minutes
  shapes: ['obsidian:note', 'obsidian:search', 'obsidian:list_notes', 'obsidian:canvas', 'obsidian:backlinks', 'obsidian:frontmatter', 'obsidian:daily_note', 'obsidian:graph_query', 'obsidian:concept_view', 'obsidian:concept_writeback', 'obsidian:event_observed', 'obsidian:interaction_episode', 'obsidian:action_effect_model', 'obsidian:command_catalog',
    'obsidian:capability_catalog', 'obsidian:execute_command', 'obsidian:workspace_state', 'obsidian:open_note',
    'obsidian:reload_plugin',
    'obsidian:dispatch_goal',
    'obsidian:concept_sync',
    'obsidian:concept_rebuild',
    'obsidian:concept_status', 'obsidian:write_note', 'obsidian:ui_view', 'obsidian:presence_rhythm', 'obsidian:vault_touches', 'obsidian:ui_screenshot',
    'obsidian:ui_layout_metrics', 'obsidian:dom_query',
    'obsidian:presentation_decisions'],

  // A normal desktop Obsidian user is a human; the headless in-container
  // instance overrides this to false in its data.json.
  isHumanVessel: true,

  // Sync preferences
  canvasFolder: 'Obsidian/Canvases',
  traceNoteFolder: 'Obsidian/Traces',
  templateNoteFolder: 'Obsidian/Templates',
  noteTemplate: '',
  syncIntervalMinutes: 5,
  syncBatchSize: 50,
  preserveUserContent: true,

  // HTTP Server
  serverEnabled: true,
  serverPort: 27182,
  allowedOrigins: ['http://localhost:*', 'http://127.0.0.1:*'],

  // Note formatting

  // Canvas

  // Concept-DB Frontend
  enableConceptDbSync: false,
  conceptDbSyncRoot: 'concept-db',
  conceptDbSyncIntervalSec: 300,
  enableConceptDbWriteback: false,
  conceptDbSyncSourceTypes: [],

  // Goal Dispatch
  enableGoalDispatch: true,

  // Activity Family Sync
  enableActivityFamilySync: false,
  activityFamilyFolder: 'substrate/activity-families',

  // Vessel Sync
  enableVesselSync: false,
  vesselFolder: 'substrate/vessels',
  enableGraphBackbone: true,
  // Host-mapped discovery port (in-container :8100 is published on host :18100).
  discoveryVesselEndpoint: 'http://127.0.0.1:18100',

  // Federation Sidecar
  federationRelayMultiaddr: '',
  federationIngressMultiaddr: '',
  federationHealthPort: 8402,
  federationBunPath: 'bun',

  // Improvement Note
  enableImprovementSync: true,
  improvementSyncIntervalMinutes: 30,
};

/**
 * Validate settings and return any errors.
 */
export function validateSettings(settings: ObsidianVesselSettings): string[] {
  const errors: string[] = [];
  try {
    const parsed = new URL(settings.discoveryVesselEndpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      errors.push('Discovery endpoint must be an absolute http(s) URL');
    }
  } catch {
    errors.push('Discovery endpoint must be an absolute http(s) URL');
  }
  if (!settings.apiKey || settings.apiKey.trim().length === 0) {
    errors.push('API key must not be empty');
  }

  // Validate port range
  if (settings.serverPort < 1024 || settings.serverPort > 65535) {
    errors.push('Server port must be between 1024 and 65535');
  }

  // Validate sync interval
  if (settings.syncIntervalMinutes < 1 || settings.syncIntervalMinutes > 1440) {
    errors.push('Sync interval must be between 1 and 1440 minutes');
  }

  // Validate folder paths (must not start with / or contain ..)
  const folderPaths = [
    settings.canvasFolder,
  ];

  for (const folder of folderPaths) {
    if (folder.startsWith('/')) {
      errors.push(`Folder path "${folder}" should not start with /`);
    }
    if (folder.includes('..')) {
      errors.push(`Folder path "${folder}" should not contain ..`);
    }
  }

  return errors;
}

/**
 * Merge partial settings with defaults.
 */
export function mergeSettings(
  partial: Partial<ObsidianVesselSettings>
): ObsidianVesselSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    // Ensure arrays are properly merged
    allowedOrigins:
      partial.allowedOrigins ?? DEFAULT_SETTINGS.allowedOrigins,
  };
}
