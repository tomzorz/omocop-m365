import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { attachmentTools } from '../../src/tools/attachments.js';
import { runTool } from '../../src/server/tool.js';
import type { AnyToolDefinition } from '../../src/server/registry.js';
import { MAX_TOTAL_ATTACHMENT_BYTES } from '../../src/domain/attachments.js';
import { ALL_SCOPES, fakeGraph, on, testContext, textOf } from '../support/fake-graph.js';

const tool = (name: string): AnyToolDefinition => {
  const found = attachmentTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

async function call(
  name: string,
  args: Record<string, unknown>,
  ...responders: Parameters<typeof fakeGraph>
) {
  const fake = fakeGraph(...responders);
  const result = await runTool(tool(name), args as never, testContext(fake.graph), ALL_SCOPES);
  return { ...fake, result, text: textOf(result) };
}

const PDF = {
  id: 'att-pdf',
  name: 'invoice.pdf',
  contentType: 'application/pdf',
  size: 1024,
  isInline: false,
  '@odata.type': '#microsoft.graph.fileAttachment',
};

const LOGO = {
  id: 'att-logo',
  name: 'logo.png',
  contentType: 'image/png',
  size: 300,
  isInline: true,
  contentId: 'logo@contoso',
  '@odata.type': '#microsoft.graph.fileAttachment',
};

const LINK = {
  id: 'att-link',
  name: 'shared.docx',
  size: 0,
  '@odata.type': '#microsoft.graph.referenceAttachment',
};

const attachmentsOn = (messageId: string, list: unknown[]) =>
  on('COLLECT', `me/messages/${messageId}/attachments`, { items: list, truncated: false });

const draftOn = (id: string, over: Record<string, unknown> = {}) =>
  on('GET', `me/messages/${id}`, { id, subject: 'Draft subject', isDraft: true, ...over });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omocop-att-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('list-attachments', () => {
  test('lists names, sizes, kinds and ids, marking inline images', async () => {
    const { text, result } = await call(
      'list-attachments',
      { messageId: 'msg1' },
      attachmentsOn('msg1', [PDF, LOGO]),
    );

    expect(text).toContain('invoice.pdf');
    expect(text).toContain('1.0 KB');
    expect(text).toContain('ID: att-pdf');
    expect(text).toContain('inline');
    expect((result.structuredContent as { totalSize: number }).totalSize).toBe(1324);
  });

  test('exposes contentId so it can be matched to the body Markdown', async () => {
    const { result } = await call(
      'list-attachments',
      { messageId: 'msg1' },
      attachmentsOn('msg1', [LOGO]),
    );
    expect((result.structuredContent as { attachments: Array<{ contentId?: string }> })
      .attachments[0]?.contentId).toBe('logo@contoso');
  });

  test('says so when there are none', async () => {
    const { text } = await call('list-attachments', { messageId: 'msg1' }, attachmentsOn('msg1', []));
    expect(text).toBe('That message has no attachments.');
  });

  test('labels a reference attachment as a link', async () => {
    const { text } = await call(
      'list-attachments',
      { messageId: 'msg1' },
      attachmentsOn('msg1', [LINK]),
    );
    expect(text).toContain('link');
  });
});

describe('download-attachment', () => {
  const bytes = on('BYTES', '$value', Buffer.from('PDF-BYTES-HERE'));

  test('writes to an explicit file path', async () => {
    const target = join(dir, 'saved.pdf');
    const { text } = await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'invoice.pdf', destination: target },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );

    expect(await readFile(target, 'utf8')).toBe('PDF-BYTES-HERE');
    expect(text).toContain('Saved "invoice.pdf"');
  });

  test('uses the attachment name when given a directory', async () => {
    await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'invoice.pdf', destination: dir },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );
    expect(existsSync(join(dir, 'invoice.pdf'))).toBe(true);
  });

  test('creates missing parent directories', async () => {
    const target = join(dir, 'deep', 'nested', 'out.pdf');
    await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'invoice', destination: target },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );
    expect(existsSync(target)).toBe(true);
  });

  test('refuses to overwrite unless told to', async () => {
    const target = join(dir, 'saved.pdf');
    await writeFile(target, 'ORIGINAL');

    const refused = await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'invoice.pdf', destination: target },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );
    expect(refused.text).toContain('already exists');
    expect(await readFile(target, 'utf8')).toBe('ORIGINAL');

    const forced = await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'invoice.pdf', destination: target, overwrite: true },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );
    expect(forced.text).toContain('Saved');
    expect(await readFile(target, 'utf8')).toBe('PDF-BYTES-HERE');
  });

  test('downloads the only attachment without being told which', async () => {
    const { text } = await call(
      'download-attachment',
      { messageId: 'msg1', destination: dir },
      attachmentsOn('msg1', [PDF]),
      bytes,
    );
    expect(text).toContain('Saved "invoice.pdf"');
  });

  test('asks which one when there are several and none was named', async () => {
    const { text, of } = await call(
      'download-attachment',
      { messageId: 'msg1', destination: dir },
      attachmentsOn('msg1', [PDF, LOGO]),
      bytes,
    );
    expect(text).toContain('has 2 attachments');
    expect(of('BYTES')).toHaveLength(0);
  });

  test('reports an ambiguous partial name rather than guessing', async () => {
    const { text, of } = await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'report', destination: dir },
      attachmentsOn('msg1', [
        { ...PDF, id: 'a', name: 'report-jan.pdf' },
        { ...PDF, id: 'b', name: 'report-feb.pdf' },
      ]),
      bytes,
    );
    expect(text).toContain('ambiguous');
    expect(of('BYTES')).toHaveLength(0);
  });

  test('explains that a reference attachment has no bytes', async () => {
    const { text } = await call(
      'download-attachment',
      { messageId: 'msg1', attachment: 'shared.docx', destination: dir },
      attachmentsOn('msg1', [LINK]),
      bytes,
    );
    expect(text).toContain('link to a cloud file');
  });

  /** The attachment name is chosen by whoever sent the message. */
  test('a traversing attachment name cannot escape the destination', async () => {
    const { text } = await call(
      'download-attachment',
      { messageId: 'msg1', destination: dir },
      attachmentsOn('msg1', [{ ...PDF, name: '../../escaped.pdf' }]),
      bytes,
    );
    const { result } = await call(
      'download-attachment',
      { messageId: 'msg2', destination: dir, overwrite: true },
      attachmentsOn('msg2', [{ ...PDF, name: '../../escaped.pdf' }]),
      bytes,
    );

    // It landed inside the destination, not above it.
    expect(existsSync(join(dir, 'escaped.pdf'))).toBe(true);
    expect((result.structuredContent as { path: string }).path.startsWith(dir)).toBe(true);

    // And the change of filename is reported rather than being silent.
    expect(text).toContain('written as "escaped.pdf"');
  });
});

describe('add-attachment', () => {
  test('requires something to attach', async () => {
    const { text } = await call('add-attachment', { messageId: 'draft1' });
    expect(text).toContain('Nothing to attach');
  });

  test('requires fromAttachment alongside fromMessageId', async () => {
    const { text } = await call('add-attachment', { messageId: 'draft1', fromMessageId: 'msg1' });
    expect(text).toContain('`fromAttachment` is required');
  });

  test('attaches a local file as base64', async () => {
    const local = join(dir, 'notes.txt');
    await writeFile(local, 'hello world');

    const { of, text } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [local] },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
    );

    const post = of('POST').find((c) => c.path.endsWith('/attachments'));
    const body = post?.body as { name: string; contentType: string; contentBytes: string };
    expect(body.name).toBe('notes.txt');
    expect(body.contentType).toBe('text/plain');
    expect(Buffer.from(body.contentBytes, 'base64').toString()).toBe('hello world');
    expect(text).toContain('notes.txt');
  });

  test('reports a missing local file without uploading anything', async () => {
    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [join(dir, 'ghost.txt')] },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
    );
    expect(text).toContain('no such file');
    expect(of('POST')).toHaveLength(0);
  });

  test('refuses to attach to an already-sent message', async () => {
    const local = join(dir, 'a.txt');
    await writeFile(local, 'x');

    const { text, of } = await call(
      'add-attachment',
      { messageId: 'sent1', filePath: [local] },
      draftOn('sent1', { isDraft: false }),
    );
    expect(text).toContain('already been sent');
    expect(of('POST')).toHaveLength(0);
  });

  test('switches to an upload session above 3MB', async () => {
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(4 * 1024 * 1024, 1));

    const { of, text } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [big] },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      on('POST', 'createUploadSession', { uploadUrl: 'https://upload.test/session' }),
    );

    const session = of('POST').find((c) => c.path.includes('createUploadSession'));
    expect((session?.body as { AttachmentItem: { size: number } }).AttachmentItem.size)
      .toBe(4 * 1024 * 1024);
    expect(of('UPLOAD').length).toBeGreaterThan(0);
    expect(text).toContain('uploaded in chunks');

    // No single-shot POST for a file this size.
    expect(of('POST').some((c) => c.path.endsWith('draft1/attachments'))).toBe(false);
  });

  test('counts existing attachments towards the message ceiling', async () => {
    const half = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 2);
    const local = join(dir, 'half.bin');
    await writeFile(local, Buffer.alloc(half));

    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [local] },
      draftOn('draft1'),
      attachmentsOn('draft1', [{ ...PDF, size: half + 4096 }]),
    );

    expect(text).toContain('already attached');
    expect(of('POST')).toHaveLength(0);
  });

  test('copies an attachment from another message without touching disk', async () => {
    const { of, text } = await call(
      'add-attachment',
      { messageId: 'draft1', fromMessageId: 'msg1', fromAttachment: 'invoice.pdf' },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      attachmentsOn('msg1', [PDF]),
      on('BYTES', '$value', Buffer.from('COPIED')),
    );

    expect(of('BYTES')[0]?.path).toBe('me/messages/msg1/attachments/att-pdf/$value');
    const post = of('POST').find((c) => c.path.endsWith('/attachments'));
    expect((post?.body as { name: string }).name).toBe('invoice.pdf');
    expect(text).toContain('invoice.pdf');
  });

  /** "fails without leaving a half-filled draft behind" — the copy path too. */
  test('a bad copy reference fails before any local file is uploaded', async () => {
    const local = join(dir, 'notes.txt');
    await writeFile(local, 'hello');

    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [local], fromMessageId: 'msg1', fromAttachment: 'ghost.pdf' },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      attachmentsOn('msg1', [PDF]),
    );

    expect(text).toContain('No attachment matching "ghost.pdf"');
    expect(of('POST')).toHaveLength(0);
    expect(of('UPLOAD')).toHaveLength(0);
    expect(of('BYTES')).toHaveLength(0);
  });

  test('an oversized copy source is refused before anything is fetched or uploaded', async () => {
    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', fromMessageId: 'msg1', fromAttachment: 'huge.bin' },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      attachmentsOn('msg1', [
        { ...PDF, id: 'att-huge', name: 'huge.bin', size: MAX_TOTAL_ATTACHMENT_BYTES },
      ]),
      on('BYTES', '$value', Buffer.from('NEVER-FETCHED')),
    );

    expect(text).toContain('over the 25.0 MB');
    expect(of('BYTES')).toHaveLength(0);
    expect(of('POST')).toHaveLength(0);
  });

  test('a copied attachment counts against what the draft already holds', async () => {
    // 15 MB copied onto a draft holding 10 MB: each fits alone, together they
    // encode past the ceiling.
    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', fromMessageId: 'msg1', fromAttachment: 'big.pdf' },
      draftOn('draft1'),
      attachmentsOn('draft1', [{ ...PDF, size: 10 * 1024 * 1024 }]),
      attachmentsOn('msg1', [{ ...PDF, id: 'att-big', name: 'big.pdf', size: 15 * 1024 * 1024 }]),
      on('BYTES', '$value', Buffer.from('NEVER-FETCHED')),
    );

    expect(text).toContain('already attached');
    expect(of('BYTES')).toHaveLength(0);
    expect(of('POST')).toHaveLength(0);
  });

  test('the copy source counts alongside local files', async () => {
    // 10 MB local + 12 MB copy source: each fits alone, together they do not.
    const local = join(dir, 'ten.bin');
    await writeFile(local, Buffer.alloc(10 * 1024 * 1024));

    const { text, of } = await call(
      'add-attachment',
      { messageId: 'draft1', filePath: [local], fromMessageId: 'msg1', fromAttachment: 'big.pdf' },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      attachmentsOn('msg1', [{ ...PDF, id: 'att-big', name: 'big.pdf', size: 12 * 1024 * 1024 }]),
      on('BYTES', '$value', Buffer.from('NEVER-FETCHED')),
    );

    expect(text).toContain('over the 25.0 MB');
    expect(of('POST')).toHaveLength(0);
    expect(of('UPLOAD')).toHaveLength(0);
    expect(of('BYTES')).toHaveLength(0);
  });

  test('renames a copied attachment when asked', async () => {
    const { of } = await call(
      'add-attachment',
      {
        messageId: 'draft1',
        fromMessageId: 'msg1',
        fromAttachment: 'invoice.pdf',
        name: 'renamed.pdf',
      },
      draftOn('draft1'),
      attachmentsOn('draft1', []),
      attachmentsOn('msg1', [PDF]),
      on('BYTES', '$value', Buffer.from('COPIED')),
    );
    const post = of('POST').find((c) => c.path.endsWith('/attachments'));
    expect((post?.body as { name: string }).name).toBe('renamed.pdf');
  });
});
