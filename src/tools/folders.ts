/**
 * Mail folder tools.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { AnyToolDefinition } from '../server/registry.js';
import { gpath } from '../graph/path.js';
import {
  FOLDER_ARG,
  fetchFlatFolders,
  messagePath,
  requireFolder,
  resolvedFolder,
} from './email-support.js';

const READ = 'Mail.Read';
const WRITE = 'Mail.ReadWrite';

const listFolders = defineTool({
  name: 'list-folders',
  title: 'List mail folders',
  description:
    'Lists every mail folder with its full path, including nested ones. Use a path like ' +
    '"Inbox/Receipts" to name a folder unambiguously when two share a name.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {},
  output: {
    folders: z.array(
      z.object({ id: z.string(), name: z.string(), path: z.string(), depth: z.number() }),
    ),
  },
  handler: async (_args, ctx) => ({ folders: await fetchFlatFolders(ctx.graph) }),
  render: (data) => {
    if (data.folders.length === 0) return 'No mail folders found.';
    const lines = data.folders
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((folder) => `${'  '.repeat(folder.depth)}- ${folder.name}    (${folder.path})`);
    return `${data.folders.length} folder(s):\n\n${lines.join('\n')}`;
  },
});

/* -------------------------------------------------------------------------- */

const createFolder = defineTool({
  name: 'create-folder',
  title: 'Create a mail folder',
  description: 'Creates a mail folder, optionally inside an existing one.',
  scopes: [WRITE],
  input: {
    name: z.string().min(1).describe('Name for the new folder'),
    parentFolder: FOLDER_ARG.optional().describe(
      'Folder to create it inside. Omit to create at the top level.',
    ),
  },
  output: { id: z.string(), name: z.string(), parent: z.string().optional() },
  policies: [requireFolder('parentFolder')],
  handler: async (args, ctx) => {
    const parent = resolvedFolder(ctx);
    const path = parent
      ? gpath`me/mailFolders/${parent.id}/childFolders`
      : 'me/mailFolders';

    const created = await ctx.graph.post<{ id: string; displayName?: string }>(path, {
      displayName: args.name,
    });

    return {
      id: created.id,
      name: created.displayName ?? args.name,
      ...(parent ? { parent: parent.path } : {}),
    };
  },
  render: (data) =>
    `Created folder "${data.name}"${data.parent ? ` inside ${data.parent}` : ' at the top level'}.\n` +
    `ID: ${data.id}`,
});

/* -------------------------------------------------------------------------- */

const moveEmails = defineTool({
  name: 'move-emails',
  title: 'Move emails to a folder',
  description:
    'Moves one or more messages into a folder. The destination may be a name, a path like ' +
    '"Inbox/Receipts", or a well-known name such as archive.',
  scopes: [WRITE],
  input: {
    messageIds: z.array(z.string()).min(1).describe('Message ids to move'),
    destinationFolder: FOLDER_ARG.describe('Folder to move them into'),
  },
  output: {
    moved: z.array(z.object({ id: z.string(), newId: z.string() })),
    failed: z.array(z.object({ id: z.string(), reason: z.string() })),
    destination: z.string(),
  },
  policies: [requireFolder('destinationFolder', { required: true })],
  handler: async (args, ctx) => {
    const destination = resolvedFolder(ctx);
    // requireFolder({ required: true }) refuses before the handler runs, so a
    // null here means the policy list was edited out from under this tool.
    if (!destination) throw new Error('requireFolder did not resolve a destination');

    const moved: Array<{ id: string; newId: string }> = [];
    const failed: Array<{ id: string; reason: string }> = [];

    // One message failing must not lose the rest, so each is reported separately
    // rather than the whole call failing.
    for (const id of args.messageIds) {
      try {
        const result = await ctx.graph.post<{ id: string }>(`${messagePath(id)}/move`, {
          destinationId: destination.id,
        });
        moved.push({ id, newId: result.id });
      } catch (error) {
        failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { moved, failed, destination: destination.path };
  },
  render: (data) =>
    `Moved ${data.moved.length} message(s) to ${data.destination}.` +
    (data.failed.length
      ? `\n\n${data.failed.length} could not be moved:\n` +
        data.failed.map((f) => `- ${f.id}: ${f.reason}`).join('\n')
      : '') +
    (data.moved.length
      ? '\n\nNote: moving a message changes its id. The new ids are in the structured result.'
      : ''),
});

export const folderTools: AnyToolDefinition[] = [listFolders, createFolder, moveEmails];
