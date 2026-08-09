/**
 * Attachment plumbing.
 *
 * The only place in this server that touches the filesystem — reading a file to
 * attach, and writing one that was downloaded. Every decision about *whether*
 * and *where* is made by the pure functions in `domain/attachments.ts`; this
 * module does the I/O and the Graph calls.
 */
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { GraphClient } from '../graph/client.js';
import { gpath } from '../graph/path.js';
import { resolveByName, type Resolution } from '../domain/resolve.js';
import {
  checkDownloadSize,
  chooseTargetPath,
  chunkRanges,
  classifyAttachment,
  contentTypeFor,
  formatSize,
  needsUploadSession,
  type AttachmentKind,
} from '../domain/attachments.js';

/** An attachment as Graph lists it. Content is deliberately not selected. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly isInline?: boolean;
  readonly contentId?: string;
  readonly '@odata.type'?: string;
}

// contentId lives on the fileAttachment subtype, not the attachment base type,
// so selecting it bare is a 400 against live Graph — it must be cast. The
// response still carries it as plain `contentId`. (Verified live 2026-07-29.)
export const ATTACHMENT_SELECT =
  'id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId';

export const attachmentsPath = (messageId: string): string =>
  gpath`me/messages/${messageId}/attachments`;

export const attachmentPath = (messageId: string, attachmentId: string): string =>
  gpath`me/messages/${messageId}/attachments/${attachmentId}`;

/** Lists a message's attachments. */
export async function listAttachments(
  graph: GraphClient,
  messageId: string,
): Promise<Attachment[]> {
  const { items } = await graph.collect<Attachment>(attachmentsPath(messageId), {
    $select: ATTACHMENT_SELECT,
  });
  return items;
}

/** Resolves an attachment reference by id, filename, or unambiguous partial. */
export function resolveAttachment(
  attachments: readonly Attachment[],
  ref: string,
): Resolution<Attachment> {
  return resolveByName(attachments, ref, {
    id: (a) => a.id,
    name: (a) => a.name,
    label: 'attachment',
  });
}

export const kindOf = (attachment: Attachment): AttachmentKind =>
  classifyAttachment(attachment['@odata.type']);

/**
 * Fetches an attachment's bytes.
 *
 * `/$value` is used rather than the base64 `contentBytes` field because it is the
 * one route that serves both file attachments and embedded messages.
 */
export async function fetchAttachmentBytes(
  graph: GraphClient,
  messageId: string,
  attachment: Attachment,
): Promise<Buffer> {
  if (kindOf(attachment) === 'reference') {
    throw new Error(
      `"${attachment.name}" is a link to a cloud file rather than stored content. Open it ` +
        `from the message, or fetch the file from its own service.`,
    );
  }

  const tooBig = checkDownloadSize(attachment.name, attachment.size);
  if (tooBig) throw new Error(tooBig);

  return graph.bytes(`${attachmentPath(messageId, attachment.id)}/$value`);
}

export interface LocalFile {
  readonly name: string;
  readonly buffer: Buffer;
  readonly contentType: string;
  readonly size: number;
}

/** Reads a local file for attaching, failing clearly when it cannot. */
export async function readLocalFile(filePath: string): Promise<LocalFile> {
  let stats;
  try {
    stats = statSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      `Cannot read "${filePath}": ${code === 'ENOENT' ? 'no such file' : (code ?? String(error))}`,
    );
  }

  if (stats.isDirectory()) throw new Error(`"${filePath}" is a directory, not a file.`);

  const buffer = await readFile(filePath);
  return {
    name: basename(filePath),
    buffer,
    contentType: contentTypeFor(filePath),
    size: buffer.length,
  };
}

/**
 * Adds a file attachment, choosing the simple or chunked route by size.
 *
 * Above 3 MB Graph refuses inline content outright, so the caller would
 * otherwise have to know the threshold. It does not.
 */
export async function addFileAttachment(
  graph: GraphClient,
  messageId: string,
  file: { name: string; buffer: Buffer; contentType: string; isInline?: boolean },
): Promise<{ name: string; size: number; chunked: boolean }> {
  const size = file.buffer.length;

  if (!needsUploadSession(size)) {
    await graph.post(attachmentsPath(messageId), {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.name,
      contentType: file.contentType,
      isInline: file.isInline === true,
      contentBytes: file.buffer.toString('base64'),
    });
    return { name: file.name, size, chunked: false };
  }

  const session = await graph.post<{ uploadUrl?: string }>(
    `${attachmentsPath(messageId)}/createUploadSession`,
    {
      AttachmentItem: {
        attachmentType: 'file',
        name: file.name,
        size,
        contentType: file.contentType,
      },
    },
  );

  if (!session.uploadUrl) {
    throw new Error('Graph did not return an upload URL for the attachment session.');
  }

  for (const { start, end } of chunkRanges(size)) {
    await graph.uploadChunk(session.uploadUrl, file.buffer.subarray(start, end), start, size);
  }

  return { name: file.name, size, chunked: true };
}

/**
 * Writes downloaded bytes to the caller's destination.
 *
 * Nothing is overwritten without being asked, because an attachment name is
 * chosen by whoever sent the message.
 */
export async function writeDownload(
  destination: string,
  attachmentName: string,
  buffer: Buffer,
  overwrite: boolean,
): Promise<string> {
  const isDirectory = existsSync(destination) && statSync(destination).isDirectory();
  const { path, parent } = chooseTargetPath(destination, attachmentName, isDirectory);

  if (existsSync(path) && !overwrite) {
    throw new Error(`"${path}" already exists. Pass overwrite:true to replace it.`);
  }

  await mkdir(parent, { recursive: true });
  await writeFile(path, buffer);
  return path;
}

/** Describes an attachment for a listing. */
export const describeAttachment = (attachment: Attachment): string =>
  `${attachment.name} (${formatSize(attachment.size)}, ${attachment.contentType ?? 'unknown type'})`;
