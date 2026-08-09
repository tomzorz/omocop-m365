import { describe, expect, test } from 'vitest';
import { calendarTools } from '../../src/tools/calendar.js';
import { runTool } from '../../src/server/tool.js';
import type { AnyToolDefinition } from '../../src/server/registry.js';
import { ALL_SCOPES, fakeGraph, on, testContext, textOf } from '../support/fake-graph.js';

const tool = (name: string): AnyToolDefinition => {
  const found = calendarTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const CALENDARS = {
  items: [
    { id: 'cal-personal', name: 'Personal', canEdit: false, isDefaultCalendar: false },
    { id: 'cal-managed', name: 'Work Managed', canEdit: true, isDefaultCalendar: false },
    { id: 'cal-default', name: 'Calendar', canEdit: true, isDefaultCalendar: true },
  ],
  truncated: false,
};

const OCCURRENCE = {
  id: 'occ1',
  subject: 'Weekly standup',
  type: 'occurrence',
  seriesMasterId: 'master1',
  start: { dateTime: '2026-08-05T09:00:00.0000000' },
};

const SINGLE = { id: 'evt1', subject: 'Lunch', type: 'singleInstance' };

/** Runs a tool against a fake Graph. */
async function call(
  name: string,
  args: Record<string, unknown>,
  ...responders: Parameters<typeof fakeGraph>
) {
  const fake = fakeGraph(...responders);
  const result = await runTool(tool(name), args as never, testContext(fake.graph), ALL_SCOPES);
  return { ...fake, result, text: textOf(result) };
}

describe('list-calendars', () => {
  test('lists names, writability and ids', async () => {
    const { text, result } = await call('list-calendars', {}, on('COLLECT', 'me/calendars', CALENDARS));

    expect(text).toContain('Personal');
    expect(text).toContain('read-only');
    expect(text).toContain('Calendar (default)');
    expect(result.structuredContent).toMatchObject({
      calendars: [
        { name: 'Personal', writable: false },
        { name: 'Work Managed', writable: true },
        { name: 'Calendar', writable: true, isDefault: true },
      ],
    });
  });

  test('says so when there are none', async () => {
    const { text } = await call('list-calendars', {}, on('COLLECT', 'me/calendars', { items: [], truncated: false }));
    expect(text).toBe('No calendars found.');
  });
});

describe('list-events', () => {
  const events = {
    items: [
      {
        id: 'e1',
        subject: 'Standup',
        start: { dateTime: '2026-08-05T09:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-08-05T09:15:00', timeZone: 'UTC' },
        location: { displayName: 'Room 3' },
        attendees: [{ emailAddress: { address: 'team@example.com' } }],
        type: 'occurrence',
      },
    ],
    truncated: false,
  };

  test('reports the window it queried, and flags a defaulted range', async () => {
    const { text } = await call('list-events', {}, on('COLLECT', 'calendarView', events));
    expect(text).toContain('range defaulted');
  });

  test('does not flag the range when both ends were given', async () => {
    const { text } = await call(
      'list-events',
      { startDateTime: '2026-08-01T00:00:00Z', endDateTime: '2026-08-31T00:00:00Z' },
      on('COLLECT', 'calendarView', events),
    );
    expect(text).not.toContain('defaulted');
    expect(text).toContain('2026-08-01 00:00 to 2026-08-31 00:00 UTC');
  });

  test('marks a recurring occurrence so a caller knows a scope is coming', async () => {
    const { text } = await call('list-events', {}, on('COLLECT', 'calendarView', events));
    expect(text).toContain('Recurring: one occurrence of a series');
  });

  test('shows location, attendees and id', async () => {
    const { text } = await call('list-events', {}, on('COLLECT', 'calendarView', events));
    expect(text).toContain('Location: Room 3');
    expect(text).toContain('Attendees: team@example.com');
    expect(text).toContain('ID: e1');
  });

  test('admits truncation rather than looking complete', async () => {
    const { text } = await call(
      'list-events',
      { count: 1 },
      on('COLLECT', 'calendarView', { ...events, truncated: true }),
    );
    expect(text).toContain('More events exist in this range');
  });

  test('targets a named calendar', async () => {
    const { find } = await call(
      'list-events',
      { calendar: 'Managed' },
      on('COLLECT', 'me/calendars', CALENDARS),
      on('COLLECT', 'calendarView', events),
    );
    expect(find('cal-managed/calendarView')).toBeDefined();
  });

  test('refuses an ambiguous calendar name without querying events', async () => {
    const { text, of } = await call(
      'list-events',
      { calendar: 'Cal' },
      on('COLLECT', 'me/calendars', {
        items: [
          { id: 'a', name: 'Calendar one' },
          { id: 'b', name: 'Calendar two' },
        ],
        truncated: false,
      }),
    );
    expect(text).toContain('ambiguous');
    expect(of('COLLECT').some((c) => c.path.includes('calendarView'))).toBe(false);
  });

  test('rejects an inverted range', async () => {
    const { text } = await call('list-events', {
      startDateTime: '2026-08-31T00:00:00Z',
      endDateTime: '2026-08-01T00:00:00Z',
    });
    expect(text).toContain('must be after');
  });

  /**
   * Without $top Graph pages at its own default (~10), so count:50 would cost
   * ~5 sequential round trips. $top must track the requested count.
   */
  test('passes the requested count to Graph as $top', async () => {
    const { of } = await call('list-events', { count: 50 }, on('COLLECT', 'calendarView', events));
    expect(of('COLLECT')[0]?.query?.['$top']).toBe(50);
  });

  test('defaults $top to 10 when no count was given', async () => {
    const { of } = await call('list-events', {}, on('COLLECT', 'calendarView', events));
    expect(of('COLLECT')[0]?.query?.['$top']).toBe(10);
  });
});

describe('create-event', () => {
  const created = { id: 'new1', subject: 'Planning' };

  test('sends a naive time in the configured zone and echoes it back', async () => {
    const { text, of } = await call(
      'create-event',
      { subject: 'Planning', start: '2026-08-15T14:00:00', end: '2026-08-15T15:00:00' },
      on('POST', 'me/events', created),
    );

    const body = of('POST')[0]?.body as { start: { timeZone: string } };
    expect(body.start.timeZone).toBe('W. Europe Standard Time');
    expect(text).toContain('W. Europe Standard Time');
  });

  test('honours a Z timestamp as UTC', async () => {
    const { of } = await call(
      'create-event',
      { subject: 'x', start: '2026-08-15T14:00:00Z', end: '2026-08-15T15:00:00Z' },
      on('POST', 'me/events', created),
    );
    expect((of('POST')[0]?.body as { start: { timeZone: string } }).start.timeZone).toBe('UTC');
  });

  test('puts a location in its own field, not the body', async () => {
    const { of, text } = await call(
      'create-event',
      { subject: 'x', start: '2026-08-15T14:00:00', end: '2026-08-15T15:00:00', location: 'Room 3' },
      on('POST', 'me/events', created),
    );
    expect(of('POST')[0]?.body).toMatchObject({ location: { displayName: 'Room 3' } });
    expect(text).toContain('at Room 3');
  });

  test('invites attendees and says how many', async () => {
    const { of, text } = await call(
      'create-event',
      {
        subject: 'x',
        start: '2026-08-15T14:00:00',
        end: '2026-08-15T15:00:00',
        attendees: ['a@example.com', 'b@example.com'],
      },
      on('POST', 'me/events', created),
    );
    expect((of('POST')[0]?.body as { attendees: unknown[] }).attendees).toHaveLength(2);
    expect(text).toContain('Invitations sent to 2 attendee(s)');
  });

  test('refuses a read-only calendar before creating anything', async () => {
    const { text, of } = await call(
      'create-event',
      { subject: 'x', start: '2026-08-15T14:00:00', end: '2026-08-15T15:00:00', calendar: 'Personal' },
      on('COLLECT', 'me/calendars', CALENDARS),
    );
    expect(text).toContain('read-only');
    expect(of('POST')).toHaveLength(0);
  });

  test('rejects an unparseable time before calling Graph', async () => {
    const { text, of } = await call('create-event', {
      subject: 'x',
      start: 'next tuesday',
      end: '2026-08-15T15:00:00',
    });
    expect(text).toContain('not a valid start time');
    expect(of('POST')).toHaveLength(0);
  });
});

describe('update-event', () => {
  test('patches only the fields supplied', async () => {
    const { of } = await call(
      'update-event',
      { eventId: 'evt1', subject: 'Renamed' },
      on('GET', 'me/events/evt1', SINGLE),
      on('PATCH', 'me/events/evt1', { subject: 'Renamed' }),
    );
    expect(of('PATCH')[0]?.body).toEqual({ subject: 'Renamed' });
  });

  test('refuses a recurring occurrence with no scope, and patches nothing', async () => {
    const { text, of } = await call(
      'update-event',
      { eventId: 'occ1', subject: 'Renamed' },
      on('GET', 'me/events/occ1', OCCURRENCE),
    );
    expect(text).toContain('needs an explicit scope');
    expect(of('PATCH')).toHaveLength(0);
  });

  test('scope "series" patches the master', async () => {
    const { of, text } = await call(
      'update-event',
      { eventId: 'occ1', subject: 'Renamed', scope: 'series' },
      on('GET', 'me/events/occ1', OCCURRENCE),
      on('PATCH', 'me/events/master1', { subject: 'Renamed' }),
    );
    expect(of('PATCH')[0]?.path).toBe('me/events/master1');
    expect(text).toContain('every occurrence in the series');
  });

  test('scope "this" patches the occurrence', async () => {
    const { of, text } = await call(
      'update-event',
      { eventId: 'occ1', subject: 'Renamed', scope: 'this' },
      on('GET', 'me/events/occ1', OCCURRENCE),
      on('PATCH', 'me/events/occ1', { subject: 'Renamed' }),
    );
    expect(of('PATCH')[0]?.path).toBe('me/events/occ1');
    expect(text).toContain('this occurrence only');
  });

  test('clears a location with an empty string', async () => {
    const { of } = await call(
      'update-event',
      { eventId: 'evt1', location: '' },
      on('GET', 'me/events/evt1', SINGLE),
      on('PATCH', 'me/events/evt1', {}),
    );
    expect(of('PATCH')[0]?.body).toEqual({ location: { displayName: '' } });
  });

  test('addAttendees merges, preserving existing responses', async () => {
    const existing = {
      attendees: [
        {
          emailAddress: { address: 'external@partner.com' },
          type: 'required',
          status: { response: 'accepted' },
        },
      ],
    };
    const { of } = await call(
      'update-event',
      { eventId: 'evt1', addAttendees: ['new@example.com'] },
      (c) => (c.method === 'GET' && c.query?.['$select'] === 'attendees' ? existing : undefined),
      on('GET', 'me/events/evt1', SINGLE),
      on('PATCH', 'me/events/evt1', { attendees: [{}, {}] }),
    );

    const sent = (of('PATCH')[0]?.body as { attendees: Array<Record<string, unknown>> }).attendees;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ status: { response: 'accepted' } });
  });

  test('rejects replacing and adjusting attendees together', async () => {
    const { text, of } = await call(
      'update-event',
      { eventId: 'evt1', attendees: ['a@x.com'], addAttendees: ['b@x.com'] },
      on('GET', 'me/events/evt1', SINGLE),
    );
    expect(text).toContain('not both');
    expect(of('PATCH')).toHaveLength(0);
  });

  test('refuses when no field was supplied', async () => {
    const { text } = await call(
      'update-event',
      { eventId: 'evt1' },
      on('GET', 'me/events/evt1', SINGLE),
    );
    expect(text).toContain('Nothing to update');
  });

  test('moves the recurrence range when a series start date changes', async () => {
    const master = {
      recurrence: {
        pattern: { type: 'weekly', interval: 1 },
        range: { type: 'endDate', startDate: '2026-07-01', endDate: '2026-12-31' },
      },
    };
    const { of } = await call(
      'update-event',
      { eventId: 'occ1', start: '2026-08-05T10:00:00', scope: 'series' },
      (c) => (c.method === 'GET' && c.query?.['$select'] === 'recurrence' ? master : undefined),
      on('GET', 'me/events/occ1', OCCURRENCE),
      on('PATCH', 'me/events/master1', {}),
    );

    const body = of('PATCH')[0]?.body as { recurrence?: { range: { startDate: string } } };
    expect(body.recurrence?.range.startDate).toBe('2026-08-05');
  });

  test('leaves the recurrence alone when only the time of day changes', async () => {
    const master = { recurrence: { range: { startDate: '2026-08-05' } } };
    const { of } = await call(
      'update-event',
      { eventId: 'occ1', start: '2026-08-05T15:00:00', scope: 'series' },
      (c) => (c.method === 'GET' && c.query?.['$select'] === 'recurrence' ? master : undefined),
      on('GET', 'me/events/occ1', OCCURRENCE),
      on('PATCH', 'me/events/master1', {}),
    );
    expect(of('PATCH')[0]?.body).not.toHaveProperty('recurrence');
  });

  /**
   * Read-only calendars refuse every mutating action uniformly — update is not
   * exempt, and the refusal comes before the event facts are even fetched.
   */
  test('refuses a read-only calendar before fetching the event', async () => {
    const { text, of } = await call(
      'update-event',
      { eventId: 'evt1', subject: 'Renamed', calendar: 'Personal' },
      on('COLLECT', 'me/calendars', CALENDARS),
    );
    expect(text).toContain('read-only');
    expect(of('GET')).toHaveLength(0);
    expect(of('PATCH')).toHaveLength(0);
  });

  test('reports how many attendees were notified', async () => {
    const { text } = await call(
      'update-event',
      { eventId: 'evt1', subject: 'x' },
      on('GET', 'me/events/evt1', SINGLE),
      on('PATCH', 'me/events/evt1', { subject: 'x', attendees: [{}, {}, {}] }),
    );
    expect(text).toContain('updated invitation to 3 attendee(s)');
  });
});

describe('delete-event and cancel-event', () => {
  test.each([
    ['delete-event', 'DELETE'],
    ['cancel-event', 'POST'],
  ] as const)('%s refuses a recurring occurrence with no scope', async (name, method) => {
    const { text, of } = await call(name, { eventId: 'occ1' }, on('GET', 'me/events/occ1', OCCURRENCE));
    expect(text).toContain('needs an explicit scope');
    expect(of(method)).toHaveLength(0);
  });

  test('delete-event targets the master for scope series', async () => {
    const { of, text } = await call(
      'delete-event',
      { eventId: 'occ1', scope: 'series' },
      on('GET', 'me/events/occ1', OCCURRENCE),
    );
    expect(of('DELETE')[0]?.path).toBe('me/events/master1');
    expect(text).toContain('every other occurrence in its series have been deleted');
  });

  test('delete-event targets the occurrence for scope this', async () => {
    const { of, text } = await call(
      'delete-event',
      { eventId: 'occ1', scope: 'this' },
      on('GET', 'me/events/occ1', OCCURRENCE),
    );
    expect(of('DELETE')[0]?.path).toBe('me/events/occ1');
    expect(text).toContain('that date only');
  });

  test('a one-off delete needs no scope', async () => {
    const { of, text } = await call(
      'delete-event',
      { eventId: 'evt1' },
      on('GET', 'me/events/evt1', SINGLE),
    );
    expect(of('DELETE')).toHaveLength(1);
    expect(text).toBe('"Lunch" has been deleted.');
  });

  test('cancel-event posts a comment and says attendees were notified', async () => {
    const { of, text } = await call(
      'cancel-event',
      { eventId: 'evt1', comment: 'Room flooded' },
      on('GET', 'me/events/evt1', SINGLE),
    );
    expect(of('POST')[0]?.path).toBe('me/events/evt1/cancel');
    expect(of('POST')[0]?.body).toEqual({ comment: 'Room flooded' });
    expect(text).toContain('Attendees have been notified');
  });

  test('a series master with scope "this" is refused', async () => {
    const master = { id: 'master1', subject: 'Weekly standup', type: 'seriesMaster' };
    const { text, of } = await call(
      'delete-event',
      { eventId: 'master1', scope: 'this' },
      on('GET', 'me/events/master1', master),
    );
    expect(text).toContain('does not identify a single occurrence');
    expect(of('DELETE')).toHaveLength(0);
  });

  test('an unrecognised scope is refused before anything is read', async () => {
    const { text, calls } = await call('delete-event', { eventId: 'occ1', scope: 'maybe' });
    expect(text).toContain('Unrecognised scope');
    expect(calls).toHaveLength(0);
  });
});

describe('accept-event and decline-event', () => {
  test.each(['accept', 'decline'] as const)('%s posts to the right action', async (label) => {
    const { of, text } = await call(`${label}-event`, { eventId: 'evt1', comment: 'ok' });
    const action = label === 'accept' ? 'accept' : 'decline';
    expect(of('POST')[0]?.path).toBe(`me/events/evt1/${action}`);
    expect(of('POST')[0]?.body).toMatchObject({ comment: 'ok', sendResponse: true });
    expect(text).toContain('organiser has been notified');
    // Proper past tense — "accepted", not "acceptd" — while the structured
    // response keeps the label verbatim.
    expect(text).toContain(`Invitation ${label === 'accept' ? 'accepted' : 'declined'}.`);
  });
});

describe('the tool set', () => {
  test('every tool declares scopes, schemas and a renderer', () => {
    for (const definition of calendarTools) {
      expect(definition.scopes.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(20);
      expect(typeof definition.render).toBe('function');
      expect(definition.output).toBeTruthy();
    }
  });

  test('destructive tools are annotated as such', () => {
    for (const name of ['delete-event', 'cancel-event']) {
      expect(tool(name).annotations?.destructiveHint).toBe(true);
    }
    expect(tool('list-events').annotations?.readOnlyHint).toBe(true);
  });

  test('delete-event does not claim idempotence — a repeated delete 404s', () => {
    expect(tool('delete-event').annotations?.idempotentHint).toBeUndefined();
  });
});
