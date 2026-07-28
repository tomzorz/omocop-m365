/**
 * Attachment rules.
 *
 * Two size thresholds decide almost everything here, and both are Graph's rather
 * than ours:
 *
 *   - **3 MB** — above it Graph refuses inline content and requires an upload
 *     session. Callers should never have to know that, so the routing is decided
 *     here and the transport follows.
 *   - **~25 MB** — Exchange rejects the whole message, at send time, with an
 *     opaque error, by which point every byte has already been uploaded.
 *     Checking first turns that into a useful answer.
 *
 * All pure: sizes in, decisions out. The bytes are somebody else's problem.
 */
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path';

/** Above this, Graph requires an upload session rather than inline content. */
export const SIMPLE_ATTACH_LIMIT = 3 * 1024 * 1024;

/** Upload session chunks must be a multiple of 320 KiB. */
export const UPLOAD_CHUNK_SIZE = 5 * 320 * 1024;

/** What Exchange will carry on one message, once encoding is counted. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Refuse to hold anything absurd in memory in one piece. */
export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export type AttachmentKind = 'file' | 'item' | 'reference';

const ODATA_KINDS: Readonly<Record<string, AttachmentKind>> = {
  '#microsoft.graph.fileattachment': 'file',
  '#microsoft.graph.itemattachment': 'item',
  '#microsoft.graph.referenceattachment': 'reference',
};

/** Classifies an attachment from its Graph `@odata.type`. */
export function classifyAttachment(odataType: string | undefined): AttachmentKind {
  return ODATA_KINDS[String(odataType ?? '').toLowerCase()] ?? 'file';
}

export const KIND_LABELS: Readonly<Record<AttachmentKind, string>> = {
  file: 'file',
  item: 'embedded message',
  reference: 'link',
};

/** Human-readable byte count. */
export function formatSize(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** True when this size must go through an upload session. */
export const needsUploadSession = (size: number): boolean => size > SIMPLE_ATTACH_LIMIT;

/** Byte ranges for an upload session, in order. */
export function chunkRanges(total: number, chunkSize = UPLOAD_CHUNK_SIZE): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < total; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize, total) });
  }
  return ranges;
}

export interface SizedFile {
  readonly name: string;
  readonly size: number;
}

/**
 * Checks a set of attachments against the message ceiling.
 *
 * @param alreadyAttached bytes already on the message
 * @returns a refusal message, or undefined when it fits
 */
export function checkTotalSize(
  files: readonly SizedFile[],
  alreadyAttached = 0,
): string | undefined {
  const incoming = files.reduce((sum, file) => sum + file.size, 0);
  const total = incoming + alreadyAttached;
  if (total <= MAX_TOTAL_ATTACHMENT_BYTES) return undefined;

  const context = alreadyAttached
    ? ` (${formatSize(alreadyAttached)} already attached, ${formatSize(incoming)} being added)`
    : '';

  return (
    `Attachments total ${formatSize(total)}${context}, over the ` +
    `${formatSize(MAX_TOTAL_ATTACHMENT_BYTES)} a message can carry. Send fewer files, or ` +
    `share a link instead.`
  );
}

/** Rejects a download that would not fit in memory. */
export function checkDownloadSize(name: string, size: number | undefined): string | undefined {
  if (size === undefined || size <= MAX_DOWNLOAD_BYTES) return undefined;
  return (
    `"${name}" is ${formatSize(size)}, over the ${formatSize(MAX_DOWNLOAD_BYTES)} this tool ` +
    `will hold in memory at once.`
  );
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.eml': 'message/rfc822',
};

/** Best-effort content type from a filename. */
export const contentTypeFor = (filePath: string): string =>
  EXTENSION_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';

/** True when a content type names an image, so it can be returned as one. */
export const isImageType = (contentType: string | undefined): boolean =>
  String(contentType ?? '').toLowerCase().startsWith('image/');

/**
 * Chooses where a download lands.
 *
 * A destination naming an existing directory takes the attachment's own
 * filename; anything else is treated as the full path. The filesystem question
 * is passed in so this stays pure.
 */
export function chooseTargetPath(
  destination: string,
  attachmentName: string,
  destinationIsExistingDirectory: boolean,
): { readonly path: string; readonly parent: string } {
  const looksLikeDirectory = /[\\/]$/.test(destination) || destinationIsExistingDirectory;
  const target = resolvePath(
    looksLikeDirectory ? join(destination, sanitiseFilename(attachmentName)) : destination,
  );
  return { path: target, parent: dirname(target) };
}

/**
 * Strips path separators from a sender-supplied filename.
 *
 * An attachment name arrives from whoever sent the message. Joining it to a
 * directory unexamined lets `../../` walk out of the destination.
 */
export function sanitiseFilename(name: string): string {
  const flattened = basename(name.replace(/\\/g, '/'));
  const cleaned = flattened.replace(/[<>:"|?*]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'attachment' : cleaned;
}
