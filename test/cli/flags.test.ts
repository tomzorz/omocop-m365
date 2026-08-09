import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { flagSpecs, kebabCase, parseFlags, validateInput } from '../../src/cli/flags.js';
import { toolGroups } from '../../src/tools/all.js';

/** A shape exercising every field kind the real tools use. */
const SHAPE = {
  messageId: z.string().describe('Message id'),
  count: z.number().int().min(1).max(50).optional().describe('Default 10'),
  unreadOnly: z.boolean().optional(),
  attendees: z.array(z.string()).optional().describe('Email addresses to invite'),
  scope: z.enum(['this', 'series']).optional(),
  folder: z.string().describe('Folder name or path').optional(),
};

const SPECS = flagSpecs(SHAPE);

describe('kebabCase', () => {
  test.each([
    ['messageId', 'message-id'],
    ['unreadOnly', 'unread-only'],
    ['startDateTime', 'start-date-time'],
    ['saveToSentItems', 'save-to-sent-items'],
    ['id', 'id'],
    ['to', 'to'],
  ])('%s becomes --%s', (field, flag) => {
    expect(kebabCase(field)).toBe(flag);
  });
});

describe('flagSpecs', () => {
  const spec = (flag: string) => {
    const found = SPECS.find((s) => s.flag === flag);
    if (!found) throw new Error(`no spec for --${flag}`);
    return found;
  };

  test.each([
    ['message-id', 'string', true],
    ['count', 'number', false],
    ['unread-only', 'boolean', false],
    ['attendees', 'array', false],
    ['scope', 'string', false],
  ] as const)('--%s is a %s flag (required: %s)', (flag, kind, required) => {
    expect(spec(flag).kind).toBe(kind);
    expect(spec(flag).required).toBe(required);
  });

  test('enum choices are surfaced for help', () => {
    expect(spec('scope').choices).toEqual(['this', 'series']);
  });

  test('describe text survives an .optional() wrapped around it', () => {
    expect(spec('folder').description).toBe('Folder name or path');
  });

  test('describe text on the optional wrapper itself is found', () => {
    expect(spec('count').description).toBe('Default 10');
  });

  test('no real tool declares a `format` field, which the CLI reserves', () => {
    for (const group of toolGroups({} as never)) {
      for (const tool of group.tools) {
        expect('format' in tool.input, tool.name).toBe(false);
      }
    }
  });

  test('every real tool field maps to a distinct kebab-case flag', () => {
    for (const group of toolGroups({} as never)) {
      for (const tool of group.tools) {
        const flags = flagSpecs(tool.input).map((s) => s.flag);
        expect(new Set(flags).size, tool.name).toBe(flags.length);
        for (const flag of flags) expect(flag).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });
});

describe('parseFlags', () => {
  test.each([
    ['space-separated value', ['--message-id', 'abc'], { messageId: 'abc' }],
    ['inline =value', ['--message-id=abc'], { messageId: 'abc' }],
    ['number coercion', ['--count', '5'], { count: 5 }],
    ['bare boolean is true', ['--unread-only'], { unreadOnly: true }],
    ['=true', ['--unread-only=true'], { unreadOnly: true }],
    ['=false', ['--unread-only=false'], { unreadOnly: false }],
    [
      'repeated array flags accumulate, commas intact',
      ['--attendees', 'Doe, Jane <jane@example.test>', '--attendees', 'bob@example.test'],
      { attendees: ['Doe, Jane <jane@example.test>', 'bob@example.test'] },
    ],
    ['enum value passes through as a string', ['--scope', 'series'], { scope: 'series' }],
  ])('%s', (_name, argv, input) => {
    const parsed = parseFlags(SPECS, argv);
    expect(parsed).toEqual({ ok: true, input, format: 'json' });
  });

  test('the format flag is extracted, defaulting to json', () => {
    expect(parseFlags(SPECS, [])).toEqual({ ok: true, input: {}, format: 'json' });
    const parsed = parseFlags(SPECS, ['--message-id', 'x', '--format', 'md']);
    expect(parsed).toEqual({ ok: true, input: { messageId: 'x' }, format: 'md' });
    expect(parseFlags(SPECS, ['--format=text'])).toEqual({ ok: true, input: {}, format: 'text' });
  });

  test.each([
    ['unknown flag', ['--bogus', 'x'], /Unknown flag --bogus/],
    ['unexpected positional', ['stray'], /Unexpected argument "stray"/],
    ['boolean with a junk value', ['--unread-only=maybe'], /--unread-only is a boolean/],
    ['boolean never consumes the next token', ['--unread-only', 'false'], /Unexpected argument "false"/],
    ['missing value at the end', ['--message-id'], /--message-id requires a value/],
    ['scalar flag repeated', ['--message-id', 'a', '--message-id', 'b'], /more than once/],
    ['bad format value', ['--format', 'yaml'], /--format must be one of json, text, md/],
  ])('%s is rejected', (_name, argv, message) => {
    const parsed = parseFlags(SPECS, argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join('\n')).toMatch(message);
  });
});

describe('validateInput', () => {
  test('missing required field is reported against the flag name', () => {
    const outcome = validateInput(SHAPE, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors.join('\n')).toMatch(/--message-id: Required/);
  });

  test('range violations come from the tool\'s own schema', () => {
    const outcome = validateInput(SHAPE, { messageId: 'x', count: 0 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors.join('\n')).toContain('--count');
  });

  test('a NaN from a non-numeric value is rejected as not a number', () => {
    const outcome = validateInput(SHAPE, { messageId: 'x', count: Number('abc') });
    expect(outcome.ok).toBe(false);
  });

  test('valid input passes through parsed', () => {
    const outcome = validateInput(SHAPE, { messageId: 'x', count: 5, unreadOnly: true });
    expect(outcome).toEqual({ ok: true, args: { messageId: 'x', count: 5, unreadOnly: true } });
  });
});
