/**
 * Goal Input Modal
 *
 * A simple Modal that prompts the user for a goal string and calls
 * a callback with the entered text. Submitted on button click or Enter key.
 */

import { App, Modal, Setting } from 'obsidian';

export class GoalInputModal extends Modal {
  private goal = '';
  private onSubmit: (goal: string) => void;

  constructor(app: App, onSubmit: (goal: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('metabob-goal-input-modal');

    contentEl.createEl('h2', { text: 'Dispatch Goal to Substrate' });
    contentEl.createEl('p', {
      text: 'Describe what you want the substrate to do. The goal will be sent to goal-host-vessel.',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('Goal')
      .setDesc('Plain-language description of the goal')
      .addTextArea((ta) => {
        ta.setPlaceholder('e.g. Fix the failing tests in metabob-activity-api');
        ta.onChange((value) => {
          this.goal = value.trim();
        });
        // Focus
        ta.inputEl.style.width = '100%';
        ta.inputEl.rows = 4;
        ta.inputEl.focus();
        ta.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
            ev.preventDefault();
            this.submit();
          }
        });
      });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText('Dispatch')
          .setCta()
          .onClick(() => this.submit()),
      );

    contentEl.createEl('p', {
      text: 'Tip: Ctrl+Enter to dispatch quickly.',
      cls: 'setting-item-description',
    });
  }

  private submit(): void {
    if (!this.goal) return;
    this.close();
    this.onSubmit(this.goal);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
