/**
 * The schedule block of an event write: start, end, timezone, all-day.
 *
 * Two conventions meet here and both are traps. Graph's all-day events want
 * midnight-to-midnight boundaries where the end is *exclusive* — a one-day
 * event ends at the next day's midnight — while humans state date ranges
 * inclusively ("the 15th to the 16th" means both days). And a per-event
 * timezone only makes sense for a naive timestamp; an offset-bearing one
 * already names its exact instant. The conversions and refusals live here,
 * pure and table-testable; the handlers just act on the answers.
 */
import {
  hasExplicitOffset,
  toGraphDateTime,
  datePart,
  type DateTimeResult,
  type GraphDateTime,
} from './datetime.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a bare `YYYY-MM-DD` with no time attached. */
export const isDateOnly = (text: string): boolean => DATE_ONLY.test(text.trim());

/** True when the digits name a real calendar date (Feb 30 fits the shape but rolls over). */
const isRealDate = (date: string): boolean => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
};

/** Date arithmetic on `YYYY-MM-DD` strings, in the date's own frame — no clock involved. */
export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** An all-day span in human terms: both dates inclusive. */
export interface AllDaySpan {
  readonly startDate: string;
  readonly endDate: string;
}

export type AllDayResult =
  | { readonly ok: true; readonly value: AllDaySpan }
  | { readonly ok: false; readonly message: string };

/**
 * Validates the dates of an all-day event. The end is inclusive and defaults
 * to the start, so "one day" needs only one date.
 */
export function resolveAllDaySpan(
  start: string | undefined,
  end: string | undefined,
): AllDayResult {
  const startText = (start ?? '').trim();
  if (!startText) {
    return { ok: false, message: 'An all-day event needs a date-only start (YYYY-MM-DD).' };
  }

  for (const [text, label] of [
    [startText, 'start'],
    [(end ?? '').trim(), 'end'],
  ] as const) {
    if (!text) continue;
    if (!isDateOnly(text)) {
      return {
        ok: false,
        message:
          `"${text}" is not a valid all-day ${label}. All-day events take date-only values ` +
          `(YYYY-MM-DD) — to give the event times instead, drop allDay.`,
      };
    }
    if (!isRealDate(text)) {
      return { ok: false, message: `"${text}" is not a real calendar date.` };
    }
  }

  const endText = (end ?? '').trim() || startText;
  if (endText < startText) {
    return {
      ok: false,
      message: `The all-day end date ${endText} is before the start date ${startText}.`,
    };
  }

  return { ok: true, value: { startDate: startText, endDate: endText } };
}

/** What an all-day write sends to Graph: exclusive-end midnight boundaries. */
export interface AllDayBoundaries {
  readonly isAllDay: true;
  readonly start: GraphDateTime;
  readonly end: GraphDateTime;
}

/** Converts an inclusive span into Graph's midnight-to-next-midnight form. */
export function allDayBoundaries(span: AllDaySpan, timeZone: string): AllDayBoundaries {
  return {
    isAllDay: true,
    start: { dateTime: `${span.startDate}T00:00:00`, timeZone },
    end: { dateTime: `${addDays(span.endDate, 1)}T00:00:00`, timeZone },
  };
}

/**
 * Recovers the inclusive span from Graph's stored boundaries. Safe in any
 * requested zone: Graph always returns an all-day boundary as the original
 * date at 00:00:00, unconverted.
 */
export function allDaySpanOf(
  start: { readonly dateTime?: string | undefined } | undefined,
  end: { readonly dateTime?: string | undefined } | undefined,
): AllDaySpan {
  const startDate = datePart(start?.dateTime ?? '');
  const endDate = end?.dateTime ? addDays(datePart(end.dateTime), -1) : startDate;
  return { startDate, endDate: endDate >= startDate ? endDate : startDate };
}

/**
 * Normalises a timed boundary, honouring a per-event zone for naive
 * timestamps and refusing the contradictory combination outright: converting
 * an offset timestamp *into* a named zone would need a zone database the
 * server does not have (the zone may be a Windows name).
 */
export function resolveTimedBoundary(
  value: string,
  timeZone: string | undefined,
  configuredZone: string,
  label: string,
): DateTimeResult {
  if (timeZone !== undefined && hasExplicitOffset(value)) {
    return {
      ok: false,
      message:
        `The ${label} "${value}" carries an offset, which already fixes the exact instant, ` +
        `so timeZone "${timeZone}" cannot also apply. Pass the time without the offset to ` +
        `place it in that zone, or drop timeZone to keep the instant.`,
    };
  }
  return toGraphDateTime(value, timeZone ?? configuredZone, label);
}

/**
 * Re-zones an event: each wall-clock time is kept and re-stamped with the new
 * zone, so 11:00 stays 11:00 and the instant moves — the reading the Outlook
 * timezone picker uses.
 */
export function rezoneBoundaries(
  startDateTime: string,
  endDateTime: string,
  newZone: string,
): { start: GraphDateTime; end: GraphDateTime } {
  return {
    start: { dateTime: startDateTime, timeZone: newZone },
    end: { dateTime: endDateTime, timeZone: newZone },
  };
}
