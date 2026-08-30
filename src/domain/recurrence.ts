/**
 * Occurrence, or series?
 *
 * Listing a calendar returns individual *occurrences* of a repeating event. The
 * series they belong to is a different object with a different id, and the two
 * are indistinguishable to a caller holding one. So "move the standup" has two
 * possible meanings that look identical from the outside, and one of them
 * changes a year of entries.
 *
 * Every tool that edits, deletes or cancels needs the same decision, so it is
 * made here — as a pure function over facts about the event, with no Graph call
 * and no MCP concern, which is what makes it exhaustively testable.
 */

export type RecurrenceScope = 'this' | 'series';

/** What an action does at each scope, so a refusal describes real consequences. */
export interface ScopeWording {
  /** Noun for the action, e.g. "deletion". */
  readonly noun: string;
  readonly onThis: string;
  readonly onSeries: string;
}

export const SCOPE_WORDING: Readonly<Record<'update' | 'delete' | 'cancel', ScopeWording>> = {
  update: {
    noun: 'update',
    onThis: 'changes only that single occurrence, leaving the rest of the series alone',
    onSeries: 'changes every occurrence',
  },
  delete: {
    noun: 'deletion',
    onThis: 'deletes only that single occurrence, leaving the rest of the series in place',
    onSeries: 'deletes every occurrence, removing the entire series',
  },
  cancel: {
    noun: 'cancellation',
    onThis: 'cancels only that single occurrence and notifies attendees about that date',
    onSeries: 'cancels every occurrence and tells attendees the whole series is off',
  },
};

/** The event properties this decision depends on. */
export interface EventFacts {
  readonly id: string;
  readonly subject?: string | undefined;
  /** Graph's `type`: singleInstance | occurrence | exception | seriesMaster. */
  readonly type?: string | undefined;
  readonly seriesMasterId?: string | undefined;
  readonly start?: { readonly dateTime?: string | undefined } | undefined;
  readonly isAllDay?: boolean | undefined;
}

export type ScopeResolution =
  /** Not recurring; scope is irrelevant and the event is its own target. */
  | { readonly kind: 'single'; readonly targetId: string }
  /** Recurring and unambiguous; act on targetId. */
  | { readonly kind: 'resolved'; readonly targetId: string; readonly scope: RecurrenceScope }
  /** Recurring and the caller has not said which they mean. */
  | { readonly kind: 'refused'; readonly message: string };

const THIS_ALIASES = new Set([
  'this', 'occurrence', 'instance', 'single', 'this-one', 'this-event',
  'this-occurrence', 'just-this', 'just-this-one', 'only-this',
]);

const SERIES_ALIASES = new Set([
  'series', 'all', 'all-occurrences', 'whole-series', 'entire-series',
  'master', 'series-master', 'recurring', 'every',
]);

/**
 * Maps a scope argument onto a scope.
 *
 * @returns the scope, `undefined` when unset, `null` when unrecognised
 */
export function normaliseScope(raw: unknown): RecurrenceScope | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (THIS_ALIASES.has(value)) return 'this';
  if (SERIES_ALIASES.has(value)) return 'series';
  return null;
}

export const invalidScopeMessage = (raw: unknown): string =>
  `Unrecognised scope "${String(raw)}". Use scope:"this" for a single occurrence ` +
  `or scope:"series" for every occurrence.`;

/** True when Graph says this event is part of a repeating series. */
export const isRecurring = (event: EventFacts): boolean =>
  (event.type ?? 'singleInstance') !== 'singleInstance';

/** Formats an occurrence's date for a refusal message. */
function occurrenceDate(event: EventFacts): string {
  const raw = event.start?.dateTime ?? '';
  return raw ? ` (${raw.slice(0, 16).replace('T', ' ')})` : '';
}

/**
 * Decides which event id an action should target.
 *
 * @param scope already through {@link normaliseScope}
 */
export function resolveScope(
  event: EventFacts,
  scope: RecurrenceScope | undefined,
  action: keyof typeof SCOPE_WORDING,
): ScopeResolution {
  if (!isRecurring(event)) return { kind: 'single', targetId: event.id };

  const wording = SCOPE_WORDING[action];
  const subject = event.subject ?? event.id;

  if (!scope) {
    const which =
      event.type === 'seriesMaster'
        ? 'the master of a recurring series'
        : `one occurrence${occurrenceDate(event)} of a recurring series`;

    return {
      kind: 'refused',
      message:
        `"${subject}" is ${which}, so this ${wording.noun} needs an explicit scope.\n\n` +
        `- scope:"this" ${wording.onThis}.\n` +
        `- scope:"series" ${wording.onSeries}.\n\n` +
        `Ask which was meant and repeat the call with that scope. Do not guess.`,
    };
  }

  // A master id names the series, not any one date, so "this" has no referent.
  if (event.type === 'seriesMaster' && scope === 'this') {
    return {
      kind: 'refused',
      message:
        `"${subject}" is the master of a recurring series, so this id does not identify a ` +
        `single occurrence. Pass scope:"series", which ${wording.onSeries}, or take the ` +
        `specific occurrence's id from a listing and call again with scope:"this".`,
    };
  }

  if (scope === 'this') return { kind: 'resolved', targetId: event.id, scope };

  // scope === 'series'. A master's own id names the series; an occurrence's id
  // names one date, so it may only stand in for the series when the master's id
  // is actually known — otherwise the action would touch one occurrence while
  // being reported as covering the whole series.
  if (event.type === 'seriesMaster') {
    return { kind: 'resolved', targetId: event.id, scope };
  }

  if (!event.seriesMasterId) {
    return {
      kind: 'refused',
      message:
        `"${subject}" is one occurrence${occurrenceDate(event)} of a recurring series, but ` +
        `the data returned for it has no seriesMasterId, so no id that names the whole ` +
        `series is available. Acting on this id would touch only this occurrence while ` +
        `claiming the ${wording.noun} ${wording.onSeries}. Re-fetch the event with its ` +
        `seriesMasterId included (or take the master's id from a listing) and call again, ` +
        `or pass scope:"this", which ${wording.onThis}.`,
    };
  }

  return { kind: 'resolved', targetId: event.seriesMasterId, scope };
}

/** Suffix describing what a completed action covered. */
export function scopeNote(
  resolution: ScopeResolution,
): string {
  if (resolution.kind !== 'resolved') return '';
  return resolution.scope === 'series'
    ? ' (every occurrence in the series)'
    : ' (this occurrence only)';
}
