---
name: outlook-calendar
description: |
  Read and write the user's Outlook calendars with the omocop-m365 CLI. Use whenever the user asks what is on their calendar, what they have on a given day or date range, whether they are free, or asks to add, move, edit, reschedule, invite someone to, cancel, or delete an event. Reading merges the personal and managed calendars; writing always targets the managed calendar. Also use when a question depends on the user's schedule even if the calendar is not mentioned explicitly.
license: MIT
---

# Outlook Calendar

## Configuration

This file is generated: the values below were substituted by `install-skills` from `skills.config.local.json`. Before substitution this table is the checklist of what the setup needs; after it, the record of what this installation uses.

| Setting | Value |
|---|---|
| User | {{USER_NAME}} |
| MCP server registration key (fallback) | `{{MCP_SERVER_NAME}}` |
| Personal calendar (shared inward, read-only) | `{{PERSONAL_CALENDAR}}` |
| Managed calendar (writable) | `{{MANAGED_CALENDAR}}` |

You read from and write to {{USER_NAME}}'s Outlook calendars with the `omocop-m365` CLI. This skill exists because the default calendar of the signed-in agent account is empty and irrelevant: the real events live in two other calendars, and the tools only look at the default calendar unless told otherwise.

## Calling it

`omocop-m365 <subcommand> --flag value`, from the shell. Every subcommand has `--help`, which lists its flags with their descriptions; read that rather than guessing a flag. `--format text` gives the readable summary, the default JSON is for when you need ids or want to parse. Exit code 0 means it worked; on 1 or 2 the reason is on stderr.

If `omocop-m365` is not on the PATH but the `{{MCP_SERVER_NAME}}` MCP server is connected, the same tools exist there under the same names, with camelCase fields (`--start-date-time` is `startDateTime`). Everything below applies unchanged.

## The calendars

| Calendar | Role | Writable |
|---|---|---|
| `{{PERSONAL_CALENDAR}}` | Personal events. The bulk of the schedule. | **No**, read-only |
| `{{MANAGED_CALENDAR}}` | Where you create events. | Yes |
| `Calendar` | Default calendar of the signed-in agent account. Empty. | Yes |

Never pass a calendar id. Pass the name; the tools resolve names, and partial names work as long as they are unambiguous.

## Reading

Always read both target calendars and merge. One call each:

```bash
omocop-m365 list-events --calendar "{{PERSONAL_CALENDAR}}" --start-date-time <ISO> --end-date-time <ISO> --count 50 --format text
omocop-m365 list-events --calendar "{{MANAGED_CALENDAR}}" --start-date-time <ISO> --end-date-time <ISO> --count 50 --format text
```

Then merge the two result sets and sort by start time before presenting anything. Each event carries the calendar it came from. Keep that attribution when it matters (for example, nothing from `{{PERSONAL_CALENDAR}}` can be edited from here), but do not clutter a simple agenda with it.

Rules:

- Pass an explicit date range. The tool defaults to *now → +30 days* and states the window it used in its output; read that line back before trusting a result that looks thin.
- Recurring events are expanded into individual instances, so a weekly meeting correctly appears once per week in the range. Each one is marked as recurring, and editing those needs a scope, see below.
- Past ranges work fine.

If a result seems to be missing something, check `--calendar all`, which adds the default `Calendar`. Meeting invitations sent to the agent account land there rather than in either target calendar.

## Writing

All writes go to `{{MANAGED_CALENDAR}}`:

```bash
omocop-m365 create-event --calendar "{{MANAGED_CALENDAR}}" --subject <text> --start <ISO> --end <ISO> --location <text> --body <text>
```

`--location` and `--body` are optional. If the user gives a place (a room, an address, a venue, a meeting link), put it in `--location`, not in `--body`.

Times are handled by the tool: a naive `2026-08-15T14:00:00` means 2pm in the configured timezone, and a `Z` or `+02:00` timestamp is honoured as that exact instant. Either form is safe. The output states the time and zone it actually scheduled; check that line, it is the cheapest way to catch a misread request.

If the user states a time in another zone ("3pm Eastern", "10am Tokyo time"), pass that zone as `--time-zone` and keep the time naive, rather than converting the time yourself.

For day-scoped entries (birthdays, holidays, travel days, "block Friday"), use `--all-day` with date-only values; the end date is inclusive. An all-day event blocks the whole day as busy unless `--show-as free` is passed, and for birthday-style entries free is almost always what is meant. Block the day as busy only when the user wants the day actually reserved.

Before creating an event, read the same window first and mention any overlap. Do not refuse to double-book, just say what it collides with.

`{{PERSONAL_CALENDAR}}` is read-only. Any attempt to create there fails with a read-only message. If {{USER_NAME}} asks to add something "to my calendar", use `{{MANAGED_CALENDAR}}` without asking. If they explicitly name `{{PERSONAL_CALENDAR}}`, tell them it cannot be written to via this route.

## Modifying

```bash
omocop-m365 update-event --calendar "{{MANAGED_CALENDAR}}" --event-id <id> --start <ISO> --end <ISO> --scope this|series
```

The tool enforces its own mechanics: that only passed fields change, that `--attendees` replaces while `--add-attendees` merges, that a recurring event needs a scope. Read `update-event --help` rather than duplicating it here.

What is left to judgement:

- Say what a change will cost other people before making it. Outlook emails an updated invitation on any change to a meeting. For an event with guests, tell {{USER_NAME}} that first and make the change on their yes.
- Prefer `--add-attendees`/`--remove-attendees` over `--attendees`. Use the replacing form only when they really mean "the invitees should be exactly these", and name who is being dropped before doing it.
- `{{PERSONAL_CALENDAR}}` events are organised by {{USER_NAME}}'s real account, so updates there come back as a 403. That is expected, not a bug.

See the recurring events section below before editing anything that repeats.

## Deleting and responding

`delete-event`, `cancel-event`, `decline-event`, and `accept-event` all take `--event-id` plus the same `--calendar`. Pass the calendar the event actually lives in; omitting it targets the default calendar and the call fails to find the event.

Get ids from a `list-events` call; the JSON output has one per event, the text output ends each event with an `ID:` line.

- `delete-event` removes it outright, and if {{USER_NAME}} organises the meeting, Outlook sends the attendees a cancellation. `cancel-event` calls off a meeting {{USER_NAME}} organises with a message to the attendees. `accept-event` and `decline-event` tell the organiser.
- None of these is reversible from here, and each one can tell other people something. Confirm before any of them, quoting the event's subject and start time back to {{USER_NAME}}.

## Recurring events: ask first

`list-events` returns individual occurrences, never the series itself. An id from it names one instance, and the series it belongs to is a different object with a different id. So "delete the standup" has two possible meanings that look identical from the outside.

`update-event`, `delete-event`, and `cancel-event` enforce this themselves: on anything recurring, a call without `--scope` fails and changes nothing, and the refusal explains both options. So the mechanism does not need remembering; the judgement does.

If {{USER_NAME}} has not already said which they mean, ask. Do not pick a default, and do not infer one from how routine or how destructive the change looks; "it's only a delete of one thing" is exactly the assumption that wipes a year of standups.

If the original request already settled it ("move *just* tomorrow's standup", "cancel *all* of these", "shift the *whole series* an hour later"), pass the scope straight through and do not ask again.

For a `--scope series` delete or cancel, quote the recurrence back ("every Wednesday standup, all of them") rather than just the subject.

## Other subcommands

`list-calendars` shows all calendars with their names, owners, and whether each is writable. Use it if a calendar name fails to resolve, or if the setup appears to have changed from what this skill describes.

## Related

For mail see the `outlook-email` skill: same CLI, but a tighter boundary. The calendars reach into {{USER_NAME}}'s real tenant through the two doors above; mail crosses nothing.
