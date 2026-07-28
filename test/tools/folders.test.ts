import { describe, expect, test } from 'vitest';
import { folderTools } from '../../src/tools/folders.js';
import { runTool } from '../../src/server/tool.js';
import type { AnyToolDefinition } from '../../src/server/registry.js';
import { ALL_SCOPES, fakeGraph, on, testContext, textOf } from '../support/fake-graph.js';

const tool = (name: string): AnyToolDefinition => {
  const found = folderTools.find((t) => t.name === name);
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

const ROOT = {
  items: [
    { id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1 },
    { id: 'projects-id', displayName: 'Projects', childFolderCount: 0 },
  ],
  truncated: false,
};

const INBOX_CHILDREN = {
  items: [{ id: 'receipts-id', displayName: 'Receipts', childFolderCount: 0 }],
  truncated: false,
};

const tree = [
  (c: { method: string; path: string }) =>
    c.method === 'COLLECT' && c.path === 'me/mailFolders' ? ROOT : undefined,
  (c: { method: string; path: string }) =>
    c.method === 'COLLECT' && c.path === 'me/mailFolders/inbox-id/childFolders'
      ? INBOX_CHILDREN
      : undefined,
];

describe('list-folders', () => {
  test('lists nested folders with their full paths', async () => {
    const { text, result } = await call('list-folders', {}, ...tree);

    expect(text).toContain('(Inbox/Receipts)');
    expect(text).toContain('(Projects)');
    expect((result.structuredContent as { folders: unknown[] }).folders).toHaveLength(3);
  });

  test('indents by depth', async () => {
    const { text } = await call('list-folders', {}, ...tree);
    expect(text).toMatch(/^ {2}- Receipts/m);
    expect(text).toMatch(/^- Inbox/m);
  });

  test('says so when there are none', async () => {
    const { text } = await call(
      'list-folders',
      {},
      (c) => (c.method === 'COLLECT' ? { items: [], truncated: false } : undefined),
    );
    expect(text).toBe('No mail folders found.');
  });
});

describe('create-folder', () => {
  test('creates at the top level', async () => {
    const { of, text } = await call(
      'create-folder',
      { name: 'Invoices' },
      on('POST', 'me/mailFolders', { id: 'new-id', displayName: 'Invoices' }),
    );
    expect(of('POST')[0]?.path).toBe('me/mailFolders');
    expect(of('POST')[0]?.body).toEqual({ displayName: 'Invoices' });
    expect(text).toContain('at the top level');
  });

  test('creates inside a resolved parent', async () => {
    const { of, text } = await call(
      'create-folder',
      { name: '2026', parentFolder: 'Inbox/Receipts' },
      ...tree,
      on('POST', 'childFolders', { id: 'new-id', displayName: '2026' }),
    );
    expect(of('POST')[0]?.path).toBe('me/mailFolders/receipts-id/childFolders');
    expect(text).toContain('inside Inbox/Receipts');
  });

  test('refuses an unknown parent without creating anything', async () => {
    const { of, text } = await call(
      'create-folder',
      { name: 'x', parentFolder: 'Nonexistent' },
      ...tree,
    );
    expect(text).toContain('No folder matching');
    expect(of('POST')).toHaveLength(0);
  });
});

describe('move-emails', () => {
  test('moves messages to a resolved folder', async () => {
    const { of, text } = await call(
      'move-emails',
      { messageIds: ['m1', 'm2'], destinationFolder: 'Projects' },
      ...tree,
      on('POST', '/move', { id: 'new-id' }),
    );

    expect(of('POST')).toHaveLength(2);
    expect(of('POST')[0]?.body).toEqual({ destinationId: 'projects-id' });
    expect(text).toContain('Moved 2 message(s) to Projects');
  });

  test('uses a well-known destination without walking the tree', async () => {
    const { of } = await call(
      'move-emails',
      { messageIds: ['m1'], destinationFolder: 'archive' },
      on('POST', '/move', { id: 'x' }),
    );
    expect(of('POST')[0]?.body).toEqual({ destinationId: 'archive' });
    expect(of('COLLECT')).toHaveLength(0);
  });

  test('resolves a nested destination by path', async () => {
    const { of } = await call(
      'move-emails',
      { messageIds: ['m1'], destinationFolder: 'Inbox/Receipts' },
      ...tree,
      on('POST', '/move', { id: 'x' }),
    );
    expect(of('POST')[0]?.body).toEqual({ destinationId: 'receipts-id' });
  });

  /** One bad id must not lose the rest of the batch. */
  test('reports individual failures without abandoning the others', async () => {
    let seen = 0;
    const { text, result } = await call(
      'move-emails',
      { messageIds: ['ok1', 'bad', 'ok2'], destinationFolder: 'Projects' },
      ...tree,
      (c) => {
        if (c.method !== 'POST' || !c.path.includes('/move')) return undefined;
        seen += 1;
        if (c.path.includes('bad')) throw new Error('Item not found');
        return { id: `moved-${seen}` };
      },
    );

    expect(text).toContain('Moved 2 message(s)');
    expect(text).toContain('1 could not be moved');
    expect(text).toContain('bad: Item not found');
    expect((result.structuredContent as { failed: unknown[] }).failed).toHaveLength(1);
  });

  test('warns that ids change on a move', async () => {
    const { text } = await call(
      'move-emails',
      { messageIds: ['m1'], destinationFolder: 'Projects' },
      ...tree,
      on('POST', '/move', { id: 'new-id' }),
    );
    expect(text).toContain('changes its id');
  });

  test('refuses an unknown destination without moving anything', async () => {
    const { of, text } = await call(
      'move-emails',
      { messageIds: ['m1'], destinationFolder: 'Nowhere' },
      ...tree,
    );
    expect(text).toContain('No folder matching');
    expect(of('POST')).toHaveLength(0);
  });
});
