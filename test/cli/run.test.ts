import { describe, expect, test } from 'vitest';
import { runCli, type CliDeps } from '../../src/cli/run.js';
import { toolGroups } from '../../src/tools/all.js';
import { runTool } from '../../src/server/tool.js';
import { ALL_SCOPES, fakeGraph, on, testContext } from '../support/fake-graph.js';

/**
 * runCli with real tool definitions, the shared harness, and a fake Graph —
 * the whole pipeline minus the process boundary.
 */
function harness(...responders: Parameters<typeof fakeGraph>) {
  const fake = fakeGraph(...responders);
  const out: string[] = [];
  const err: string[] = [];

  const deps: CliDeps = {
    groups: toolGroups({} as never),
    execute: (definition, args) =>
      runTool(definition, args as never, testContext(fake.graph), ALL_SCOPES),
    stdout: (chunk) => void out.push(chunk),
    stderr: (chunk) => void err.push(chunk),
  };

  return { deps, fake, stdout: () => out.join(''), stderr: () => err.join('') };
}

const FOLDER_TREE = on('COLLECT', 'me/mailFolders', {
  items: [{ id: 'f1', displayName: 'Inbox', childFolderCount: 0 }],
  truncated: false,
});

const ONE_MESSAGE = on('COLLECT', 'messages', {
  items: [
    {
      id: 'm1',
      subject: 'Quarterly report',
      from: { emailAddress: { name: 'Ann', address: 'ann@example.test' } },
      receivedDateTime: '2026-08-01T09:30:00Z',
      bodyPreview: 'Attached.',
      isRead: false,
      hasAttachments: true,
    },
  ],
  truncated: false,
});

describe('success paths', () => {
  test('json is the default and stdout carries nothing but the JSON', async () => {
    const { deps, stdout, stderr } = harness(FOLDER_TREE);
    const code = await runCli(['list-folders'], deps);

    expect(code).toBe(0);
    expect(stderr()).toBe('');
    const expected = { folders: [{ id: 'f1', name: 'Inbox', path: 'Inbox', depth: 0 }] };
    expect(stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  test('--format text prints the rendered text', async () => {
    const { deps, stdout } = harness(FOLDER_TREE);
    const code = await runCli(['list-folders', '--format', 'text'], deps);

    expect(code).toBe(0);
    expect(stdout()).toContain('1 folder(s):');
    expect(stdout()).toContain('- Inbox');
  });

  test('--format md renders a table for a listing tool, end to end', async () => {
    const { deps, stdout } = harness(ONE_MESSAGE);
    const code = await runCli(['list-emails', '--format', 'md', '--count', '5'], deps);

    expect(code).toBe(0);
    expect(stdout()).toContain('| Subject | From | Received | Unread | Attachments | ID |');
    expect(stdout()).toContain('| Quarterly report | Ann <ann@example.test> | 2026-08-01 09:30 | yes | yes | m1 |');
  });

  test('--format md falls back to rendered text for a non-listing tool', async () => {
    const { deps, stdout } = harness(
      on('GET', 'messages/m1', {
        id: 'm1',
        subject: 'Hello',
        from: { emailAddress: { address: 'ann@example.test' } },
        body: { contentType: 'text', content: 'Hi there.' },
        receivedDateTime: '2026-08-01T09:30:00Z',
      }),
    );
    const code = await runCli(['read-email', '--id', 'm1', '--format', 'md'], deps);

    expect(code).toBe(0);
    expect(stdout()).toContain('Subject: Hello');
    expect(stdout()).not.toContain('| Subject |');
  });
});

describe('failure paths', () => {
  test('a tool error goes to stderr only and exits 1', async () => {
    const { deps, stdout, stderr } = harness((call) => {
      if (call.method === 'GET') throw new Error('boom');
      return undefined;
    });
    const code = await runCli(['read-email', '--id', 'm1'], deps);

    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('boom');
  });

  test('a policy refusal goes to stderr only and exits 1', async () => {
    const { deps, fake, stdout, stderr } = harness(FOLDER_TREE);
    const code = await runCli(
      ['move-emails', '--message-ids', 'm1', '--destination-folder', 'Nowhere'],
      deps,
    );

    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('No folder matching');
    expect(fake.of('POST')).toHaveLength(0);
  });

  test('a throw from execute (missing configuration) exits 1', async () => {
    const { deps, stderr } = harness();
    const broken: CliDeps = {
      ...deps,
      execute: () => Promise.reject(new Error('Missing required configuration: M365_CLIENT_ID.')),
    };
    const code = await runCli(['list-folders'], broken);

    expect(code).toBe(1);
    expect(stderr()).toContain('M365_CLIENT_ID');
  });
});

describe('usage errors', () => {
  test('no subcommand prints usage to stderr and exits 2', async () => {
    const { deps, stdout, stderr } = harness();
    expect(await runCli([], deps)).toBe(2);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('Usage:');
  });

  test('an unknown subcommand exits 2', async () => {
    const { deps, stdout, stderr } = harness();
    expect(await runCli(['frobnicate'], deps)).toBe(2);
    expect(stdout()).toBe('');
    expect(stderr()).toContain('frobnicate');
  });

  test('the authenticate tool is not a subcommand', async () => {
    const { deps, stderr } = harness();
    expect(await runCli(['authenticate'], deps)).toBe(2);
    expect(stderr()).toContain('Unknown subcommand');
  });

  test('an unknown flag exits 2 before anything runs', async () => {
    const { deps, fake } = harness(FOLDER_TREE);
    expect(await runCli(['list-folders', '--bogus', 'x'], deps)).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  test('validation failure lists each issue against its flag and exits 2', async () => {
    const { deps, fake, stderr } = harness();
    const code = await runCli(['read-email'], deps);

    expect(code).toBe(2);
    expect(stderr()).toContain('--id: Required');
    expect(fake.calls).toHaveLength(0);
  });

  test('an out-of-range value is judged by the tool\'s own schema', async () => {
    const { deps, stderr } = harness();
    expect(await runCli(['list-emails', '--count', '999'], deps)).toBe(2);
    expect(stderr()).toContain('--count');
  });
});

describe('help', () => {
  test('--help lists subcommands grouped by area, auth included, authenticate hidden', async () => {
    const { deps, stdout } = harness();
    expect(await runCli(['--help'], deps)).toBe(0);

    const help = stdout();
    for (const area of ['Authentication:', 'Calendar:', 'Email:', 'Attachments:', 'Folders:']) {
      expect(help).toContain(area);
    }
    for (const name of ['auth', 'check-auth-status', 'list-emails', 'move-emails']) {
      expect(help).toMatch(new RegExp(`^\\s{2}${name}\\b`, 'm'));
    }
    expect(help).not.toMatch(/^\s{2}authenticate\b/m);
  });

  test('subcommand --help lists flags with their describe texts', async () => {
    const { deps, stdout } = harness();
    expect(await runCli(['list-emails', '--help'], deps)).toBe(0);

    const help = stdout();
    expect(help).toContain('--folder');
    expect(help).toContain('--unread-only');
    expect(help).toContain('Default 10');
    expect(help).toContain('--format');
  });

  test('help for a tool with required and repeatable flags marks them', async () => {
    const { deps, stdout } = harness();
    expect(await runCli(['move-emails', '--help'], deps)).toBe(0);

    const help = stdout();
    expect(help).toMatch(/--message-ids.*repeatable/);
    expect(help).toMatch(/--destination-folder.*required/);
  });
});
