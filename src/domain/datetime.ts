/**
 * Times, and the one way they silently go wrong.
 *
 * Graph's `dateTimeTimeZone` wants a zone-less timestamp plus a named zone.
 * Pairing a timestamp that already carries `Z` or `+02:00` with a named zone is
 * contradictory, and Graph resolves it by ignoring the offset — so `14:00:00Z`
 * becomes 14:00 local. An hours-off error, with no error.
 *
 * Rather than make that a rule for callers to remember, both forms are accepted:
 * an offset-bearing timestamp is converted to the instant it actually names and
 * sent as UTC; a naive one is stamped with the configured zone.
 */

export interface GraphDateTime {
  readonly dateTime: string;
  readonly timeZone: string;
}

export type DateTimeResult =
  | { readonly ok: true; readonly value: GraphDateTime }
  | { readonly ok: false; readonly message: string };

/**
 * The whole value must be one ISO 8601 timestamp: date, `T` or space, time
 * (seconds and fraction optional), then optionally an offset in any ISO form —
 * `Z`, `+02`, `+02:00`, or `-0500`. Anchored at both ends: trailing text
 * ("…T14:00 lunch with Bob") must be refused here, not passed to Graph to
 * fail as an opaque 400.
 */
const ISO_SHAPE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Accepts a bare string or Graph's own {dateTime, timeZone} shape. */
export type DateTimeInput = string | { dateTime?: string; timeZone?: string } | undefined;

/**
 * Normalises a date/time argument into Graph's shape.
 *
 * @param label argument name, for the message when it is not a date at all
 */
export function toGraphDateTime(
  value: DateTimeInput,
  defaultTimeZone: string,
  label = 'time',
): DateTimeResult {
  const raw = typeof value === 'object' && value !== null ? value.dateTime : value;
  const text = String(raw ?? '').trim();

  if (!text) {
    const article = /^[aeiou]/i.test(label) ? 'An' : 'A';
    return { ok: false, message: `${article} ${label} is required.` };
  }

  const match = ISO_SHAPE.exec(text);
  if (!match) {
    return {
      ok: false,
      message:
        `"${text}" is not a valid ${label}. Use ISO 8601 — 2026-08-15T14:00:00 means ` +
        `2pm in the configured timezone.`,
    };
  }
  // Groups 1 and 2 are unconditional in ISO_SHAPE; only the offset is optional.
  const [, date = '', time = '', offset] = match;

  // The shape says nothing about whether the components name a real moment
  // (month 13 fits the shape). Parsing with an explicit offset — Z standing in
  // for a naive value, ±HH and ±HHMM widened to the ±HH:MM form Date requires —
  // makes new Date() the validity check, with no clock or zone lookup involved.
  const parseOffset =
    offset === undefined || /^z$/i.test(offset)
      ? 'Z'
      : offset.length === 3
        ? `${offset}:00`
        : offset.includes(':')
          ? offset
          : `${offset.slice(0, 3)}:${offset.slice(3)}`;

  const parsed = new Date(`${date}T${time}${parseOffset}`);
  // NaN catches month 13 and hour 99, but V8 rolls a day past the end of its
  // month into the next (Feb 30 parses as Mar 2), so a real date must also
  // survive a round-trip unchanged. The check stays in the date's own frame —
  // midnight UTC — so an offset cannot shift the day being compared.
  const impossible =
    Number.isNaN(parsed.getTime()) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date;
  if (impossible) {
    return {
      ok: false,
      message: `"${text}" is not a valid ${label}: its components name no real date and time.`,
    };
  }

  if (offset !== undefined) {
    // Keeping the instant exact beats honouring a named zone that contradicts it.
    return {
      ok: true,
      value: { dateTime: parsed.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' },
    };
  }

  const explicitZone =
    typeof value === 'object' && value !== null ? value.timeZone : undefined;

  return { ok: true, value: { dateTime: text, timeZone: explicitZone || defaultTimeZone } };
}

/** Formats a Graph dateTimeTimeZone for display, keeping the zone visible. */
export function describeDateTime(value: GraphDateTime | undefined): string {
  if (!value?.dateTime) return 'unknown';
  return `${value.dateTime.slice(0, 16).replace('T', ' ')} (${value.timeZone})`;
}

/** The date part of a Graph timestamp, for comparing against a recurrence range. */
export const datePart = (dateTime: string): string => dateTime.slice(0, 10);
