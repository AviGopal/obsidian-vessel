/**
 * Concept Writeback Service
 *
 * Listens for vault modifications under the configured sync-root and
 * propagates them back to concept-db. Only files with frontmatter
 * containing `concept-db: true` are considered.
 *
 * Flow:
 *   1. on modify: parse frontmatter + body
 *   2. set pending_sync: true, save
 *   3. POST changes (createConcept or upsertBySignature/updateConcept)
 *   4. diff `## Related` wikilinks vs the previously-known set;
 *      for additions, call linkConcepts; removals are logged (concept-
 *      db prunes via upkeep — vault edits don't hard-delete edges).
 *   5. clear pending_sync (on success) or leave it set (on failure)
 */

import { App, TFile, TAbstractFile } from 'obsidian';
import type { MetabobVesselSettings } from '../settings';
import type {
  ConceptDbClient,
  ConceptRecord,
} from '../concept-db-client';
import { stripWritebackEnvelope } from './concept-writeback-strip';

interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
  related: Map<string, Set<string>>; // edge_type -> set of short_ids
}

/**
 * Naive YAML-frontmatter parser sufficient for the schema we write
 * (scalar fields + a single-level aliases list). Returns null when no
 * frontmatter block is present.
 */
function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } | null {
  if (!content.startsWith('---')) return null;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx < 0) return null;
  const fmBlock = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 4).replace(/^\n/, '');
  const fm: Record<string, unknown> = {};
  let currentList: string | null = null;
  for (const rawLine of fmBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (currentList && line.startsWith('  - ')) {
      const arr = (fm[currentList] as string[]) || [];
      arr.push(line.slice(4).trim());
      fm[currentList] = arr;
      continue;
    }
    currentList = null;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    if (valRaw === '') {
      // list-typed value follows
      currentList = key;
      fm[key] = [];
      continue;
    }
    // strip surrounding quotes
    let val: unknown = valRaw;
    if (typeof val === 'string') {
      const s = val.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        val = s.slice(1, -1);
      } else if (/^-?\d+(\.\d+)?$/.test(s)) {
        val = Number(s);
      } else if (s === 'true' || s === 'false') {
        val = s === 'true';
      } else {
        val = s;
      }
    }
    fm[key] = val;
  }
  return { fm, body };
}

/**
 * Extract `[[short_id]]` wikilinks from the `## Related` section,
 * grouped by edge_type subsection (`### related_to`, etc.).
 * Wikilinks outside a subsection fall under `related_to`.
 */
function parseRelated(body: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const relIdx = body.search(/^##\s+Related\s*$/m);
  if (relIdx < 0) return out;
  const tail = body.slice(relIdx);
  let currentType = 'related_to';
  for (const line of tail.split('\n').slice(1)) {
    const h3 = /^###\s+(\S+)/.exec(line);
    if (h3) {
      currentType = h3[1];
      continue;
    }
    // collect every [[short]] link on the line
    const linkRe = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(line)) != null) {
      const target = m[1].trim();
      if (!target) continue;
      const set = out.get(currentType) || new Set<string>();
      set.add(target);
      out.set(currentType, set);
    }
  }
  return out;
}

function parseNote(content: string): ParsedNote | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  return {
    frontmatter: parsed.fm,
    body: parsed.body,
    related: parseRelated(parsed.body),
  };
}

/**
 * Re-serialize frontmatter (preserving key order from the source by
 * passing in `keyOrder`) with `pending_sync` set to `value`. Used to
 * atomically flip the flag.
 */
function setPendingSync(content: string, value: boolean): string {
  if (!content.startsWith('---')) return content;
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx < 0) return content;
  const fmBlock = content.slice(3, endIdx);
  let newFm = fmBlock;
  if (/^pending_sync:\s*/m.test(fmBlock)) {
    newFm = fmBlock.replace(/^pending_sync:\s*.*$/m, `pending_sync: ${value}`);
  } else {
    newFm = fmBlock.replace(/\n*$/, `\npending_sync: ${value}\n`);
  }
  return '---' + newFm + content.slice(endIdx);
}


export class ConceptWritebackService {
  private modifyHandler: ((file: TAbstractFile) => void) | null = null;
  /** in-flight writeback paths to avoid recursing on our own pending_sync flip */
  private inFlight = new Set<string>();
  /** last-known related set per concept id, for diffing on next save */
  private lastRelated = new Map<string, Map<string, Set<string>>>();

  constructor(
    private app: App,
    private settings: MetabobVesselSettings,
    private client: ConceptDbClient,
  ) {}

  start(): void {
    if (this.modifyHandler) return;
    this.modifyHandler = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      if (!this.isUnderSyncRoot(file.path)) return;
      if (this.inFlight.has(file.path)) return;
      void this.handleModify(file).catch((err) =>
        console.error('[ConceptWriteback] handleModify failed', err),
      );
    };
    this.app.vault.on('modify', this.modifyHandler);
  }

  stop(): void {
    if (this.modifyHandler) {
      this.app.vault.off('modify', this.modifyHandler);
      this.modifyHandler = null;
    }
  }

  private isUnderSyncRoot(p: string): boolean {
    const root = this.settings.conceptDbSyncRoot.replace(/\/$/, '');
    return p === root || p.startsWith(root + '/');
  }

  private async handleModify(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file);
    const parsed = parseNote(content);
    if (!parsed) return;
    if (parsed.frontmatter['concept-db'] !== true) return;

    const conceptIdRaw = parsed.frontmatter['concept_id'];
    const conceptId = typeof conceptIdRaw === 'string' ? conceptIdRaw : undefined;

    // mark pending_sync: true
    try {
      this.inFlight.add(file.path);
      const flagged = setPendingSync(content, true);
      if (flagged !== content) {
        await this.app.vault.modify(file, flagged);
      }
    } finally {
      // we'll keep inFlight until the writeback below clears it
    }

    try {
      const shape = String(parsed.frontmatter['shape'] || 'note');
      const sourceType = String(parsed.frontmatter['source_type'] || 'vault_note');
      const summary = String(parsed.frontmatter['summary'] || '').trim();
      const body = stripWritebackEnvelope(parsed.body);

      let mintedId: string | undefined;
      if (!conceptId) {
        const created: ConceptRecord = await this.client.createConcept({
          source_type: sourceType,
          shape,
          summary: summary || undefined,
          content: body,
        });
        mintedId = created.id;
        // write minted id into frontmatter for subsequent saves
        await this.injectConceptId(file, mintedId);
      } else {
        // Upsert by signature is the documented round-trip path
        await this.client.upsertBySignature({
          pointer_type: sourceType,
          shape,
        });
        // Then PATCH the concept's content/summary
        try {
          await this.client.updateConcept(conceptId, {
            content: body,
            summary: summary || undefined,
          });
        } catch (err) {
          // PATCH may not be exposed on every concept-db build;
          // upsert-by-signature already handles the idempotent path.
          console.warn('[ConceptWriteback] PATCH failed (non-fatal)', err);
        }
      }

      // Edge diff: emit concept_link for additions.
      const currentId = conceptId || mintedId;
      if (currentId) {
        const prev = this.lastRelated.get(currentId) || new Map<string, Set<string>>();
        const cur = parsed.related;
        for (const [edgeType, targets] of cur) {
          const prevSet = prev.get(edgeType) || new Set<string>();
          for (const target of targets) {
            if (!prevSet.has(target)) {
              try {
                await this.client.linkConcepts(currentId, target, edgeType);
              } catch (err) {
                console.warn('[ConceptWriteback] linkConcepts failed', err);
              }
            }
          }
        }
        this.lastRelated.set(currentId, cur);
      }

      // clear pending_sync on success
      const after = await this.app.vault.read(file);
      const cleared = setPendingSync(after, false);
      if (cleared !== after) await this.app.vault.modify(file, cleared);
    } catch (err) {
      console.error('[ConceptWriteback] writeback failed', err);
      // leave pending_sync: true on failure so the next save retries
    } finally {
      // small delay before removing the in-flight guard so the
      // pending_sync flip we just did is not interpreted as a new edit
      setTimeout(() => this.inFlight.delete(file.path), 200);
    }
  }

  /**
   * After minting a brand-new concept, splice the returned id into the
   * note's frontmatter so subsequent saves take the upsert path.
   */
  private async injectConceptId(file: TFile, id: string): Promise<void> {
    const content = await this.app.vault.read(file);
    if (!content.startsWith('---')) return;
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx < 0) return;
    const fmBlock = content.slice(3, endIdx);
    let newFm = fmBlock;
    const shortId = id.replace(/^concept:/, '');
    if (/^concept_id:\s*/m.test(fmBlock)) {
      newFm = fmBlock.replace(/^concept_id:\s*.*$/m, `concept_id: ${shortId}`);
    } else {
      newFm = `\nconcept_id: ${shortId}` + fmBlock;
    }
    const next = '---' + newFm + content.slice(endIdx);
    await this.app.vault.modify(file, next);
  }
}
