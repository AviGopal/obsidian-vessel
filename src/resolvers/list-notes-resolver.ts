import type { App } from 'obsidian';
import type { ImpulsePointer, ResolverResult } from './types';

export async function resolveListNotes(
  pointer: ImpulsePointer,
  app: App
): Promise<ResolverResult> {
  const p = pointer as { type: string; folder?: string; limit?: number };
  const limit = p.limit ?? 500;

  let files = app.vault.getMarkdownFiles();

  if (p.folder) {
    const prefix = p.folder.endsWith('/') ? p.folder : p.folder + '/';
    files = files.filter(f => f.path.startsWith(prefix));
  }

  files = files.slice(0, limit);
  const paths = files.map(f => f.path);

  return {
    content: JSON.stringify({
      folder: p.folder ?? null,
      count: paths.length,
      paths
    }),
    metadata: {
      shape: 'obsidian:list_notes',
      count: paths.length
    }
  };
}
