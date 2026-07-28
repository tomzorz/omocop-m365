/**
 * Attachment tools.
 *
 * Downloading writes where the caller says and nowhere else; attaching accepts a
 * local file or an attachment on another message, and the second route never
 * touches disk — the bytes go Graph to Graph.
 */
import { basename } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { AnyToolDefinition } from '../server/registry.js';
import {
  checkTotalSize,
  formatSize,
  isImageType,
  KIND_LABELS,
  sanitiseFilename,
} from '../domain/attachments.js';
import { messagePath } from './email-support.js';
import {
  addFileAttachment,
  fetchAttachmentBytes,
  kindOf,
  listAttachments,
  readLocalFile,
  resolveAttachment,
  writeDownload,
  type Attachment,
} from './attachment-support.js';

const READ = 'Mail.Read';
const WRITE = 'Mail.ReadWrite';

const AttachmentSummary = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
  kind: z.string(),
  isInline: z.boolean(),
  contentId: z.string().optional(),
});

const summarise = (attachment: Attachment) => ({
  id: attachment.id,
  name: attachment.name,
  size: attachment.size ?? 0,
  contentType: attachment.contentType ?? 'unknown',
  kind: KIND_LABELS[kindOf(attachment)],
  isInline: attachment.isInline === true,
  ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
});

/* -------------------------------------------------------------------------- */

const listAttachmentsTool = defineTool({
  name: 'list-attachments',
  title: 'List an email\'s attachments',
  description:
    'Lists the attachments on a message — filename, size, type and id. Inline images are ' +
    'marked as such, and their contentId matches the cid references in the body Markdown ' +
    'that read-email returns.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: { messageId: z.string() },
  output: {
    attachments: z.array(AttachmentSummary),
    totalSize: z.number(),
  },
  handler: async (args, ctx) => {
    const attachments = await listAttachments(ctx.graph, args.messageId);
    return {
      attachments: attachments.map(summarise),
      totalSize: attachments.reduce((sum, a) => sum + (a.size ?? 0), 0),
    };
  },
  render: (data) => {
    if (data.attachments.length === 0) return 'That message has no attachments.';

    const lines = data.attachments.map((attachment, index) => {
      const marks = [attachment.kind];
      if (attachment.isInline) marks.push('inline');
      return (
        `${index + 1}. ${attachment.name}\n` +
        `   ${formatSize(attachment.size)} — ${attachment.contentType} (${marks.join(', ')})\n` +
        `   ID: ${attachment.id}`
      );
    });

    return (
      `${data.attachments.length} attachment(s), ${formatSize(data.totalSize)} total:\n\n` +
      `${lines.join('\n\n')}\n\n` +
      'Use download-attachment with the filename or the ID to save one.'
    );
  },
});

/* -------------------------------------------------------------------------- */

const downloadAttachment = defineTool({
  name: 'download-attachment',
  title: 'Download an attachment',
  description:
    'Saves an attachment to a local path. The destination is chosen by the caller — a file ' +
    'path, or an existing directory to save into under the attachment\'s own name. Nothing ' +
    'is overwritten unless overwrite is true.',
  scopes: [READ],
  input: {
    messageId: z.string(),
    destination: z
      .string()
      .describe('A full file path, or a directory to save into. Parent directories are created.'),
    attachment: z
      .string()
      .optional()
      .describe(
        'Filename or attachment id. A partial filename works when unambiguous. Optional ' +
          'when the message has exactly one attachment.',
      ),
    overwrite: z.boolean().optional().describe('Replace an existing file. Default false.'),
  },
  output: {
    /** The attachment that was downloaded, under the sender's name for it. */
    name: z.string(),
    /** Present only when sanitising changed the filename on the way to disk. */
    savedAs: z.string().optional(),
    size: z.number(),
    path: z.string(),
  },
  handler: async (args, ctx) => {
    const attachments = await listAttachments(ctx.graph, args.messageId);

    if (attachments.length === 0) throw new Error('That message has no attachments.');

    let target: Attachment;
    if (args.attachment) {
      const resolution = resolveAttachment(attachments, args.attachment);
      if (resolution.kind !== 'matched') throw new Error(resolution.message);
      target = resolution.item;
    } else if (attachments.length === 1) {
      target = attachments[0] as Attachment;
    } else {
      throw new Error(
        `That message has ${attachments.length} attachments: ` +
          `${attachments.map((a) => `"${a.name}"`).join(', ')}. ` +
          'Say which one by passing its filename or id as `attachment`.',
      );
    }

    const buffer = await fetchAttachmentBytes(ctx.graph, args.messageId, target);
    const path = await writeDownload(
      args.destination,
      target.name,
      buffer,
      args.overwrite === true,
    );

    // The attachment keeps its own name in the report, and the path says where it
    // landed. Only a filename changed by *sanitising* is worth remarking on — a
    // caller who gave an explicit path renamed it deliberately.
    const written = basename(path);
    const sanitised = sanitiseFilename(target.name);
    const alteredForSafety = sanitised !== target.name && written === sanitised;

    return {
      name: target.name,
      ...(alteredForSafety ? { savedAs: written } : {}),
      size: buffer.length,
      path,
    };
  },
  render: (data) =>
    `Saved "${data.name}" (${formatSize(data.size)}) to:\n${data.path}` +
    (data.savedAs
      ? `\n\nThe sender's filename could not be used as-is; it was written as "${data.savedAs}".`
      : ''),
});

/* -------------------------------------------------------------------------- */

const addAttachment = defineTool({
  name: 'add-attachment',
  title: 'Attach files to a draft',
  description:
    'Attaches files to an existing DRAFT, from local paths and/or by copying an attachment ' +
    'off another message. Copying never touches disk. Files over 3MB are uploaded in chunks ' +
    'automatically. A sent message cannot be changed — create a new draft instead.',
  scopes: [WRITE],
  input: {
    messageId: z.string().describe('Draft id, as returned by draft-email'),
    filePath: z.array(z.string()).optional().describe('Local file paths to attach'),
    fromMessageId: z.string().optional().describe('Another message to copy an attachment from'),
    fromAttachment: z
      .string()
      .optional()
      .describe('Filename or id to copy from fromMessageId. Required alongside it.'),
    name: z.string().optional().describe('Rename the copied attachment'),
  },
  output: {
    messageId: z.string(),
    subject: z.string(),
    attached: z.array(z.object({ name: z.string(), size: z.number(), chunked: z.boolean() })),
  },
  handler: async (args, ctx) => {
    const paths = args.filePath ?? [];

    if (paths.length === 0 && !args.fromMessageId) {
      throw new Error(
        'Nothing to attach. Pass `filePath` to attach local files, or `fromMessageId` plus ' +
          '`fromAttachment` to copy an attachment off another message.',
      );
    }
    if (args.fromMessageId && !args.fromAttachment) {
      throw new Error(
        '`fromAttachment` is required alongside `fromMessageId` — the filename or id to ' +
          'copy. Use list-attachments on that message to see the options.',
      );
    }

    // Only drafts accept new attachments; catching it here beats a raw Graph error.
    const draft = await ctx.graph.get<{ subject?: string; isDraft?: boolean }>(
      messagePath(args.messageId),
      { $select: 'id,subject,isDraft' },
    );
    if (draft.isDraft === false) {
      throw new Error(
        `"${draft.subject ?? args.messageId}" has already been sent, and Outlook does not ` +
          'allow attachments to be added to a sent message. Create a new draft instead.',
      );
    }

    // Read and size-check everything before uploading any of it, so a bad path or
    // an oversized set fails without leaving a half-filled draft behind.
    const files = await Promise.all(paths.map((path) => readLocalFile(path)));

    const existing = await listAttachments(ctx.graph, args.messageId);
    const tooBig = checkTotalSize(
      files,
      existing.reduce((sum, a) => sum + (a.size ?? 0), 0),
    );
    if (tooBig) throw new Error(tooBig);

    const attached: Array<{ name: string; size: number; chunked: boolean }> = [];

    for (const file of files) {
      attached.push(await addFileAttachment(ctx.graph, args.messageId, file));
    }

    if (args.fromMessageId && args.fromAttachment) {
      const source = await listAttachments(ctx.graph, args.fromMessageId);
      const resolution = resolveAttachment(source, args.fromAttachment);
      if (resolution.kind !== 'matched') throw new Error(resolution.message);

      const buffer = await fetchAttachmentBytes(
        ctx.graph,
        args.fromMessageId,
        resolution.item,
      );
      attached.push(
        await addFileAttachment(ctx.graph, args.messageId, {
          name: args.name ?? resolution.item.name,
          buffer,
          contentType: resolution.item.contentType ?? 'application/octet-stream',
        }),
      );
    }

    return {
      messageId: args.messageId,
      subject: draft.subject ?? args.messageId,
      attached,
    };
  },
  render: (data) =>
    `Attached to "${data.subject}":\n` +
    data.attached
      .map(
        (file) =>
          `- ${file.name} (${formatSize(file.size)}${file.chunked ? ', uploaded in chunks' : ''})`,
      )
      .join('\n'),
});

export const attachmentTools: AnyToolDefinition[] = [
  listAttachmentsTool,
  downloadAttachment,
  addAttachment,
];

export { isImageType };
