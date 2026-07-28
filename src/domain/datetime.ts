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

/** Trailing `Z`, `+02:00`, or `-0500`. */
const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;

/** A naive timestamp must at least look like one before it is passed on. */
const LOOKS_LIKE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

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

  if (HAS_OFFSET.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, message: `"${text}" is not a valid ${label}.` };
    }
    // Keeping the instant exact beats honouring a named zone that contradicts it.
    return {
      ok: true,
      value: { dateTime: parsed.toISOString().replace(/\.\d+Z$/, ''), timeZone: 'UTC' },
    };
  }

  if (!LOOKS_LIKE_DATETIME.test(text)) {
    return {
      ok: false,
      message:
        `"${text}" is not a valid ${label}. Use ISO 8601 — 2026-08-15T14:00:00 means ` +
        `2pm in the configured timezone.`,
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
