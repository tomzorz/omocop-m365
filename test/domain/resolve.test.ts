import { describe, expect, test } from 'vitest';
import { resolveByName } from '../../src/domain/resolve.js';

interface Cal {
  id: string;
  name: string;
}

const calendars: Cal[] = [
  { id: 'id-personal', name: 'Personal' },
  { id: 'id-managed', name: 'Work Managed' },
  { id: 'id-default', name: 'Calendar' },
];

const options = {
  id: (c: Cal) => c.id,
  name: (c: Cal) => c.name,
  label: 'calendar',
};

const matched = (ref: string) => {
  const result = resolveByName(calendars, ref, options);
  if (result.kind !== 'matched') throw new Error(`expected a match for "${ref}"`);
  return result.item;
};

describe('precedence', () => {
  test('an exact id wins outright', () => {
    expect(matched('id-managed').name).toBe('Work Managed');
  });

  test('an exact name matches case-insensitively', () => {
    expect(matched('personal').id).toBe('id-personal');
    expect(matched('WORK MANAGED').id).toBe('id-managed');
  });

  test('an unambiguous partial name matches', () => {
    expect(matched('managed').id).toBe('id-managed');
    expect(matched('  Person  ').id).toBe('id-personal');
  });

  /**
   * "Calendar" is an exact name and also a substring of nothing else here, but
   * an exact match must not be beaten by a partial one elsewhere.
   */
  test('an exact name beats a partial match on another item', () => {
    const items = [
      { id: 'a', name: 'Team' },
      { id: 'b', name: 'Team Offsite' },
    ];
    const result = resolveByName(items, 'Team', options as never);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.item.id).toBe('a');
  });
});

describe('refusing rather than guessing', () => {
  test('several partial matches are ambiguous, and the message lists them', () => {
    const items = [
      { id: 'a', name: 'Reports 2025' },
      { id: 'b', name: 'Reports 2026' },
    ];
    const result = resolveByName(items, 'reports', options as never);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.matches).toHaveLength(2);
    expect(result.message).toContain('"Reports 2025"');
    expect(result.message).toContain('"Reports 2026"');
  });

  test('duplicate exact names fall back to ids when nothing else tells them apart', () => {
    const items = [
      { id: 'first', name: 'Archive' },
      { id: 'second', name: 'Archive' },
    ];
    const result = resolveByName(items, 'Archive', options as never);

    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;
    expect(result.message).toContain('cannot be told apart by name');
    expect(result.message).toContain('first');
    expect(result.message).toContain('second');
  });

  test('duplicate exact names prefer a description that does tell them apart', () => {
    const items = [
      { id: 'a', name: 'Receipts', path: 'Inbox/Receipts' },
      { id: 'b', name: 'Receipts', path: 'Archive/Receipts' },
    ];
    const result = resolveByName(items, 'Receipts', {
      id: (i) => i.id,
      name: (i) => i.name,
      label: 'folder',
      describe: (i) => `"${i.path}"`,
    });

    if (result.kind !== 'ambiguous') throw new Error('expected ambiguity');
    expect(result.message).toContain('"Inbox/Receipts"');
    expect(result.message).toContain('"Archive/Receipts"');
    expect(result.message).not.toContain('cannot be told apart');
  });

  test('no match reports what is available', () => {
    const result = resolveByName(calendars, 'Nonexistent', options);
    expect(result.kind).toBe('none');
    if (result.kind !== 'none') return;
    expect(result.message).toContain('"Personal"');
    expect(result.message).toContain('"Work Managed"');
  });

  test('an empty list says so rather than reporting no match', () => {
    const result = resolveByName([], 'anything', options);
    expect(result.kind).toBe('none');
    if (result.kind === 'none') expect(result.message).toContain('no calendars');
  });

  test('a blank reference is refused', () => {
    expect(resolveByName(calendars, '   ', options).kind).toBe('none');
  });
});

describe('customisation', () => {
  test('the label appears in messages', () => {
    const result = resolveByName([{ id: 'x', name: 'y' }], 'zzz', {
      id: (i: { id: string }) => i.id,
      name: (i: { name: string }) => i.name,
      label: 'folder',
    });
    if (result.kind !== 'none') throw new Error('expected none');
    expect(result.message).toContain('No folder matching');
  });

  test('describe overrides how matches are listed', () => {
    const items = [
      { id: 'a', name: 'Receipts', path: 'Inbox/Receipts' },
      { id: 'b', name: 'Receipts old', path: 'Archive/Receipts old' },
    ];
    // "receipt" is a partial match for both; "receipts" would match the first
    // exactly and resolve rather than being ambiguous.
    const result = resolveByName(items, 'receipt', {
      id: (i) => i.id,
      name: (i) => i.name,
      label: 'folder',
      describe: (i) => `"${i.path}"`,
    });

    if (result.kind !== 'ambiguous') throw new Error('expected ambiguity');
    expect(result.message).toContain('"Inbox/Receipts"');
    expect(result.message).toContain('"Archive/Receipts old"');
  });
});
