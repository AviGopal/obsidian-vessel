/**
 * Resolver — `obsidian:write_note`
 *
 * The PROACTIVE-RESPOND channel: lets the substrate write a note into the
 * operator's WORKING vault so its messages (e.g. the learned-workflow
 * reflection) are visible where the operator actually works — not only on the
 * read-only substrate render board.
 *
 * SAFETY: writes are HARD-RESTRICTED to a substrate-owned prefix (default
 * `Substrate/`). Any path outside an allowed prefix is REFUSED. The substrate
 * therefore cannot create or overwrite the operator's own notes — only its own
 * clearly-namespaced messages, which are a single folder the operator can delete
 * wholesale. Idempotent: existing file is modified in place, not duplicated.
 */

import { registerSolicitation } from './observe-obsidian-events';
import type { App, TFile } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';
import { registerResolver } from './index';

export interface WriteNotePointer {
  type: string;
  /** Vault-relative path; MUST be under an allowed prefix. */
  path?: string;
  /** Full markdown body to write. */
  content?: string;
  /** Override allowed prefixes (default ['Substrate/']). */
  allowed_prefixes?: string[];
  dispatch_id?: string;
  goal?: string;
  reached?: boolean;
}

const DEFAULT_ALLOWED_PREFIXES = ['Substrate/'];

async function resolveWriteNote(
  pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const p = pointer as unknown as WriteNotePointer;
  const path = (p.path ?? '').replace(/^\/+/, '');
  const content = typeof p.content === 'string' ? p.content : '';
  const allowed = Array.isArray(p.allowed_prefixes) && p.allowed_prefixes.length
    ? p.allowed_prefixes
    : DEFAULT_ALLOWED_PREFIXES;

  // SAFETY GATE: refuse anything outside the substrate-owned namespace, and any
  // path traversal. This is the floor that keeps the substrate out of the
  // operator's own notes.
  const safe =
    !!path &&
    path.endsWith('.md') &&
    !path.includes('..') &&
    allowed.some((pfx) => path.startsWith(pfx));
  if (!safe) {
    return {
      content: JSON.stringify({ wrote: false, refused: true, reason: `path must end in .md and start with one of [${allowed.join(', ')}]`, path }),
      metadata: { shape: 'obsidian:write_note', summary: `refused write to ${path || '(empty)'}` },
    };
  }

  try {
    // Ensure parent folders exist.
    const dir = path.split('/').slice(0, -1).join('/');
    if (dir && !app.vault.getAbstractFileByPath(dir)) {
      await app.vault.createFolder(dir).catch(() => { /* exists / race */ });
    }
    // safety gate passed — write the note
    let body = content;
    // Provenance styling: notes CREATED by the substrate carry a cssclasses
    // frontmatter marker so the vault styles them distinctly from human text.
    // Existing (co-inhabited) notes are never reclassified whole-note; block-level
    // provenance there stays the callout convention.
    if (!app.vault.getAbstractFileByPath(path)) {
      const fmHasCssclasses = /^---\n[\s\S]*?^cssclasses:/m.test(body.match(/^---\n[\s\S]*?\n---/)?.[0] ?? '');
      if (!fmHasCssclasses) {
        body = /^---\n/.test(body)
          ? body.replace(/^---\n/, '---\ncssclasses:\n  - substrate-authored\n')
          : '---\ncssclasses:\n  - substrate-authored\n---\n' + body;
      }
    }
    if (p.dispatch_id || p.goal) {
      body += '\n\n---\n' + 'provenance: substrate-authored\n';
      if (p.goal) body += 'goal: ' + p.goal + '\n';
      if (p.dispatch_id) body += 'dispatch: ' + p.dispatch_id + '\n';
      if (p.reached !== undefined) body += 'reached: ' + (p.reached ? 'yes' : 'no') + '\n';
    }
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing && 'stat' in existing) {
      // SAFETY: if the existing note has frontmatter and the incoming body does
      // not, prepend the existing frontmatter so we never silently delete it.
      const existingContent = await app.vault.read(existing as TFile);
      const existingFmMatch = existingContent.match(/^(---\n[\s\S]*?\n---\n)/);
      const incomingHasFm = /^---\n/.test(body);
      const bodyToWrite =
        existingFmMatch && !incomingHasFm
          ? existingFmMatch[1] + body
          : body;
      await app.vault.modify(existing as TFile, bodyToWrite);
    } else {
      await app.vault.create(path, body);

      // Substrate folder ledger: record new first-level folders under Substrate/
      const substratePrefix = 'Substrate/';
      const ledgerPath = 'Substrate/FolderLedger.md';
      if (path.startsWith(substratePrefix)) {
        const afterPrefix = path.slice(substratePrefix.length);
        const firstSegment = afterPrefix.split('/')[0];
        const isNewFolder = firstSegment && afterPrefix.includes('/');
        if (isNewFolder) {
          const folderPath = substratePrefix + firstSegment;
          const folderExists = app.vault.getAbstractFileByPath(folderPath + '/.keep') !== null;
          if (!folderExists) {
            const isoDate = new Date().toISOString();
            const ledgerLine = `\n- folder: ${firstSegment} | note: ${path} | created: ${isoDate}`;
            const ledgerFile = app.vault.getAbstractFileByPath(ledgerPath);
            if (ledgerFile && 'extension' in ledgerFile) {
              const existingLedger = await app.vault.read(ledgerFile as TFile);
              await app.vault.modify(ledgerFile as TFile, existingLedger + ledgerLine);
            } else {
              await app.vault.create(ledgerPath, `# Folder Ledger\n\nTracks emergent first-level folders created under Substrate/.${ledgerLine}`);
            }
          }
        }
      }
    }
    registerSolicitation(path, p.dispatch_id ?? path);
    return {
      content: JSON.stringify({ wrote: true, path, bytes: body.length }),
      metadata: { shape: 'obsidian:write_note', summary: `wrote ${body.length}b to ${path}`, producedBy: 'obsidian-vessel', dispatch_id: p.dispatch_id },
    };
  } catch (err) {
    return {
      content: JSON.stringify({ wrote: false, error: err instanceof Error ? err.message : String(err), path }),
      metadata: { shape: 'obsidian:write_note', summary: `write failed: ${path}` },
    };
  }
}

registerResolver('obsidian:write_note', resolveWriteNote);
