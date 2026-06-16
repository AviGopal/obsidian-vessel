/**
 * Concept-DB Sync Service
 *
 * Mirrors concept-db into the vault. Paginates `/concepts/search`,
 * fetches neighbors per concept, materializes notes via the
 * concept-formatter, and refreshes them on a configurable interval.
 *
 * Materialization is delegated to a `NoteWriter` callback so that this
 * module works both inside Obsidian (where `app.vault.create/modify`
 * is the right call) and outside Obsidian (where Node `fs` is used
 * for offline pulls / test scripts).
 */

import type { App, TFile } from 'obsidian';
import type { MetabobVesselSettings } from '../settings';
import type { ConceptDbClient, ConceptRecord, ConceptNeighbor } from '../concept-db-client';
import { shortConceptId } from '../concept-db-client';
import {
  conceptNotePath,
  renderConceptNote,
  buildCollisionMap,
} from '../formatters/concept-formatter';

/**
 * Default source_types excluded when no explicit list is configured.
 * `impulse_signature` concepts are produced per analysis-vessel
 * resolution and would dominate the vault.
 */
const DEFAULT_EXCLUDED_SOURCE_TYPES = new Set<string>(['impulse_signature']);

/**
 * NoteWriter abstracts vault writes so the sync service can run either
 * inside Obsidian (preferred) or against a plain Node filesystem (for
 * offline tests). The two implementations are provided as
 * `makeObsidianNoteWriter(app)` and `makeFsNoteWriter(rootDir)`.
 */
export interface NoteWriter {
  /**
   * Return true if a note already exists at the given vault-relative
   * path.
   */
  exists(path: string): Promise<boolean>;
  /**
   * Read the contents of an existing note (null if missing).
   */
  read(path: string): Promise<string | null>;
  /**
   * Write a note, creating parent folders as needed. Overwrites if it
   * already exists.
   */
  write(path: string, content: string): Promise<void>;
  /** List vault-relative .md paths under a folder prefix. */
  list(dirPrefix: string): Promise<string[]>;
  /** Delete (trash) a note. */
  delete(path: string): Promise<void>;
}

export interface ConceptSyncStatus {
  syncedCount: number;
  lastPullAt: string | null;
  lastError: string | null;
  running: boolean;
}

export interface ConceptSyncOptions {
  /** Page size for /concepts/search pagination (default 50). */
  pageSize?: number;
  /** Hard cap on concepts pulled per tick (default 5000). */
  maxConceptsPerTick?: number;
  /** Logger; default uses console with prefix. */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
}

const defaultLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => {
  const prefix = '[ConceptSync]';
  const tail = data ? ` ${JSON.stringify(data)}` : '';
  if (level === 'info') console.log(`${prefix} ${msg}${tail}`);
  else if (level === 'warn') console.warn(`${prefix} ${msg}${tail}`);
  else console.error(`${prefix} ${msg}${tail}`);
};

/**
 * Returns true if a concept's source_type should be included given the
 * settings filter. Empty `allow` array means "all except defaults".
 */
function shouldInclude(
  concept: ConceptRecord,
  allow: string[],
): boolean {
  const st = concept.source_type;
  if (allow.length > 0) {
    return !!st && allow.includes(st);
  }
  if (!st) return true;
  return !DEFAULT_EXCLUDED_SOURCE_TYPES.has(st);
}

/**
 * Decide whether to (re)write the note for a concept. We skip when the
 * remote `updated_at` is not newer than the on-disk
 * `last_substrate_pull_at`, and we never clobber a note flagged
 * `pending_sync: true` (that note has local edits queued for
 * writeback).
 */
function shouldRefresh(
  existing: string | null,
  concept: ConceptRecord,
): boolean {
  if (!existing) return true;
  const pendingMatch = /^pending_sync:\s*true\s*$/m.exec(existing);
  if (pendingMatch) return false;
  const remoteUpdated = concept.updated_at;
  if (!remoteUpdated) return false;
  const localMatch = /^last_substrate_pull_at:\s*(\S+)\s*$/m.exec(existing);
  if (!localMatch) return true;
  return new Date(remoteUpdated).getTime() > new Date(localMatch[1]).getTime();
}

export class ConceptSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When the current pull started; used to self-heal a stuck `running` flag. */
  private pullStartedAt: number | null = null;
  /** A pull stuck longer than this is presumed hung; the next tick reclaims it. */
  private static readonly STALE_PULL_MS = 4 * 60_000;
  /** Per-pull wall-clock budget so a slow pass can't exceed the interval. */
  private static readonly PULL_BUDGET_MS = 90_000;
  private status: ConceptSyncStatus = {
    syncedCount: 0,
    lastPullAt: null,
    lastError: null,
    running: false,
  };
  private logger: NonNullable<ConceptSyncOptions['logger']>;
  private pageSize: number;
  private maxConceptsPerTick: number;

  constructor(
    private settings: MetabobVesselSettings,
    private client: ConceptDbClient,
    private writer: NoteWriter,
    options: ConceptSyncOptions = {},
  ) {
    this.logger = options.logger ?? defaultLogger;
    this.pageSize = options.pageSize ?? 50;
    this.maxConceptsPerTick = options.maxConceptsPerTick ?? 5000;
  }

  getStatus(): ConceptSyncStatus {
    return { ...this.status };
  }

  /**
   * Start the periodic pull loop. Runs `pullAll()` once immediately,
   * then again every `conceptDbSyncIntervalSec` seconds.
   */
  async start(): Promise<void> {
    if (this.timer) return;
    this.logger('info', 'starting concept-sync', {
      endpoint: this.settings.conceptDbEndpoint,
      intervalSec: this.settings.conceptDbSyncIntervalSec,
    });
    // first run; swallow errors so the interval still installs
    this.pullAll().catch((err) =>
      this.logger('error', 'initial pull failed', { error: String(err) }),
    );
    const ms = Math.max(30_000, this.settings.conceptDbSyncIntervalSec * 1000);
    this.timer = setInterval(() => {
      this.pullAll().catch((err) =>
        this.logger('error', 'periodic pull failed', { error: String(err) }),
      );
    }, ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Single pass through concept-db: paginate /concepts/search, for each
   * concept fetch neighbors, render the note, and write if the on-disk
   * copy is stale.
   */
  async pullAll(): Promise<number> {
    if (
      this.status.running &&
      this.pullStartedAt !== null &&
      Date.now() - this.pullStartedAt < ConceptSyncService.STALE_PULL_MS
    ) {
      this.logger('warn', 'pull already running, skipping');
      return 0;
    }
    if (this.status.running) {
      // Prior pull is stale (hung or overran). Reclaim rather than block forever.
      this.logger('warn', 'reclaiming stale pull flag', {
        ageMs: this.pullStartedAt ? Date.now() - this.pullStartedAt : null,
      });
    }
    this.status.running = true;
    this.pullStartedAt = Date.now();
    this.status.lastError = null;
    let pulled = 0;
    try {
      const allow = this.settings.conceptDbSyncSourceTypes ?? [];
      const sourceTypeFilter =
        allow.length === 1 ? allow[0] : undefined; // single-value optimization: server-side filter

      // Pre-scan: collect every concept that will be materialized
      // BEFORE we start writing files, so we can build the collision
      // map (multiple concepts sharing source_type + Title Case
      // basename → disambiguator suffix needed). Without this pre-scan
      // the first concept of a colliding set would write a bare-title
      // file and the second would silently overwrite it.
      const collected: ConceptRecord[] = [];
      let offset = 0;
      while (collected.length < this.maxConceptsPerTick) {
        const page = await this.client.searchConcepts({
          sourceType: sourceTypeFilter,
          limit: this.pageSize,
          offset,
        });
        if (!page.concepts.length) break;
        for (const concept of page.concepts) {
          if (collected.length >= this.maxConceptsPerTick) break;
          if (!shouldInclude(concept, allow)) continue;
          collected.push(concept);
        }
        if (page.concepts.length < this.pageSize) break;
        offset += this.pageSize;
      }
      const collisions = buildCollisionMap(collected);

      // Write phase: materialize each collected concept with the
      // collision-aware path resolver. Bounded by PULL_BUDGET_MS so a large
      // stale backlog is drained incrementally across ticks instead of
      // overrunning the interval and wedging the running flag.
      const deadline = (this.pullStartedAt ?? Date.now()) + ConceptSyncService.PULL_BUDGET_MS;
      for (const concept of collected) {
        if (Date.now() > deadline) {
          this.logger('info', 'pull budget reached; remaining concepts deferred to next tick', {
            processed: pulled,
          });
          break;
        }
        try {
          const wrote = await this.materializeConcept(concept, collisions);
          if (wrote) pulled += 1;
        } catch (err) {
          this.logger('warn', 'materialize failed', {
            id: concept.id,
            error: String(err),
          });
        }
      }
      // Orphan sweep: a concept whose canonical path changed (title later
      // collided → disambiguator added) leaves a stale note at the old path
      // that never refreshes. Remove any note whose concept_id maps to a
      // collected concept but sits at a non-canonical path. Bounded + skips
      // pending_sync (local edits) + respects the pull budget.
      try {
        const normId = (id: string): string =>
          id.replace(/^concept:/, '').replace(/[⟨⟩]/g, '').trim();
        const canonicalByConcept = new Map<string, string>();
        for (const c of collected) {
          canonicalByConcept.set(
            normId(c.id),
            conceptNotePath(c, this.settings.conceptDbSyncRoot, collisions),
          );
        }
        const allNotes = await this.writer.list(this.settings.conceptDbSyncRoot);
        let orphansRemoved = 0;
        for (const notePath of allNotes) {
          if (orphansRemoved >= 1000 || Date.now() > deadline) break;
          const content = await this.writer.read(notePath);
          if (!content) continue;
          if (/^pending_sync:\s*true\s*$/m.test(content)) continue;
          const idMatch = /^concept_id:\s*(\S+)\s*$/m.exec(content);
          if (!idMatch) continue;
          const canonical = canonicalByConcept.get(normId(idMatch[1]!));
          if (!canonical || canonical === notePath) continue;
          // Same concept_id, different path → stale duplicate. Remove it.
          await this.writer.delete(notePath);
          orphansRemoved += 1;
        }
        if (orphansRemoved > 0) {
          this.logger('info', 'orphan sweep removed duplicate concept notes', { orphansRemoved });
        }
      } catch (err) {
        this.logger('warn', 'orphan sweep failed', { error: String(err) });
      }

      this.status.syncedCount += pulled;
      this.status.lastPullAt = new Date().toISOString();
      this.logger('info', 'pull complete', { pulled, syncedTotal: this.status.syncedCount });
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      this.logger('error', 'pull failed', { error: this.status.lastError });
    } finally {
      this.status.running = false;
      this.pullStartedAt = null;
    }
    return pulled;
  }

  /**
   * Force a full re-sync of all concept notes under `conceptDbSyncRoot`.
   *
   * Iterates every markdown file in the concept-db folder, removes the
   * `last_substrate_pull_at` frontmatter field on notes that carry
   * `concept-db: true` (so `shouldRefresh` treats them as stale on next
   * pull), then calls `pullAll()` to re-materialise everything.
   *
   * Requires `app` so it can use `fileManager.processFrontMatter` for
   * safe YAML mutation.
   *
   * @param app - The Obsidian App instance (available from main.ts).
   * @returns `{ rebuilt }` — number of notes whose timestamp was cleared.
   */
  async forceRebuild(app: App): Promise<{ rebuilt: number }> {
    const prefix = this.settings.conceptDbSyncRoot + '/';
    const files = app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix));

    let rebuilt = 0;
    for (const file of files) {
      await app.fileManager.processFrontMatter(file, (fm) => {
        if (fm['concept-db'] === true) {
          delete fm['last_substrate_pull_at'];
          rebuilt += 1;
        }
      });
    }

    this.logger('info', 'forceRebuild: cleared timestamps', { rebuilt });
    await this.pullAll();
    return { rebuilt };
  }

  /**
   * Fetch neighbors, render, and write the note for one concept.
   * Returns true if a write actually happened. The optional
   * `collisions` map (built by pullAll's pre-scan) disambiguates
   * filenames when two concepts share source_type + Title Case.
   */
  async materializeConcept(
    concept: ConceptRecord,
    collisions?: Map<string, string[]>,
  ): Promise<boolean> {
    const path = conceptNotePath(concept, this.settings.conceptDbSyncRoot, collisions);
    const existing = await this.writer.read(path);
    if (!shouldRefresh(existing, concept)) return false;
    let neighbors: ConceptNeighbor[] = [];
    try {
      neighbors = await this.client.getNeighbors(concept.id);
    } catch (err) {
      this.logger('warn', 'neighbors fetch failed', {
        id: concept.id,
        error: String(err),
      });
    }
    const content = renderConceptNote(concept, neighbors, {
      pulledAt: new Date().toISOString(),
    });
    await this.writer.write(path, content);
    return true;
  }
}

// =============================================================================
// NoteWriter implementations
// =============================================================================

/**
 * NoteWriter backed by Obsidian's vault API. Use when running inside
 * the plugin.
 */
export function makeObsidianNoteWriter(app: App): NoteWriter {
  const ensureFolder = async (folderPath: string): Promise<void> => {
    if (!folderPath) return;
    const parts = folderPath.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const existing = app.vault.getAbstractFileByPath(cur);
      if (!existing) {
        try {
          await app.vault.createFolder(cur);
        } catch (err) {
          if (!app.vault.getAbstractFileByPath(cur)) throw err;
        }
      }
    }
  };
  return {
    async exists(path: string): Promise<boolean> {
      return app.vault.getAbstractFileByPath(path) != null;
    },
    async read(path: string): Promise<string | null> {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file || !('extension' in file)) return null;
      return app.vault.read(file as TFile);
    },
    async write(path: string, content: string): Promise<void> {
      const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      await ensureFolder(folder);
      const existing = app.vault.getAbstractFileByPath(path);
      if (existing && 'extension' in existing) {
        await app.vault.modify(existing as TFile, content);
      } else {
        await app.vault.create(path, content);
      }
    },
    async list(dirPrefix: string): Promise<string[]> {
      const prefix = dirPrefix.endsWith('/') ? dirPrefix : `${dirPrefix}/`;
      return app.vault
        .getMarkdownFiles()
        .map((f: TFile) => f.path)
        .filter((p: string) => p.startsWith(prefix));
    },
    async delete(path: string): Promise<void> {
      const file = app.vault.getAbstractFileByPath(path);
      if (file) await app.vault.trash(file, false); // false = move to vault .trash (recoverable)
    },
  };
}

/**
 * NoteWriter backed by Node `fs`. Use for offline pulls (e.g. test
 * harnesses, CLI scripts). `rootDir` is the absolute path to the vault
 * root; vault-relative paths are joined under it.
 */
export function makeFsNoteWriter(rootDir: string): NoteWriter {
  // Lazy-load Node fs so this module can still be imported in the
  // Obsidian bundler without complaining.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const resolve = (p: string) => path.join(rootDir, p);
  return {
    async exists(p: string): Promise<boolean> {
      return fs.existsSync(resolve(p));
    },
    async read(p: string): Promise<string | null> {
      const abs = resolve(p);
      if (!fs.existsSync(abs)) return null;
      return fs.promises.readFile(abs, 'utf8');
    },
    async write(p: string, content: string): Promise<void> {
      const abs = resolve(p);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf8');
    },
    async list(dirPrefix: string): Promise<string[]> {
      const absDir = resolve(dirPrefix);
      const out: string[] = [];
      const walk = (dir: string): void => {
        let entries: import('fs').Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (e.name.endsWith('.md')) out.push(path.relative(rootDir, abs));
        }
      };
      walk(absDir);
      return out;
    },
    async delete(p: string): Promise<void> {
      const abs = resolve(p);
      try { await fs.promises.rm(abs, { force: true }); } catch { /* ignore */ }
    },
  };
}
