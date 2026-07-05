/**
 * Goal Note Manager
 *
 * Creates and manages vault notes for goal executions dispatched to
 * goal-host-vessel. Each goal gets a note under Goals/<executionId>.md
 * with YAML frontmatter tracking status, plus a running log of events.
 */

import { registerSolicitation } from '../resolvers/observe-obsidian-events';
import type { App, TFile } from 'obsidian';
import type { GoalHostClient } from './goal-host-client';

const GOALS_FOLDER = 'Goals';

export class GoalNoteManager {
  constructor(private app: App) {}

  /**
   * Ensure the Goals folder exists.
   */
  private async ensureFolder(): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(GOALS_FOLDER);
    if (!existing) {
      await this.app.vault.createFolder(GOALS_FOLDER);
    }
  }

  /**
   * Create a new goal note with initial frontmatter.
   * Returns the TFile, or null if creation fails.
   */
  async createGoalNote(executionId: string, goal: string): Promise<TFile | null> {
    try {
      await this.ensureFolder();

      const startedAt = new Date().toISOString();
      // Escape any backticks or quotes in the goal for safe YAML embedding
      const safeGoal = goal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const content = [
        '---',
        `executionId: "${executionId}"`,
        `goal: "${safeGoal}"`,
        `status: running`,
        `startedAt: "${startedAt}"`,
        `completedAt: null`,
        '---',
        '',
        `# Goal: ${goal}`,
        '',
        `**Execution ID:** \`${executionId}\`  `,
        `**Started:** ${startedAt}`,
        '',
        '## Events',
        '',
      ].join('\n');

      const path = `${GOALS_FOLDER}/${executionId}.md`;
      const file = await this.app.vault.create(path, content);
      registerSolicitation(path, executionId);
      return file;
    } catch (error) {
      console.error('[GoalNoteManager] Failed to create goal note:', error);
      return null;
    }
  }

  /**
   * Append an event line to the goal note.
   * Uses vault.process for atomic, concurrent-safe writes.
   */
  async appendEvent(file: TFile, eventLine: string): Promise<void> {
    try {
      await this.app.vault.process(file, (data) => {
        return data + eventLine + '\n';
      });
    } catch (error) {
      console.error('[GoalNoteManager] Failed to append event:', error);
    }
  }

  /**
   * Update frontmatter to mark the goal complete/failed.
   *
   * When `mintedConcepts` is non-empty, also append a "Concepts produced"
   * section to the note body with wikilinks to each concept's vault note.
   * Concept notes are expected to live under `concepts/<id>.md` — matches
   * the fallback path; the full materialized path computed by
   * `conceptNotePath` may differ but Obsidian's wikilink resolver falls
   * back to basename lookup, so `[[concept_xyz|concept_xyz]]` will still
   * resolve when the ConceptSyncService materializes the note under any
   * `<source_type>/<title>.md` path.
   */
  async markComplete(
    file: TFile,
    status: string,
    mintedConcepts?: Array<{ id: string; summary?: string }>,
  ): Promise<void> {
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.status = status;
        fm.completedAt = new Date().toISOString();
      });

      if (mintedConcepts && mintedConcepts.length > 0) {
        const lines = [
          '',
          '## Concepts produced',
          '',
          ...mintedConcepts.map(c => {
            const path = `concepts/${c.id}`;
            const label = c.summary ? `${c.id}` : c.id;
            const tail = c.summary ? ` — ${c.summary}` : '';
            return `- [[${path}|${label}]]${tail}`;
          }),
          '',
        ];
        await this.app.vault.process(file, (data) => data + lines.join('\n'));
      }
    } catch (error) {
      console.error('[GoalNoteManager] Failed to mark complete:', error);
    }
  }

  /**
   * Live-track a running dispatch into the goal note.
   *
   * Polls goal-host GET /executions/:dispatchId (via client.getDispatchRecord)
   * while the dispatch is running, appending each newly seen walkLog line under
   * the Events section so long-running goals show their walk decisions as they
   * happen. On a terminal status, records the honest reach verdict — `reached`
   * plus goalReachReason and completionShapes — in frontmatter and as a callout
   * directly above the Events section; `status` alone is only exit status.
   *
   * Per-poll errors are swallowed so transient goal-host restarts don't kill
   * tracking. Resolves when the dispatch leaves `running` or on timeout.
   */
  async trackProgress(
    file: TFile,
    dispatchId: string,
    client: GoalHostClient,
    intervalMs = 5000,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let seenWalkLines = 0;

    while (Date.now() < deadline) {
      let record: Record<string, unknown> | null = null;
      try {
        record = await client.getDispatchRecord(dispatchId);
      } catch {
        // transient — goal-host may be restarting mid-walk; keep polling
      }

      if (record) {
        const walkLog = Array.isArray(record.walkLog) ? (record.walkLog as unknown[]) : [];
        if (walkLog.length > seenWalkLines) {
          const fresh = walkLog
            .slice(seenWalkLines)
            .map(l => "- `" + String(l).replace(/`/g, "'") + "`")
            .join('\n');
          seenWalkLines = walkLog.length;
          await this.appendEvent(file, fresh);
        }

        const status = String(record.status ?? 'running');
        if (status !== 'running') {
          await this.writeReachVerdict(file, record);
          return;
        }
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  /**
   * Mirror the goal-reach verdict into frontmatter and insert a verdict
   * callout above the Events section.
   */
  private async writeReachVerdict(file: TFile, record: Record<string, unknown>): Promise<void> {
    const reached = record.reached === true;
    const reason = typeof record.goalReachReason === 'string' ? record.goalReachReason : '';
    const shapes = Array.isArray(record.completionShapes)
      ? (record.completionShapes as unknown[]).map(String)
      : [];
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.status = String(record.status ?? 'completed');
        fm.reached = reached;
        if (reason) fm.goalReachReason = reason;
        fm.completedAt = new Date().toISOString();
      });

      const walkLog = Array.isArray(record.walkLog)
        ? (record.walkLog as unknown[]).map(l =>
            String(l).replace(/^\[goal-host-vessel\] /, '').replace(/`/g, "'"))
        : [];
      const selectedTemplate = typeof record.selectedTemplateId === 'string'
        ? record.selectedTemplateId
        : '';
      const verdict = [
        '',
        `> [!${reached ? 'success' : 'failure'}] ${reached ? 'Goal reached' : 'Goal NOT reached'}`,
        ...(reason ? [`> ${reason}`] : []),
        ...(shapes.length
          ? ['> **Completion shapes:** ' + shapes.map(x => '`' + x + '`').join(', ')]
          : []),
        '',
        '> [!info]- Why',
        ...(selectedTemplate ? ['> **Selected approach:** `' + selectedTemplate + '`'] : []),
        ...(walkLog.length
          ? walkLog.map(l => '> - `' + l + '`')
          : ['> _No walk decision log recorded for this dispatch._']),
        '',
      ].join('\n');

      await this.app.vault.process(file, (data) => {
        const idx = data.indexOf('\n## Events');
        if (idx >= 0) return data.slice(0, idx) + '\n' + verdict + data.slice(idx);
        return data + '\n' + verdict;
      });
    } catch (error) {
      console.error('[GoalNoteManager] Failed to write reach verdict:', error);
    }
  }

  /**
   * Return the TFile for an existing goal note, if it exists.
   */
  getGoalFile(executionId: string): TFile | null {
    const path = `${GOALS_FOLDER}/${executionId}.md`;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f && 'stat' in f) return f as TFile;
    return null;
  }
}
