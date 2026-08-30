import { describe, expect, test } from 'vitest';
import {
  addDays,
  allDayBoundaries,
  allDaySpanOf,
  isDateOnly,
  resolveAllDaySpan,
  resolveTimedBoundary,
  rezoneBoundaries,
} from '../../src/domain/event-schedule.js';

const ZONE = 'W. Europe Standard Time';

describe('isDateOnly', () => {
  test.each([
    ['2026-08-15', true],
    [' 2026-08-15 ', true],
    ['2026-08-15T14:00:00', false],
    ['2026-08-15T00:00:00Z', false],
    ['2026-8-15', false],
    ['tomorrow', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(isDateOnly(text)).toBe(expected);
  });
});

describe('addDays', () => {
  test.each([
    ['2026-08-15', 1, '2026-08-16'],
    ['2026-08-31', 1, '2026-09-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2024-03-01', -1, '2024-02-29'],
    ['2026-08-15', 0, '2026-08-15'],
  ])('%s %+d days → %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('resolveAllDaySpan', () => {
  test('a single date names a one-day span', () => {
    expect(resolveAllDaySpan('2026-08-15', undefined)).toEqual({
      ok: true,
      value: { startDate: '2026-08-15', endDate: '2026-08-15' },
    });
  });

  test('start and end are both inclusive', () => {
    expect(resolveAllDaySpan('2026-08-15', '2026-08-16')).toEqual({
      ok: true,
      value: { startDate: '2026-08-15', endDate: '2026-08-16' },
    });
  });

  test('an end equal to the start is one day, not an error', () => {
    const result = resolveAllDaySpan('2026-08-15', '2026-08-15');
    expect(result.ok).toBe(true);
  });

  test.each([
    [undefined, undefined, 'date-only start'],
    ['', undefined, 'date-only start'],
    ['2026-08-15T14:00:00', undefined, 'date-only'],
    ['2026-08-15', '2026-08-16T00:00:00', 'date-only'],
    ['2026-02-30', undefined, 'not a real calendar date'],
    ['2026-08-15', '2026-02-30', 'not a real calendar date'],
    ['2026-08-16', '2026-08-15', 'before the start'],
  ])('refuses start=%s end=%s', (start, end, fragment) => {
    const result = resolveAllDaySpan(start, end);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(fragment);
  });

  test('the date-only refusal says how to make a timed event instead', () => {
    const result = resolveAllDaySpan('2026-08-15T14:00:00', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('drop allDay');
  });
});

describe('allDayBoundaries', () => {
  test('converts the inclusive span into exclusive-end midnights', () => {
    expect(allDayBoundaries({ startDate: '2026-08-15', endDate: '2026-08-16' }, ZONE)).toEqual({
      isAllDay: true,
      start: { dateTime: '2026-08-15T00:00:00', timeZone: ZONE },
      end: { dateTime: '2026-08-17T00:00:00', timeZone: ZONE },
    });
  });

  test('a one-day span ends at the next midnight', () => {
    const bounds = allDayBoundaries({ startDate: '2026-08-15', endDate: '2026-08-15' }, ZONE);
    expect(bounds.end.dateTime).toBe('2026-08-16T00:00:00');
  });
});

describe('allDaySpanOf', () => {
  test('recovers the inclusive span from Graph boundaries', () => {
    expect(
      allDaySpanOf(
        { dateTime: '2026-08-15T00:00:00.0000000' },
        { dateTime: '2026-08-17T00:00:00.0000000' },
      ),
    ).toEqual({ startDate: '2026-08-15', endDate: '2026-08-16' });
  });

  test('a one-day event round-trips to its single date', () => {
    expect(
      allDaySpanOf({ dateTime: '2026-08-15T00:00:00' }, { dateTime: '2026-08-16T00:00:00' }),
    ).toEqual({ startDate: '2026-08-15', endDate: '2026-08-15' });
  });

  test('a missing or degenerate end falls back to the start date', () => {
    expect(allDaySpanOf({ dateTime: '2026-08-15T00:00:00' }, undefined)).toEqual({
      startDate: '2026-08-15',
      endDate: '2026-08-15',
    });
    // end === start midnight (zero-length): the inclusive end may not precede the start
    expect(
      allDaySpanOf({ dateTime: '2026-08-15T00:00:00' }, { dateTime: '2026-08-15T00:00:00' }),
    ).toEqual({ startDate: '2026-08-15', endDate: '2026-08-15' });
  });
});

describe('resolveTimedBoundary', () => {
  test('a naive time lands in the given zone, beating the configured one', () => {
    const result = resolveTimedBoundary('2026-08-15T14:00:00', 'Tokyo Standard Time', ZONE, 'start time');
    expect(result).toEqual({
      ok: true,
      value: { dateTime: '2026-08-15T14:00:00', timeZone: 'Tokyo Standard Time' },
    });
  });

  test('without a given zone the configured one applies', () => {
    const result = resolveTimedBoundary('2026-08-15T14:00:00', undefined, ZONE, 'start time');
    expect(result.ok && result.value.timeZone).toBe(ZONE);
  });

  test('an offset timestamp with no given zone stays the exact instant', () => {
    const result = resolveTimedBoundary('2026-08-15T14:00:00Z', undefined, ZONE, 'start time');
    expect(result.ok && result.value.timeZone).toBe('UTC');
  });

  test('an offset timestamp combined with a zone is refused, not guessed', () => {
    const result = resolveTimedBoundary('2026-08-15T14:00:00Z', 'Tokyo Standard Time', ZONE, 'start time');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('already fixes the exact instant');
      expect(result.message).toContain('Tokyo Standard Time');
    }
  });

  test('a plain +02:00 offset also conflicts with a zone', () => {
    const result = resolveTimedBoundary('2026-08-15T14:00:00+02:00', 'UTC', ZONE, 'end time');
    expect(result.ok).toBe(false);
  });

  test('garbage is still refused with the usual message', () => {
    const result = resolveTimedBoundary('next tuesday', 'UTC', ZONE, 'start time');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('not a valid start time');
  });
});

describe('rezoneBoundaries', () => {
  test('keeps the wall-clock digits and swaps only the zone', () => {
    expect(rezoneBoundaries('2026-08-15T14:00:00', '2026-08-15T15:00:00', 'Tokyo Standard Time')).toEqual({
      start: { dateTime: '2026-08-15T14:00:00', timeZone: 'Tokyo Standard Time' },
      end: { dateTime: '2026-08-15T15:00:00', timeZone: 'Tokyo Standard Time' },
    });
  });
});
