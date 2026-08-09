import { describe, expect, test } from 'vitest';
import { datePart, describeDateTime, toGraphDateTime } from '../../src/domain/datetime.js';

const ZONE = 'W. Europe Standard Time';

const value = (input: Parameters<typeof toGraphDateTime>[0]) => {
  const result = toGraphDateTime(input, ZONE);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

describe('naive timestamps', () => {
  test('are stamped with the configured zone', () => {
    expect(value('2026-08-15T14:00:00')).toEqual({
      dateTime: '2026-08-15T14:00:00',
      timeZone: ZONE,
    });
  });

  test('accept an explicit zone on the object form', () => {
    expect(value({ dateTime: '2026-08-15T14:00:00', timeZone: 'Pacific Standard Time' }))
      .toEqual({ dateTime: '2026-08-15T14:00:00', timeZone: 'Pacific Standard Time' });
  });

  test('accept seconds-less and space-separated forms', () => {
    expect(value('2026-08-15T14:00').dateTime).toBe('2026-08-15T14:00');
    expect(value('2026-08-15 14:00:00').dateTime).toBe('2026-08-15 14:00:00');
  });
});

describe('offset-bearing timestamps', () => {
  /**
   * The silent failure this exists to prevent: paired with a named zone, Graph
   * ignores the offset, so 14:00Z becomes 14:00 local — hours out, no error.
   */
  test('a Z timestamp becomes UTC, not the local zone', () => {
    expect(value('2026-08-15T14:00:00Z')).toEqual({
      dateTime: '2026-08-15T14:00:00',
      timeZone: 'UTC',
    });
  });

  test('an offset is converted to the instant it names', () => {
    expect(value('2026-08-15T16:00:00+02:00').dateTime).toBe('2026-08-15T14:00:00');
    expect(value('2026-08-15T09:00:00-05:00').dateTime).toBe('2026-08-15T14:00:00');
    expect(value('2026-08-15T16:00:00+0200').dateTime).toBe('2026-08-15T14:00:00');
  });

  /**
   * ISO allows an hour-only offset. Missing it would send the value out as
   * naive-with-embedded-offset plus a named zone — the exact contradictory
   * pairing this module exists to prevent.
   */
  test('an hour-only offset is recognised as an offset', () => {
    expect(value('2026-08-15T16:00:00+02'))
      .toEqual({ dateTime: '2026-08-15T14:00:00', timeZone: 'UTC' });
    expect(value('2026-08-15T09:00-05').dateTime).toBe('2026-08-15T14:00:00');
  });

  test('an offset wins over a contradicting named zone', () => {
    expect(value({ dateTime: '2026-08-15T14:00:00Z', timeZone: 'Pacific Standard Time' }))
      .toEqual({ dateTime: '2026-08-15T14:00:00', timeZone: 'UTC' });
  });

  test('milliseconds are dropped, since Graph does not want them', () => {
    expect(value('2026-08-15T14:00:00.123Z').dateTime).toBe('2026-08-15T14:00:00');
  });
});

describe('rejections', () => {
  test.each(['next tuesday', '2026-08-15', 'tomorrow at 2', ''])('%s is refused', (input) => {
    expect(toGraphDateTime(input, ZONE, 'start time').ok).toBe(false);
  });

  test('the message names the argument and shows the expected form', () => {
    const result = toGraphDateTime('next tuesday', ZONE, 'start time');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toContain('start time');
    expect(result.message).toContain('2026-08-15T14:00:00');
  });

  test('an unparseable offset timestamp is refused', () => {
    expect(toGraphDateTime('2026-13-45T99:00:00Z', ZONE).ok).toBe(false);
  });

  /**
   * The shape check is anchored: a value with trailing text would otherwise go
   * to Graph as a literal dateTime and come back as an opaque 400.
   */
  test('trailing text after a valid timestamp is refused here, not sent on', () => {
    const result = toGraphDateTime('2026-08-15T14:00 lunch with Bob', ZONE, 'start time');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('start time');
  });

  test('a naive timestamp with impossible components is refused', () => {
    expect(toGraphDateTime('2026-13-45T99:00', ZONE).ok).toBe(false);
    expect(toGraphDateTime('2026-02-30T10:00:00', ZONE).ok).toBe(false);
  });

  test('undefined is refused with a required message', () => {
    const result = toGraphDateTime(undefined, ZONE, 'end time');
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toBe('An end time is required.');
  });
});

describe('helpers', () => {
  test('describeDateTime keeps the zone visible', () => {
    expect(describeDateTime({ dateTime: '2026-08-15T14:00:00.0000000', timeZone: 'UTC' }))
      .toBe('2026-08-15 14:00 (UTC)');
    expect(describeDateTime(undefined)).toBe('unknown');
  });

  test('datePart takes the date', () => {
    expect(datePart('2026-08-15T14:00:00.0000000')).toBe('2026-08-15');
  });
});
