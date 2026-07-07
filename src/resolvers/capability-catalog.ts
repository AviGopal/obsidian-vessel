import type { ImpulsePointer, ResolverResult } from './types';

interface CapabilityEntry {
  shape: string;
  description: string;
  input_pointer_schema: Record<string, unknown>;
  example_body: Record<string, unknown>;
}

const CATALOG: CapabilityEntry[] = [
  {
    shape: 'obsidian:note',
    description: 'Retrieve the full content of a note by its vault path.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:note' },
        path: { type: 'string', description: 'Vault-relative path to the note, e.g. "folder/note.md"' },
      },
      required: ['type', 'path'],
    },
    example_body: { path: 'folder/note.md' },
  },
  {
    shape: 'obsidian:search',
    description: 'Full-text search across the Obsidian vault, returning matching note paths and excerpts.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:search' },
        query: { type: 'string', description: 'Search query string' },
        limit: { type: 'number', description: 'Maximum number of results to return' },
      },
      required: ['type', 'query'],
    },
    example_body: { query: 'meeting notes', limit: 10 },
  },
  {
    shape: 'obsidian:execute_command',
    description: 'Execute a named Obsidian command by its command ID.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:execute_command' },
        commandId: { type: 'string', description: 'The Obsidian command ID to execute' },
      },
      required: ['type', 'commandId'],
    },
    example_body: { commandId: 'editor:toggle-bold' },
  },
  {
    shape: 'obsidian:list_notes',
    description: 'List all notes in the vault or a specific folder.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:list_notes' },
        folder: { type: 'string', description: 'Optional folder path to list notes within' },
      },
      required: ['type'],
    },
    example_body: { folder: 'projects' },
  },
  {
    shape: 'obsidian:create_note',
    description: 'Create a new note in the vault at the specified path with given content.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:create_note' },
        path: { type: 'string', description: 'Vault-relative path for the new note' },
        content: { type: 'string', description: 'Markdown content for the new note' },
      },
      required: ['type', 'path', 'content'],
    },
    example_body: { path: 'ideas/new-idea.md', content: '# New Idea\n\nContent here.' },
  },
  {
    shape: 'obsidian:update_note',
    description: 'Update the content of an existing note in the vault.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:update_note' },
        path: { type: 'string', description: 'Vault-relative path of the note to update' },
        content: { type: 'string', description: 'New markdown content for the note' },
      },
      required: ['type', 'path', 'content'],
    },
    example_body: { path: 'folder/note.md', content: '# Updated\n\nNew content.' },
  },
  {
    shape: 'obsidian:delete_note',
    description: 'Delete a note from the vault by its path.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:delete_note' },
        path: { type: 'string', description: 'Vault-relative path of the note to delete' },
      },
      required: ['type', 'path'],
    },
    example_body: { path: 'folder/old-note.md' },
  },
  {
    shape: 'obsidian:get_tags',
    description: 'Retrieve all tags used across the vault or within a specific note.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:get_tags' },
        path: { type: 'string', description: 'Optional note path to scope tag retrieval' },
      },
      required: ['type'],
    },
    example_body: {},
  },
  {
    shape: 'obsidian:command_catalog',
    description: 'List all available Obsidian commands with their IDs and names.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:command_catalog' },
      },
      required: ['type'],
    },
    example_body: {},
  },
  {
    shape: 'obsidian:capability_catalog',
    description: 'List all capabilities (resolvable shapes) provided by this obsidian vessel, with schemas and examples.',
    input_pointer_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'obsidian:capability_catalog' },
      },
      required: ['type'],
    },
    example_body: {},
  },
];

export async function resolveCapabilityCatalog(
  _pointer: ImpulsePointer,
): Promise<ResolverResult> {
  const content = JSON.stringify({ entries: CATALOG });
  return { content };
}

