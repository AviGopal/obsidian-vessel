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

import type { App, TFile } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';
import { registerResolver } from './index';

interface WriteNotePointer {
  type: string;
  /** Vault-relative path; MUST be under an allowed prefix. */
  path?: string;
  /** Full markdown body to write. */
  content?: string;
  /** Override allowed prefixes (default ['Substrate/']). */
  allowed_prefixes?: string[];
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
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing && 'stat' in existing) {
      await app.vault.modify(existing as TFile, content);
    } else {
      await app.vault.create(path, content);
    }
    return {
      content: JSON.stringify({ wrote: true, path, bytes: content.length }),
      metadata: { shape: 'obsidian:write_note', summary: `wrote ${content.length}b to ${path}`, producedBy: 'obsidian-vessel' },
    };
  } catch (err) {
    return {
      content: JSON.stringify({ wrote: false, error: err instanceof Error ? err.message : String(err), path }),
      metadata: { shape: 'obsidian:write_note', summary: `write failed: ${path}` },
    };
  }
}

registerResolver('obsidian:write_note', resolveWriteNote);
