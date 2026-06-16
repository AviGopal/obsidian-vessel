import { App, TFile, TFolder } from 'obsidian';
import { CanvasData } from '../types/canvas';
import { MetabobVesselSettings } from '../settings';

/**
 * Manages Obsidian canvas file operations.
 * Handles creating, reading, updating, and opening canvas files.
 */
export class CanvasManager {
  constructor(
    private app: App,
    private settings: MetabobVesselSettings
  ) {}

  /**
   * Create or update a canvas file with the given data.
   * Creates the parent folder if it doesn't exist.
   */
  async createOrUpdateCanvas(
    name: string,
    data: CanvasData
  ): Promise<TFile> {
    const path = this.getCanvasPath(name);
    const content = JSON.stringify(data, null, 2);

    // Ensure folder exists
    await this.ensureFolderExists(path);

    // Create or update
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    } else {
      return await this.app.vault.create(path, content);
    }
  }

  /**
   * Read canvas data from a file.
   * Returns null if the file doesn't exist or is invalid.
   */
  async readCanvas(name: string): Promise<CanvasData | null> {
    const path = this.getCanvasPath(name);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (!(file instanceof TFile)) {
      return null;
    }

    try {
      const content = await this.app.vault.read(file);
      return JSON.parse(content) as CanvasData;
    } catch (error) {
      console.error(`Failed to read canvas ${name}:`, error);
      return null;
    }
  }

  /**
   * Open a canvas file in the workspace.
   */
  async openCanvas(name: string): Promise<void> {
    const path = this.getCanvasPath(name);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (file instanceof TFile) {
      await this.app.workspace.openLinkText(path, '', true);
    } else {
      throw new Error(`Canvas not found: ${name}`);
    }
  }

  /**
   * Delete a canvas file.
   */
  async deleteCanvas(name: string): Promise<void> {
    const path = this.getCanvasPath(name);
    const file = this.app.vault.getAbstractFileByPath(path);

    if (file instanceof TFile) {
      await this.app.vault.delete(file);
    }
  }

  /**
   * List all canvas files in the canvas folder.
   */
  async listCanvases(): Promise<string[]> {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.canvasFolder);

    if (!(folder instanceof TFolder)) {
      return [];
    }

    return folder.children
      .filter((file): file is TFile => file instanceof TFile && file.extension === 'canvas')
      .map(file => file.basename);
  }

  /**
   * Check if a canvas exists.
   */
  canvasExists(name: string): boolean {
    const path = this.getCanvasPath(name);
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile;
  }

  /**
   * Merge new data into an existing canvas, preserving manual changes.
   * New nodes are added, existing nodes are updated only if auto-generated.
   */
  async mergeCanvas(
    name: string,
    newData: CanvasData,
    options: { preserveManualNodes?: boolean } = {}
  ): Promise<TFile> {
    const existing = await this.readCanvas(name);

    if (!existing) {
      return this.createOrUpdateCanvas(name, newData);
    }

    const mergedNodes = [...existing.nodes];
    const mergedEdges = [...existing.edges];

    // Track existing node IDs
    const existingNodeIds = new Set(existing.nodes.map(n => n.id));
    const existingEdgeIds = new Set(existing.edges.map(e => e.id));

    // Add new nodes
    for (const node of newData.nodes) {
      if (!existingNodeIds.has(node.id)) {
        mergedNodes.push(node);
      } else if (!options.preserveManualNodes) {
        // Update existing node
        const index = mergedNodes.findIndex(n => n.id === node.id);
        if (index !== -1) {
          mergedNodes[index] = node;
        }
      }
    }

    // Add new edges
    for (const edge of newData.edges) {
      if (!existingEdgeIds.has(edge.id)) {
        mergedEdges.push(edge);
      }
    }

    return this.createOrUpdateCanvas(name, {
      nodes: mergedNodes,
      edges: mergedEdges
    });
  }

  /**
   * Get the full path for a canvas file.
   */
  private getCanvasPath(name: string): string {
    // Remove .canvas extension if provided
    const baseName = name.endsWith('.canvas') ? name.slice(0, -7) : name;
    return `${this.settings.canvasFolder}/${baseName}.canvas`;
  }

  /**
   * Ensure the folder for a file path exists.
   */
  private async ensureFolderExists(filePath: string): Promise<void> {
    const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));

    if (!folderPath) {
      return;
    }

    const folder = this.app.vault.getAbstractFileByPath(folderPath);

    if (!folder) {
      // Create folder recursively
      await this.createFolderRecursive(folderPath);
    }
  }

  /**
   * Create a folder and all parent folders if they don't exist.
   */
  private async createFolderRecursive(folderPath: string): Promise<void> {
    const parts = folderPath.split('/').filter(p => p.length > 0);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);

      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }
}
