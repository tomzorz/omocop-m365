import { describe, expect, test } from 'vitest';
import {
  invalidScopeMessage,
  isRecurring,
  normaliseScope,
  resolveScope,
  scopeNote,
  type EventFacts,
} from '../../src/domain/recurrence.js';

const occurrence: EventFacts = {
  id: 'occ1',
  subject: 'Weekly standup',
  type: 'occurrence',
  seriesMasterId: 'master1',
  start: { dateTime: '2026-08-05T09:00:00.0000000' },
};

const master: EventFacts = {
  id: 'master1',
  subject: 'Weekly standup',
  type: 'seriesMaster',
  start: { dateTime: '2026-07-01T09:00:00.0000000' },
};

const single: EventFacts = { id: 'evt1', subject: 'Lunch', type: 'singleInstance' };

describe('normaliseScope', () => {
  test.each(['this', 'occurrence', 'instance', 'just this', 'JUST_THIS', 'only-this'])(
    '%s means this occurrence',
    (raw) => expect(normaliseScope(raw)).toBe('this'),
  );

  test.each(['series', 'all', 'whole series', 'entire-series', 'EVERY'])(
    '%s means the series',
    (raw) => expect(normaliseScope(raw)).toBe('series'),
  );

  test('unset is undefined', () => {
    expect(normaliseScope(undefined)).toBeUndefined();
    expect(normaliseScope(null)).toBeUndefined();
    expect(normaliseScope('')).toBeUndefined();
  });

  test('unrecognised is null, which is distinct from unset', () => {
    expect(normaliseScope('maybe')).toBeNull();
    expect(normaliseScope('both')).toBeNull();
  });

  test('the invalid message names both valid values', () => {
    expect(invalidScopeMessage('probably')).toContain('"probably"');
    expect(invalidScopeMessage('x')).toContain('scope:"this"');
    expect(invalidScopeMessage('x')).toContain('scope:"series"');
  });
});

describe('isRecurring', () => {
  test.each([
    ['singleInstance', false],
    [undefined, false],
    ['occurrence', true],
    ['exception', true],
    ['seriesMaster', true],
  ])('type %s -> %s', (type, expected) => {
    expect(isRecurring({ id: 'x', type: type as string | undefined })).toBe(expected);
  });
});

describe('one-off events', () => {
  test('need no scope and target themselves', () => {
    expect(resolveScope(single, undefined, 'delete')).toEqual({ kind: 'single', targetId: 'evt1' });
  });

  test('ignore a scope that was supplied anyway', () => {
    expect(resolveScope(single, 'series', 'update')).toEqual({ kind: 'single', targetId: 'evt1' });
  });
});

describe('recurring events without a scope', () => {
  test('are refused, naming the event and the occurrence date', () => {
    const result = resolveScope(occurrence, undefined, 'delete');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('Weekly standup');
    expect(result.message).toContain('2026-08-05 09:00');
    expect(result.message).toContain('Do not guess');
  });

  test.each([
    ['update', 'update', 'changes only that single occurrence'],
    ['delete', 'deletion', 'deletes only that single occurrence'],
    ['cancel', 'cancellation', 'cancels only that single occurrence'],
  ] as const)('describe the real consequence for %s', (action, noun, effect) => {
    const result = resolveScope(occurrence, undefined, action);
    if (result.kind !== 'refused') throw new Error('expected refusal');
    expect(result.message).toContain(`this ${noun} needs an explicit scope`);
    expect(result.message).toContain(effect);
  });

  test('a master with no scope is refused too', () => {
    const result = resolveScope(master, undefined, 'cancel');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('the master of a recurring series');
  });
});

describe('recurring events with a scope', () => {
  test('this targets the occurrence', () => {
    expect(resolveScope(occurrence, 'this', 'update'))
      .toEqual({ kind: 'resolved', targetId: 'occ1', scope: 'this' });
  });

  test('series targets the master', () => {
    expect(resolveScope(occurrence, 'series', 'update'))
      .toEqual({ kind: 'resolved', targetId: 'master1', scope: 'series' });
  });

  test('series on a master targets the master itself', () => {
    expect(resolveScope(master, 'series', 'delete'))
      .toEqual({ kind: 'resolved', targetId: 'master1', scope: 'series' });
  });

  /** A master id names the series, not any one date, so "this" has no referent. */
  test('this on a master is refused with an explanation', () => {
    const result = resolveScope(master, 'this', 'delete');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('does not identify a single occurrence');
    expect(result.message).toContain('deletes every occurrence');
  });

  test('an exception behaves like an occurrence', () => {
    const exception: EventFacts = { ...occurrence, type: 'exception' };
    expect(resolveScope(exception, 'series', 'update'))
      .toEqual({ kind: 'resolved', targetId: 'master1', scope: 'series' });
  });

  /**
   * An occurrence id names one date. Without the master's id there is nothing
   * that names the series, so acting anyway would delete one occurrence while
   * reporting the whole series gone.
   */
  test('series on an occurrence with no master id is refused, not narrowed', () => {
    const orphan: EventFacts = { id: 'occ9', subject: 'Weekly standup', type: 'occurrence' };
    const result = resolveScope(orphan, 'series', 'delete');
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('seriesMasterId');
    expect(result.message).toContain('deletes every occurrence');
    expect(result.message).toContain('scope:"this"');
  });

  test('an exception with no master id is refused the same way', () => {
    const orphan: EventFacts = { id: 'exc1', type: 'exception' };
    expect(resolveScope(orphan, 'series', 'update').kind).toBe('refused');
  });
});

describe('scopeNote', () => {
  test('describes what was covered', () => {
    expect(scopeNote(resolveScope(occurrence, 'series', 'update')))
      .toBe(' (every occurrence in the series)');
    expect(scopeNote(resolveScope(occurrence, 'this', 'update')))
      .toBe(' (this occurrence only)');
  });

  test('is empty for a one-off or a refusal', () => {
    expect(scopeNote(resolveScope(single, undefined, 'update'))).toBe('');
    expect(scopeNote(resolveScope(occurrence, undefined, 'update'))).toBe('');
  });
});
