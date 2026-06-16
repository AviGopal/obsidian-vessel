/**
 * Execution ID Modal
 *
 * Prompts the user to enter an execution ID to create a note from.
 */

import { App, Modal, Setting, Notice } from 'obsidian';

export class ExecutionIdModal extends Modal {
  private executionId: string = '';
  private onSubmit: (id: string) => Promise<void>;

  constructor(app: App, onSubmit: (id: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('metabob-execution-id-modal');

    contentEl.createEl('h2', { text: 'Enter Execution ID' });

    contentEl.createEl('p', {
      text: 'Enter the execution trace ID to create a note from. You can find execution IDs in the activity dashboard or in execution logs.',
      cls: 'modal-description'
    });

    new Setting(contentEl)
      .setName('Execution ID')
      .setDesc('The execution trace ID to create a note from')
      .addText(text => {
        text
          .setPlaceholder('exec_abc123 or trace_xyz789')
          .onChange(value => {
            this.executionId = value.trim();
          });

        // Auto-focus the input
        text.inputEl.focus();

        // Submit on Enter key
        text.inputEl.addEventListener('keydown', async (event) => {
          if (event.key === 'Enter' && this.executionId) {
            event.preventDefault();
            await this.handleSubmit();
          }
        });
      });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Cancel')
        .onClick(() => this.close()))
      .addButton(btn => btn
        .setButtonText('Create Note')
        .setCta()
        .onClick(async () => {
          await this.handleSubmit();
        }));

    // Example IDs for reference
    const exampleSection = contentEl.createDiv('example-section');
    exampleSection.createEl('p', {
      text: 'Example formats:',
      cls: 'example-header'
    });
    const exampleList = exampleSection.createEl('ul', { cls: 'example-list' });
    exampleList.createEl('li', { text: 'exec_2024_01_15_abc123' });
    exampleList.createEl('li', { text: 'trace:activity_template_v1:12345' });
    exampleList.createEl('li', { text: 'execution_id:uuid-format' });
  }

  private async handleSubmit() {
    if (!this.executionId) {
      new Notice('Please enter an execution ID');
      return;
    }

    const submitBtn = this.contentEl.querySelector('.mod-cta') as HTMLButtonElement;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';
    }

    try {
      await this.onSubmit(this.executionId);
      this.close();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to create note: ${errorMessage}`);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Note';
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
