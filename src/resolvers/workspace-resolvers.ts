/**
 * Workspace resolvers — expose UI state + UI management as discoverable
 * impulse shapes instead of bespoke HTTP routes.
 *
 * Closes the foundation drift the substrate flagged (capability-as-route-not-
 * shape): the observe-UI-state and open-note capabilities previously lived only
 * at GET /observations/status and POST /actions/open-note, so the substrate
 * could not discover them through the registry. Now they are first-class shapes:
 *
 *   - obsidian:workspace_state  (observe): active file, open notes, goal-dispatch
 *                               panel state, vault file count — current UI state.
 *   - obsidian:open_note        (manage): open a note in the Obsidian UI by path.
 *
 * Both use only the `app` handed to every resolver, so they need no plugin-
 * instance context. Principle: capabilities are impulse shapes, discovered via
 * the registry — not hardcoded routes.
 */

import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { registerResolver } from './index';
import type { ImpulsePointer, ResolverResult } from './types';

const VIEW_TYPE_GOAL_DISPATCH = 'obsidian-goal-dispatch';

/** obsidian:workspace_state — read-only snapshot of the live Obsidian UI state. */
export async function resolveWorkspaceState(
  _pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const activeFile = app.workspace.getActiveFile()?.path ?? null;
  const openNotePaths = app.workspace
    .getLeavesOfType('markdown')
    .map((leaf: WorkspaceLeaf) => {
      const file = (leaf.view as { file?: TFile } | undefined)?.file;
      return file ? file.path : null;
    })
    .filter((p): p is string => p !== null);
  const goalDispatchOpen =
    app.workspace.getLeavesOfType(VIEW_TYPE_GOAL_DISPATCH).length > 0;
  const vaultFileCount = app.vault.getMarkdownFiles().length;

  const state = { activeFile, openNotePaths, goalDispatchOpen, vaultFileCount };
  return {
    content: JSON.stringify(state),
    metadata: {
      shape: 'obsidian:workspace_state',
      summary: `Workspace: active=${activeFile ?? 'none'}, ${openNotePaths.length} open, goalDispatch=${goalDispatchOpen}, ${vaultFileCount} notes`,
      availableOps: ['observe'],
      ...state,
    },
  };
}

/** obsidian:open_note — open a note in the Obsidian UI by path (manage). */
export async function resolveOpenNote(
  pointer: ImpulsePointer,
  app: App,
): Promise<ResolverResult> {
  const path = (pointer as { path?: string }).path;
  if (!path || typeof path !== 'string') {
    throw new Error('obsidian:open_note requires a `path`');
  }
  // `false` = open in the current leaf rather than a new split.
  await app.workspace.openLinkText(path, '', false);
  return {
    content: '',
    metadata: {
      shape: 'obsidian:open_note',
      summary: `Opened ${path}`,
      availableOps: ['open'],
      path,
    },
  };
}

registerResolver('obsidian:workspace_state', resolveWorkspaceState);
registerResolver('obsidian:open_note', resolveOpenNote);

// ---------------------------------------------------------------------------
// obsidian:reload_plugin
// ---------------------------------------------------------------------------

const resolveReloadPlugin = {
  shape: 'obsidian:reload_plugin',
  resolve: async (_pointer: ImpulsePointer, app: App): Promise<ResolverResult> => {
    const pluginId = 'obsidian-vessel';
    const result: ResolverResult = {
      content: '',
      metadata: {
        shape: 'obsidian:reload_plugin',
        summary: `Reloading plugin ${pluginId}`,
        availableOps: ['reload'],
      },
    };
    setTimeout(async () => {
      try {
        const plugins = (app as any).plugins;
        await plugins.disablePlugin(pluginId);
        await plugins.enablePlugin(pluginId);
      } catch (err) {
        console.error('[obsidian-vessel] reload_plugin failed:', err);
      }
    }, 150);
    return result;
  },
};

registerResolver('obsidian:reload_plugin', resolveReloadPlugin.resolve);

// ---------------------------------------------------------------------------
// obsidian:dispatch_goal
// ---------------------------------------------------------------------------

const resolveDispatchGoal = {
  shape: 'obsidian:dispatch_goal',
  resolve: async (pointer: ImpulsePointer, app: App): Promise<ResolverResult> => {
    const goal = (pointer as any).goal as string;
    if (!goal) {
      throw new Error('obsidian:dispatch_goal requires a goal string in the pointer');
    }
    const plugin = (app as any).plugins?.plugins?.['obsidian-vessel'];
    if (plugin && typeof plugin.activateGoalDispatchView === 'function') {
      await plugin.activateGoalDispatchView();
    }
    const leaves = app.workspace.getLeavesOfType('obsidian-goal-dispatch');
    const leaf = leaves[0];
    if (leaf) {
      const view = leaf.view as any;
      if (view && typeof view.dispatchGoal === 'function') {
        Promise.resolve(view.dispatchGoal(goal)).catch((err: unknown) =>
          console.error('[obsidian-vessel] dispatchGoal failed:', err)
        );
      }
    }
    return {
      content: '',
      metadata: {
        shape: 'obsidian:dispatch_goal',
        summary: `Dispatched goal: ${goal}`,
        availableOps: ['dispatch'],
      },
    };
  },
};

registerResolver('obsidian:dispatch_goal', resolveDispatchGoal.resolve);
