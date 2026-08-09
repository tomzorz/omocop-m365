/**
 * Shared machinery for the calendar tools.
 *
 * Everything here touches Graph, which is why it is not in `domain/` — but the
 * decisions it makes are all delegated to pure functions there. This module is
 * the seam: fetch, hand the facts to a decision, act on the answer.
 */
import { z } from 'zod';
import type { GraphClient } from '../graph/client.js';
import { gpath } from '../graph/path.js';
import { resolveByName, type Resolution } from '../domain/resolve.js';
import {
  normaliseScope,
  invalidScopeMessage,
  resolveScope,
  type EventFacts,
  type RecurrenceScope,
  type SCOPE_WORDING,
} from '../domain/recurrence.js';
import type { ToolContext, ToolPolicy } from '../server/tool.js';

/** A calendar as this server cares about it. */
export interface Calendar {
  readonly id: string;
  readonly name: string;
  readonly canEdit?: boolean;
  readonly isDefaultCalendar?: boolean;
  readonly owner?: { readonly name?: string; readonly address?: string };
}

const CALENDAR_SELECT = 'id,name,isDefaultCalendar,canEdit,owner';

/** Fields the recurrence decision and the response text need. */
export const EVENT_FACTS_SELECT = 'id,subject,type,seriesMasterId,start';

/** Reusable argument fragments, so every calendar tool describes them the same way. */
export const CALENDAR_ARG = z
  .string()
  .describe(
    'Calendar name or id. A partial name works when it is unambiguous. ' +
      'Omit for the default calendar; use list-calendars to see the options.',
  );

export const SCOPE_ARG = z
  .enum(['this', 'series'])
  .describe(
    'Required for recurring events, ignored for one-off ones. "this" acts on the single ' +
      'occurrence identified by eventId; "series" acts on every occurrence. If the user has ' +
      'not said which they mean, ask — do not assume.',
  );

/** Every calendar visible to the mailbox, including ones shared in. */
export async function fetchCalendars(graph: GraphClient): Promise<Calendar[]> {
  const { items } = await graph.collect<Calendar>('me/calendars', { $select: CALENDAR_SELECT });
  return items;
}

/** Resolves a calendar reference, refusing rather than guessing. */
export async function resolveCalendar(
  graph: GraphClient,
  ref: string,
): Promise<Resolution<Calendar>> {
  return resolveByName(await fetchCalendars(graph), ref, {
    id: (c) => c.id,
    name: (c) => c.name,
    label: 'calendar',
  });
}

/** Collection path for creating or listing events. */
export const eventsPath = (calendar: Calendar | null): string =>
  calendar ? gpath`me/calendars/${calendar.id}/events` : 'me/events';

/** Expanded view, which includes occurrences of recurring events. */
export const calendarViewPath = (calendar: Calendar | null): string =>
  calendar ? gpath`me/calendars/${calendar.id}/calendarView` : 'me/calendarView';

/** A single event, optionally scoped to a calendar. */
export const eventPath = (calendar: Calendar | null, eventId: string): string =>
  calendar ? gpath`me/calendars/${calendar.id}/events/${eventId}` : gpath`me/events/${eventId}`;

/** Normalises an attendee argument into Graph's shape. */
export function toAttendee(
  entry: string | { email?: string; name?: string; type?: string },
  defaultType = 'required',
): { emailAddress: { address: string; name?: string }; type: string } {
  if (typeof entry === 'string') {
    return { emailAddress: { address: entry.trim() }, type: defaultType };
  }
  return {
    emailAddress: {
      address: String(entry.email ?? '').trim(),
      ...(entry.name ? { name: entry.name } : {}),
    },
    type: entry.type ?? defaultType,
  };
}

/** Lower-cased address, for comparing attendees. */
export const attendeeEmail = (attendee: { emailAddress?: { address?: string } }): string =>
  String(attendee.emailAddress?.address ?? '').trim().toLowerCase();

/* -------------------------------------------------------------------------- */

/** What the recurrence policy hands to a handler. */
export interface EventTarget {
  readonly calendar: Calendar | null;
  /** The event the caller named. */
  readonly event: EventFacts;
  /** The id to act on — the occurrence, or its series master. */
  readonly targetId: string;
  readonly isRecurring: boolean;
  readonly scope?: RecurrenceScope;
}

const TARGET_KEY = Symbol('calendar.target');

/** Reads what {@link requireEventTarget} resolved. */
export function eventTarget(ctx: ToolContext): EventTarget {
  const target = ctx.resolved.get(TARGET_KEY);
  if (!target) throw new Error('requireEventTarget did not run before the handler');
  return target as EventTarget;
}

interface TargetArgs {
  readonly eventId: string;
  readonly calendar?: string | undefined;
  readonly scope?: string | undefined;
}

/**
 * Resolves the calendar and the recurrence scope before the handler runs.
 *
 * This is the policy the whole harness exists for. Update, delete and cancel all
 * need exactly this, and implementing it three times is how one of them ends up
 * quietly deleting a series. Declared once, it is unreachable to get wrong: a
 * handler cannot be entered with a recurring event and no stated scope.
 */
export function requireEventTarget(
  action: keyof typeof SCOPE_WORDING,
): ToolPolicy<TargetArgs> {
  return async (args, ctx) => {
    const scope = normaliseScope(args.scope);
    if (scope === null) return { refuse: invalidScopeMessage(args.scope) };

    let calendar: Calendar | null = null;
    if (args.calendar) {
      const resolution = await resolveCalendar(ctx.graph, args.calendar);
      if (resolution.kind !== 'matched') return { refuse: resolution.message };
      calendar = resolution.item;

      // Every action reaching this policy mutates the event, so a read-only
      // calendar refuses them all — before the event itself is even fetched.
      if (calendar.canEdit === false) {
        return {
          refuse: `Calendar "${calendar.name}" is read-only, so its events cannot be changed.`,
        };
      }
    }

    // Reading the event first is the only way to know whether the
    // occurrence-or-series question even applies.
    const event = await ctx.graph.get<EventFacts>(eventPath(calendar, args.eventId), {
      $select: EVENT_FACTS_SELECT,
    });

    const resolution = resolveScope(event, scope, action);
    if (resolution.kind === 'refused') return { refuse: resolution.message };

    const target: EventTarget = {
      calendar,
      event,
      targetId: resolution.targetId,
      isRecurring: resolution.kind === 'resolved',
      ...(resolution.kind === 'resolved' ? { scope: resolution.scope } : {}),
    };

    return { proceed: true, key: TARGET_KEY, value: target };
  };
}

/** Resolves only the calendar, for tools with no event to classify. */
export function requireCalendar(options: { mustBeWritable: boolean }): ToolPolicy<{
  readonly calendar?: string | undefined;
}> {
  return async (args, ctx) => {
    if (!args.calendar) return { proceed: true, key: CALENDAR_KEY, value: null };

    const resolution = await resolveCalendar(ctx.graph, args.calendar);
    if (resolution.kind !== 'matched') return { refuse: resolution.message };

    if (options.mustBeWritable && resolution.item.canEdit === false) {
      return {
        refuse: `Calendar "${resolution.item.name}" is read-only, so events cannot be created in it.`,
      };
    }

    return { proceed: true, key: CALENDAR_KEY, value: resolution.item };
  };
}

const CALENDAR_KEY = Symbol('calendar.resolved');

/** Reads what {@link requireCalendar} resolved. */
export function resolvedCalendar(ctx: ToolContext): Calendar | null {
  return (ctx.resolved.get(CALENDAR_KEY) as Calendar | null | undefined) ?? null;
}
