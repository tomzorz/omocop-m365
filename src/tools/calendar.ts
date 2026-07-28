/**
 * Calendar tools.
 *
 * Declarations only — the preamble every one of these would otherwise repeat
 * lives in the harness, and the decisions they turn on live in `domain/`. What
 * is left is the part that differs: which Graph call, and how to say what
 * happened.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { AnyToolDefinition } from '../server/registry.js';
import { toGraphDateTime, describeDateTime, datePart } from '../domain/datetime.js';
import { scopeNote, type ScopeResolution } from '../domain/recurrence.js';
import {
  CALENDAR_ARG,
  SCOPE_ARG,
  attendeeEmail,
  calendarViewPath,
  eventPath,
  eventTarget,
  eventsPath,
  fetchCalendars,
  requireCalendar,
  requireEventTarget,
  resolvedCalendar,
  toAttendee,
  type Calendar,
} from './calendar-support.js';

const READ = 'Calendars.Read';
const WRITE = 'Calendars.ReadWrite';

/** Shape of an event as the listing renders it. */
const EventSummary = z.object({
  id: z.string(),
  subject: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  calendar: z.string().optional(),
  attendees: z.array(z.string()),
  isRecurring: z.boolean(),
  preview: z.string().optional(),
});

/* -------------------------------------------------------------------------- */

const listCalendars = defineTool({
  name: 'list-calendars',
  title: 'List calendars',
  description:
    'Lists every calendar in the mailbox, including ones shared in from other people, ' +
    'with whether each can be written to.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {},
  output: {
    calendars: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        writable: z.boolean(),
        isDefault: z.boolean(),
        owner: z.string().optional(),
      }),
    ),
  },
  handler: async (_args, ctx) => ({
    calendars: (await fetchCalendars(ctx.graph)).map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      writable: calendar.canEdit !== false,
      isDefault: calendar.isDefaultCalendar === true,
      ...(calendar.owner?.address ? { owner: calendar.owner.address } : {}),
    })),
  }),
  render: (data) =>
    data.calendars.length === 0
      ? 'No calendars found.'
      : `${data.calendars.length} calendar(s):\n\n` +
        data.calendars
          .map(
            (c) =>
              `- ${c.name}${c.isDefault ? ' (default)' : ''} — ` +
              `${c.writable ? 'writable' : 'read-only'}` +
              `${c.owner ? `, owned by ${c.owner}` : ''}\n  ID: ${c.id}`,
          )
          .join('\n'),
});

/* -------------------------------------------------------------------------- */

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  type?: string;
}

const listEvents = defineTool({
  name: 'list-events',
  title: 'List calendar events',
  description:
    'Lists events in a date range. Recurring events are expanded into their individual ' +
    'occurrences. Always pass an explicit range — the response states the window it used, ' +
    'and says so when the result was capped.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {
    startDateTime: z
      .string()
      .optional()
      .describe('ISO 8601 start of the range. Defaults to now.'),
    endDateTime: z
      .string()
      .optional()
      .describe('ISO 8601 end of the range. Defaults to 30 days after the start.'),
    count: z.number().int().min(1).max(50).optional().describe('Maximum events. Default 10.'),
    calendar: CALENDAR_ARG.optional(),
  },
  output: {
    events: z.array(EventSummary),
    window: z.object({ start: z.string(), end: z.string(), defaulted: z.boolean() }),
    truncated: z.boolean(),
    calendar: z.string().optional(),
  },
  policies: [requireCalendar({ mustBeWritable: false })],
  handler: async (args, ctx) => {
    const calendar = resolvedCalendar(ctx);
    const count = args.count ?? 10;

    const start = args.startDateTime ? new Date(args.startDateTime) : new Date();
    const end = args.endDateTime
      ? new Date(args.endDateTime)
      : new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('startDateTime and endDateTime must be valid ISO 8601 timestamps.');
    }
    if (end <= start) {
      throw new Error('endDateTime must be after startDateTime.');
    }

    const { items, truncated } = await ctx.graph.collect<GraphEvent>(
      calendarViewPath(calendar),
      {
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        $orderby: 'start/dateTime',
        $select: 'id,subject,bodyPreview,start,end,location,attendees,type',
      },
      count,
    );

    return {
      events: items.map((event) => ({
        id: event.id,
        subject: event.subject ?? '(no subject)',
        start: describeDateTime(event.start as never),
        end: describeDateTime(event.end as never),
        ...(event.location?.displayName ? { location: event.location.displayName } : {}),
        ...(calendar ? { calendar: calendar.name } : {}),
        attendees: (event.attendees ?? [])
          .map((a) => a.emailAddress?.address)
          .filter((a): a is string => Boolean(a)),
        isRecurring: (event.type ?? 'singleInstance') !== 'singleInstance',
        ...(event.bodyPreview ? { preview: event.bodyPreview.slice(0, 200) } : {}),
      })),
      window: {
        start: start.toISOString(),
        end: end.toISOString(),
        defaulted: !args.startDateTime || !args.endDateTime,
      },
      truncated,
      ...(calendar ? { calendar: calendar.name } : {}),
    };
  },
  render: (data) => {
    const window =
      `${data.window.start.slice(0, 16).replace('T', ' ')} to ` +
      `${data.window.end.slice(0, 16).replace('T', ' ')} UTC` +
      (data.window.defaulted ? ' (range defaulted — none was given)' : '');

    if (data.events.length === 0) return `No events in ${window}.`;

    const lines = data.events.map((event, index) => {
      const parts = [
        `${index + 1}. ${event.subject}`,
        `   ${event.start} → ${event.end}`,
      ];
      if (event.location) parts.push(`   Location: ${event.location}`);
      if (event.attendees.length) parts.push(`   Attendees: ${event.attendees.join(', ')}`);
      if (event.isRecurring) {
        parts.push('   Recurring: one occurrence of a series — editing needs a scope');
      }
      parts.push(`   ID: ${event.id}`);
      return parts.join('\n');
    });

    return (
      `${data.events.length} event(s) in ${window}:\n\n${lines.join('\n\n')}` +
      (data.truncated ? '\n\nMore events exist in this range — narrow it or raise count.' : '')
    );
  },
});

/* -------------------------------------------------------------------------- */

const createEvent = defineTool({
  name: 'create-event',
  title: 'Create a calendar event',
  description:
    'Creates an event. Times without a timezone offset are read in the configured ' +
    'timezone; a timestamp carrying Z or an offset is honoured as that exact instant. ' +
    'The response states which was used.',
  scopes: [WRITE],
  input: {
    subject: z.string().min(1),
    start: z.string().describe('ISO 8601 start, e.g. 2026-08-15T14:00:00'),
    end: z.string().describe('ISO 8601 end'),
    location: z.string().optional().describe('Room, address, venue, or meeting link'),
    body: z.string().optional(),
    attendees: z.array(z.string()).optional().describe('Email addresses to invite'),
    calendar: CALENDAR_ARG.optional(),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    start: z.string(),
    end: z.string(),
    timeZone: z.string(),
    location: z.string().optional(),
    calendar: z.string().optional(),
    invited: z.number(),
  },
  policies: [requireCalendar({ mustBeWritable: true })],
  handler: async (args, ctx) => {
    const calendar = resolvedCalendar(ctx);

    const start = toGraphDateTime(args.start, ctx.config.timezone, 'start time');
    if (!start.ok) throw new Error(start.message);
    const end = toGraphDateTime(args.end, ctx.config.timezone, 'end time');
    if (!end.ok) throw new Error(end.message);

    const location = args.location?.trim();
    const attendees = (args.attendees ?? []).map((entry) => toAttendee(entry));

    const created = await ctx.graph.post<{ id: string; subject?: string }>(eventsPath(calendar), {
      subject: args.subject,
      start: start.value,
      end: end.value,
      body: { contentType: 'HTML', content: args.body ?? '' },
      ...(location ? { location: { displayName: location } } : {}),
      ...(attendees.length ? { attendees } : {}),
    });

    return {
      id: created.id,
      subject: created.subject ?? args.subject,
      start: start.value.dateTime,
      end: end.value.dateTime,
      timeZone: start.value.timeZone,
      ...(location ? { location } : {}),
      ...(calendar ? { calendar: calendar.name } : {}),
      invited: attendees.length,
    };
  },
  render: (data) =>
    `Created "${data.subject}"${data.calendar ? ` in "${data.calendar}"` : ''}` +
    `${data.location ? ` at ${data.location}` : ''}.\n` +
    `Scheduled for ${data.start} to ${data.end} (${data.timeZone}).` +
    (data.invited ? `\nInvitations sent to ${data.invited} attendee(s).` : '') +
    `\nID: ${data.id}`,
});

/* -------------------------------------------------------------------------- */

const updateEvent = defineTool({
  name: 'update-event',
  title: 'Update a calendar event',
  description:
    'Edits an event in place, keeping its id, organiser and the responses of anyone already ' +
    'invited. Use this rather than deleting and recreating — recreating cancels the original ' +
    'for every attendee. Only the fields passed are changed. Recurring events REQUIRE scope.',
  scopes: [WRITE],
  input: {
    eventId: z.string().describe('Event id, from a list-events result'),
    scope: SCOPE_ARG.optional(),
    subject: z.string().optional(),
    start: z.string().optional().describe('New ISO 8601 start. Pass end too when moving.'),
    end: z.string().optional(),
    location: z.string().optional().describe('Pass an empty string to clear it'),
    body: z.string().optional(),
    attendees: z
      .array(z.string())
      .optional()
      .describe('REPLACES the whole invitee list — anyone omitted is uninvited'),
    addAttendees: z.array(z.string()).optional().describe('Invite these, keeping the rest'),
    removeAttendees: z.array(z.string()).optional().describe('Uninvite just these'),
    calendar: CALENDAR_ARG.optional(),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    changes: z.array(z.string()),
    scope: z.enum(['this', 'series']).optional(),
    notified: z.number(),
  },
  policies: [requireEventTarget('update')],
  handler: async (args, ctx) => {
    const target = eventTarget(ctx);

    const replacing = args.attendees !== undefined;
    const adjusting = args.addAttendees !== undefined || args.removeAttendees !== undefined;
    if (replacing && adjusting) {
      throw new Error(
        'Pass either `attendees`, which replaces the whole invitee list, or ' +
          '`addAttendees`/`removeAttendees`, which adjust it — not both.',
      );
    }

    const update: Record<string, unknown> = {};
    const changes: string[] = [];

    if (args.subject !== undefined) {
      update['subject'] = args.subject;
      changes.push(`subject to "${args.subject}"`);
    }

    for (const [key, value, label] of [
      ['start', args.start, 'start time'],
      ['end', args.end, 'end time'],
    ] as const) {
      if (value === undefined) continue;
      const parsed = toGraphDateTime(value, ctx.config.timezone, label);
      if (!parsed.ok) throw new Error(parsed.message);
      update[key] = parsed.value;
      changes.push(`${key} to ${parsed.value.dateTime} (${parsed.value.timeZone})`);
    }

    if (args.location !== undefined) {
      const name = args.location.trim();
      update['location'] = { displayName: name };
      changes.push(name ? `location to "${name}"` : 'location cleared');
    }

    if (args.body !== undefined) {
      update['body'] = { contentType: 'HTML', content: args.body };
      changes.push('body');
    }

    if (replacing) {
      const list = (args.attendees ?? []).map((entry) => toAttendee(entry));
      update['attendees'] = list;
      changes.push(`invitee list replaced with ${list.length} attendee(s)`);
    } else if (adjusting) {
      const current = await ctx.graph.get<{ attendees?: Array<Record<string, unknown>> }>(
        eventPath(target.calendar, target.targetId),
        { $select: 'attendees' },
      );
      let merged = current.attendees ?? [];

      const dropping = new Set(
        (args.removeAttendees ?? []).map((entry) => attendeeEmail(toAttendee(entry))),
      );
      if (dropping.size) {
        const before = merged.length;
        merged = merged.filter((a) => !dropping.has(attendeeEmail(a)));
        const dropped = before - merged.length;
        changes.push(dropped ? `uninvited ${dropped} attendee(s)` : 'no matching attendee to uninvite');
      }

      const seen = new Set(merged.map((a) => attendeeEmail(a)));
      const added: Array<Record<string, unknown>> = [];
      for (const entry of args.addAttendees ?? []) {
        const attendee = toAttendee(entry);
        const email = attendeeEmail(attendee);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        added.push(attendee as unknown as Record<string, unknown>);
      }
      if (added.length) {
        merged = merged.concat(added);
        changes.push(`invited ${added.map((a) => attendeeEmail(a)).join(', ')}`);
      } else if (args.addAttendees !== undefined) {
        changes.push('no new attendees to invite');
      }

      update['attendees'] = merged;
    }

    if (changes.length === 0) {
      throw new Error(
        'Nothing to update. Pass at least one of: subject, start, end, location, body, ' +
          'attendees, addAttendees, removeAttendees.',
      );
    }

    // Moving a whole series to a new date needs its recurrence range moved with
    // it; Graph rejects a master whose start falls outside its own range.
    if (target.scope === 'series' && update['start']) {
      const master = await ctx.graph.get<{
        recurrence?: { range?: { startDate?: string } };
      }>(eventPath(target.calendar, target.targetId), { $select: 'recurrence' });

      const range = master.recurrence?.range;
      const newDate = datePart((update['start'] as { dateTime: string }).dateTime);
      if (range?.startDate && range.startDate !== newDate) {
        update['recurrence'] = {
          ...master.recurrence,
          range: { ...range, startDate: newDate },
        };
        changes.push(`recurrence start date to ${newDate}`);
      }
    }

    const response = await ctx.graph.patch<{ subject?: string; attendees?: unknown[] }>(
      eventPath(target.calendar, target.targetId),
      update,
    );

    return {
      id: target.targetId,
      subject: response.subject ?? target.event.subject ?? target.targetId,
      changes,
      ...(target.scope ? { scope: target.scope } : {}),
      notified: (response.attendees ?? []).length,
    };
  },
  render: (data) =>
    `Updated "${data.subject}"` +
    `${data.scope ? (data.scope === 'series' ? ' (every occurrence in the series)' : ' (this occurrence only)') : ''}: ` +
    `${data.changes.join('; ')}.` +
    (data.notified
      ? ` Outlook has sent the updated invitation to ${data.notified} attendee(s).`
      : ''),
});

/* -------------------------------------------------------------------------- */

const deleteEvent = defineTool({
  name: 'delete-event',
  title: 'Delete a calendar event',
  description:
    'Deletes an event. To CHANGE one, use update-event instead — deleting and recreating ' +
    'cancels the original for every attendee and loses their responses. Recurring events ' +
    'REQUIRE scope. Not reversible.',
  scopes: [WRITE],
  annotations: { destructiveHint: true, idempotentHint: true },
  input: {
    eventId: z.string(),
    scope: SCOPE_ARG.optional(),
    calendar: CALENDAR_ARG.optional(),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    scope: z.enum(['this', 'series']).optional(),
  },
  policies: [requireEventTarget('delete')],
  handler: async (_args, ctx) => {
    const target = eventTarget(ctx);
    await ctx.graph.delete(eventPath(target.calendar, target.targetId));
    return {
      id: target.targetId,
      subject: target.event.subject ?? target.targetId,
      ...(target.scope ? { scope: target.scope } : {}),
    };
  },
  render: (data) =>
    `"${data.subject}"` +
    (data.scope === 'series'
      ? ' and every other occurrence in its series have been deleted.'
      : data.scope === 'this'
        ? ' has been deleted for that date only; the rest of the series is untouched.'
        : ' has been deleted.'),
});

/* -------------------------------------------------------------------------- */

const cancelEvent = defineTool({
  name: 'cancel-event',
  title: 'Cancel a meeting',
  description:
    'Cancels a meeting you organise and notifies its attendees. To CHANGE an event rather ' +
    'than call it off, use update-event. Recurring events REQUIRE scope. Not reversible.',
  scopes: [WRITE],
  annotations: { destructiveHint: true },
  input: {
    eventId: z.string(),
    scope: SCOPE_ARG.optional(),
    comment: z.string().optional().describe('Note sent to attendees'),
    calendar: CALENDAR_ARG.optional(),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    scope: z.enum(['this', 'series']).optional(),
  },
  policies: [requireEventTarget('cancel')],
  handler: async (args, ctx) => {
    const target = eventTarget(ctx);
    await ctx.graph.post(`${eventPath(target.calendar, target.targetId)}/cancel`, {
      comment: args.comment ?? '',
    });
    return {
      id: target.targetId,
      subject: target.event.subject ?? target.targetId,
      ...(target.scope ? { scope: target.scope } : {}),
    };
  },
  render: (data) =>
    `"${data.subject}"` +
    (data.scope === 'series'
      ? ' and every other occurrence in its series have been cancelled.'
      : data.scope === 'this'
        ? ' has been cancelled for that date only; the rest of the series stands.'
        : ' has been cancelled.') +
    ' Attendees have been notified.',
});

/* -------------------------------------------------------------------------- */

function respondTool(name: 'accept' | 'decline' | 'tentativelyAccept', label: string) {
  return defineTool({
    name: `${label}-event`,
    title: `${label[0]?.toUpperCase()}${label.slice(1)} an invitation`,
    description: `${label[0]?.toUpperCase()}${label.slice(1)}s a meeting invitation and notifies the organiser.`,
    scopes: [WRITE],
    input: {
      eventId: z.string(),
      comment: z.string().optional(),
      calendar: CALENDAR_ARG.optional(),
    },
    output: { id: z.string(), response: z.string() },
    policies: [requireCalendar({ mustBeWritable: false })],
    handler: async (args, ctx) => {
      const calendar = resolvedCalendar(ctx);
      await ctx.graph.post(`${eventPath(calendar, args.eventId)}/${name}`, {
        comment: args.comment ?? '',
        sendResponse: true,
      });
      return { id: args.eventId, response: label };
    },
    render: (data) => `Invitation ${data.response}d. The organiser has been notified.`,
  });
}

export const calendarTools: AnyToolDefinition[] = [
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  cancelEvent,
  respondTool('accept', 'accept'),
  respondTool('decline', 'decline'),
];

export type { Calendar, ScopeResolution };
export { scopeNote };
