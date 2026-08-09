#!/usr/bin/env node
/**
 * Starts the built server, speaks MCP to it over stdio, and checks the two
 * things unit tests cannot:
 *
 *   1. It actually boots and completes a handshake.
 *   2. **stdout carries nothing but JSON-RPC frames.** A stray write there breaks
 *      the transport, and the failure never points at whatever wrote it — so this
 *      is checked against a real process rather than assumed.
 *
 * Needs no credentials: it never reaches Graph.
 */
import { spawn } from 'node:child_process';

const TIMEOUT_MS = 10_000;

const child = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    M365_CLIENT_ID: 'smoke-test',
    M365_CLIENT_SECRET: 'smoke-test',
    M365_TOKEN_STORE: 'smoke-test-nonexistent.json',
    LOG_LEVEL: 'info',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => (stdout += chunk));
child.stderr.on('data', (chunk) => (stderr += chunk));

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  },
});

setTimeout(() => {
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
}, 400);

const failures = [];
const check = (ok, description) => {
  if (!ok) failures.push(description);
  process.stderr.write(`${ok ? 'ok  ' : 'FAIL'}  ${description}\n`);
};

/**
 * Spawns the built CLI once. The CLI checks below prove what unit tests cannot:
 * the bin actually dispatches, exits with the promised codes, and keeps its
 * stdout/stderr split when run as a real process.
 */
const runCliOnce = (args) =>
  new Promise((resolve) => {
    const cli = spawn(process.execPath, ['dist/cli/index.js', ...args], {
      env: {
        ...process.env,
        M365_CLIENT_ID: 'smoke-test',
        M365_TOKEN_STORE: 'smoke-test-nonexistent.json',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    cli.stdout.on('data', (chunk) => (out += chunk));
    cli.stderr.on('data', (chunk) => (err += chunk));
    cli.on('close', (code) => resolve({ code, out, err }));
  });

async function cliChecks() {
  const help = await runCliOnce(['--help']);
  check(help.code === 0, 'cli --help exits 0');
  for (const name of ['auth', 'check-auth-status', 'list-emails', 'list-events']) {
    check(help.out.includes(name), `cli --help lists ${name}`);
  }
  check(!/^\s{2}authenticate\b/m.test(help.out), 'cli --help hides the authenticate tool');

  const unknown = await runCliOnce(['frobnicate']);
  check(unknown.code === 2, 'cli unknown subcommand exits 2');
  check(unknown.err.includes('frobnicate'), 'cli unknown subcommand names itself on stderr');
  check(unknown.out === '', 'cli unknown subcommand writes nothing to stdout');
}

setTimeout(async () => {
  child.kill();

  const lines = stdout.trim().split('\n').filter(Boolean);
  const parsed = [];
  let unparseable = 0;

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      unparseable += 1;
      process.stderr.write(`  stray stdout line: ${line.slice(0, 120)}\n`);
    }
  }

  check(unparseable === 0, 'stdout contains only parseable JSON');
  check(
    parsed.every((message) => message.jsonrpc === '2.0'),
    'every stdout line is a JSON-RPC frame',
  );

  const initialize = parsed.find((message) => message.id === 1);
  check(initialize?.result?.serverInfo?.name === 'omocop-m365', 'handshake names the server');

  const list = parsed.find((message) => message.id === 2);
  const toolList = list?.result?.tools ?? [];
  check(toolList.length > 0, `tools/list returned tools (${toolList.length})`);
  check(
    toolList.every((tool) => tool.inputSchema && tool.outputSchema),
    'every tool advertises both schemas',
  );
  check(
    toolList.every((tool) => typeof tool.description === 'string' && tool.description.length > 40),
    'every tool advertises a description',
  );
  check(stderr.includes('ready with'), 'startup was logged to stderr');

  await cliChecks();

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write('\nsmoke test passed\n');
  }
}, 1500);

setTimeout(() => {
  child.kill();
  process.stderr.write('smoke test timed out\n');
  process.exitCode = 1;
}, TIMEOUT_MS).unref();
