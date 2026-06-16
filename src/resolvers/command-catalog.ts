/**
 * Resolver — `obsidian:command_catalog`.
 *
 * Exposes Obsidian's self-describing command surface (`app.commands.listCommands()`)
 * as a queryable shape, each entry tagged with its portable authority class
 * (`classifyPermission`) plus the underlying reversibility and deny-glob status.
 *
 * This is the action space the substrate learns over: with the catalog
 * discoverable, the drafter can author goal-directed command sequences and the
 * exerciser can filter to the classes its grant permits — instead of
 * blind-probing fixed ≤10-command slices.
 *
 * READ-only: enumerating the catalog executes nothing.
 */

import type { App } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';
import { classifyReversibility, isCommandAllowedForProbe } from './observation-types';
import {
  classifyPermission,
  requiresContentObservation,
  type PermissionClass,
} from './command-permissions';

interface CommandCatalogPointer {
  /** Optional: only return commands in these authority classes. */
  permission_filter?: PermissionClass[];
  /** Optional: substring match on id or name. */
  query?: string;
}

interface CatalogEntry {
  id: string;
  name: string;
  permission_class: PermissionClass;
  reversibility_class: string;
  deny_blocked: boolean;
  requires_content_observation: boolean;
}

async function resolveCommandCatalog(
  pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const p = pointer as unknown as CommandCatalogPointer;
  const filter = Array.isArray(p.permission_filter) ? p.permission_filter : null;
  const query = typeof p.query === 'string' ? p.query.toLowerCase() : null;

  // The command map IS Obsidian's self-describing surface (id → {id, name});
  // `listCommands()` returns the same data but isn't in the local type stub.
  const listed: Array<{ id: string; name?: string }> = Object.values(
    app.commands?.commands ?? {},
  );

  const entries: CatalogEntry[] = [];
  for (const cmd of listed) {
    const id = cmd?.id;
    if (!id) continue;
    const permission_class = classifyPermission(id);
    if (filter && !filter.includes(permission_class)) continue;
    const name = cmd.name ?? id;
    if (query && !id.toLowerCase().includes(query) && !name.toLowerCase().includes(query)) {
      continue;
    }
    entries.push({
      id,
      name,
      permission_class,
      reversibility_class: classifyReversibility(id),
      deny_blocked: !isCommandAllowedForProbe(id),
      requires_content_observation: requiresContentObservation(permission_class),
    });
  }

  // Stable order: by class privilege then id, so callers get a deterministic
  // exploration frontier.
  const classRank: Record<PermissionClass, number> = {
    read: 0,
    navigate: 1,
    mutate: 2,
    destructive: 3,
  };
  entries.sort((a, b) =>
    classRank[a.permission_class] !== classRank[b.permission_class]
      ? classRank[a.permission_class] - classRank[b.permission_class]
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );

  const byClass = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.permission_class] = (acc[e.permission_class] ?? 0) + 1;
    return acc;
  }, {});

  return {
    content: JSON.stringify({ shape: 'obsidian:command_catalog', commands: entries, by_class: byClass }),
    metadata: {
      shape: 'obsidian:command_catalog',
      summary: `${entries.length} commands (${Object.entries(byClass).map(([k, v]) => `${k}:${v}`).join(', ')})`,
      rowCount: entries.length,
      availableOps: ['execute_command', 'action_effect_model'],
    },
  };
}

registerResolver('obsidian:command_catalog', resolveCommandCatalog);
