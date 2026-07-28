import { describe, expect, test } from 'vitest';
import {
  flattenFolders,
  hasUnfetchedChildren,
  resolveFolder,
  wellKnownFolder,
  type FolderNode,
} from '../../src/domain/folders.js';

const tree: FolderNode[] = [
  {
    id: 'inbox-id',
    displayName: 'Inbox',
    childFolderCount: 2,
    childFolders: [
      { id: 'receipts-id', displayName: 'Receipts', childFolderCount: 1, childFolders: [
        { id: 'r2026-id', displayName: '2026' },
      ] },
      { id: 'newsletters-id', displayName: 'Newsletters' },
    ],
  },
  { id: 'archive-id', displayName: 'Archive', childFolderCount: 1, childFolders: [
    { id: 'arch-receipts-id', displayName: 'Receipts' },
  ] },
  { id: 'sent-id', displayName: 'Sent Items' },
];

const flat = flattenFolders(tree);

describe('wellKnownFolder', () => {
  test.each([
    ['inbox', 'inbox'],
    ['Sent', 'sentitems'],
    ['sent items', 'sentitems'],
    ['trash', 'deleteditems'],
    ['Bin', 'deleteditems'],
    ['spam', 'junkemail'],
    ['  Drafts  ', 'drafts'],
  ])('%s -> %s', (ref, expected) => {
    expect(wellKnownFolder(ref)).toBe(expected);
  });

  test('is undefined for a user folder', () => {
    expect(wellKnownFolder('Receipts')).toBeUndefined();
  });
});

describe('flattenFolders', () => {
  /** The whole point: a lookup that only sees the top level cannot find these. */
  test('includes folders at every depth', () => {
    expect(flat.map((f) => f.path).sort()).toEqual([
      'Archive',
      'Archive/Receipts',
      'Inbox',
      'Inbox/Newsletters',
      'Inbox/Receipts',
      'Inbox/Receipts/2026',
      'Sent Items',
    ]);
  });

  test('records depth', () => {
    expect(flat.find((f) => f.path === 'Inbox')?.depth).toBe(0);
    expect(flat.find((f) => f.path === 'Inbox/Receipts')?.depth).toBe(1);
    expect(flat.find((f) => f.path === 'Inbox/Receipts/2026')?.depth).toBe(2);
  });

  test('preserves ids', () => {
    expect(flat.find((f) => f.path === 'Inbox/Receipts/2026')?.id).toBe('r2026-id');
  });

  test('an empty tree flattens to nothing', () => {
    expect(flattenFolders([])).toEqual([]);
  });

  test('a node with a count but no fetched children is still listed', () => {
    const partial = flattenFolders([{ id: 'a', displayName: 'A', childFolderCount: 3 }]);
    expect(partial).toHaveLength(1);
    expect(partial[0]?.path).toBe('A');
  });
});

describe('hasUnfetchedChildren', () => {
  test('true when a count is reported but no children were fetched', () => {
    expect(hasUnfetchedChildren({ id: 'a', displayName: 'A', childFolderCount: 2 })).toBe(true);
  });

  test('false once children are present, or when there are none', () => {
    expect(hasUnfetchedChildren({
      id: 'a', displayName: 'A', childFolderCount: 1, childFolders: [{ id: 'b', displayName: 'B' }],
    })).toBe(false);
    expect(hasUnfetchedChildren({ id: 'a', displayName: 'A', childFolderCount: 0 })).toBe(false);
    expect(hasUnfetchedChildren({ id: 'a', displayName: 'A' })).toBe(false);
  });
});

describe('resolveFolder', () => {
  const matched = (ref: string) => {
    const result = resolveFolder(flat, ref);
    if (result.kind !== 'matched') throw new Error(`expected a match for "${ref}"`);
    return result.item;
  };

  test('finds a nested folder by plain name when unambiguous', () => {
    expect(matched('Newsletters').id).toBe('newsletters-id');
    expect(matched('2026').id).toBe('r2026-id');
  });

  test('finds a folder by id', () => {
    expect(matched('arch-receipts-id').path).toBe('Archive/Receipts');
  });

  /** Two folders named Receipts is exactly why paths are supported. */
  test('a duplicated name is ambiguous, and the message shows the paths', () => {
    const result = resolveFolder(flat, 'Receipts');
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.message).toContain('"Inbox/Receipts"');
    expect(result.message).toContain('"Archive/Receipts"');
  });

  test('a path disambiguates it', () => {
    expect(matched('Inbox/Receipts').id).toBe('receipts-id');
    expect(matched('Archive/Receipts').id).toBe('arch-receipts-id');
  });

  test('paths are case-insensitive and tolerate separators and slashes', () => {
    expect(matched('inbox/receipts').id).toBe('receipts-id');
    expect(matched('/Inbox/Receipts/').id).toBe('receipts-id');
    expect(matched('Inbox\\Receipts').id).toBe('receipts-id');
  });

  test('a deep path resolves', () => {
    expect(matched('Inbox/Receipts/2026').id).toBe('r2026-id');
  });

  test('an unknown path reports the paths that exist', () => {
    const result = resolveFolder(flat, 'Inbox/Nope');
    expect(result.kind).toBe('none');
    if (result.kind !== 'none') return;
    expect(result.message).toContain('No folder at path "Inbox/Nope"');
    expect(result.message).toContain('"Inbox/Receipts"');
  });

  test('an unknown name reports what is available', () => {
    const result = resolveFolder(flat, 'Nonexistent');
    expect(result.kind).toBe('none');
    if (result.kind === 'none') expect(result.message).toContain('No folder matching');
  });

  test('a partial name matches when only one folder contains it', () => {
    expect(matched('newslet').id).toBe('newsletters-id');
  });
});
