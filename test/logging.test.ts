import { describe, expect, test } from 'vitest';
import { createLogger, installStdoutGuard, redact } from '../src/logging.js';

/** Collects log output instead of writing it anywhere. */
function capture() {
  const lines: string[] = [];
  return { lines, sink: (chunk: string) => void lines.push(chunk) };
}

describe('redact', () => {
  test('strips a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    expect(redact(`token is ${jwt}`)).not.toContain(jwt);
    expect(redact(`token is ${jwt}`)).toContain('<jwt:redacted>');
  });

  test('strips a bearer header', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'))
      .toBe('Authorization: Bearer <redacted>');
  });

  test('strips a labelled secret in JSON and in key=value form', () => {
    const fake = 'EXAMPLE~notarealsecret~000000';
    expect(redact(`{"client_secret":"${fake}"}`)).not.toContain(fake);
    expect(redact(`M365_CLIENT_SECRET=${fake}`)).not.toContain(fake);
    expect(redact(`refresh_token: ${fake}`)).not.toContain(fake);
  });

  test('leaves ordinary text alone', () => {
    const text = 'Found 3 events in 2026-08-05 to 2026-08-06 UTC';
    expect(redact(text)).toBe(text);
  });
});

describe('createLogger', () => {
  test('writes to the sink, never to stdout', () => {
    const { lines, sink } = capture();
    createLogger('info', sink).info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[omocop-m365] info: hello');
  });

  test('honours the level threshold', () => {
    const { lines, sink } = capture();
    const log = createLogger('warn', sink);
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(lines.map((l) => l.split(':')[0])).toEqual(['[omocop-m365] error', '[omocop-m365] warn']);
  });

  test('redacts on the way out, so a caller cannot leak by forgetting', () => {
    const { lines, sink } = capture();
    createLogger('debug', sink).debug('refreshing with', { refresh_token: 'AwABAAAAvPM1KaPl' });
    expect(lines[0]).not.toContain('AwABAAAAvPM1KaPl');
    expect(lines[0]).toContain('<redacted>');
  });

  test('formats errors with their stack', () => {
    const { lines, sink } = capture();
    createLogger('error', sink).error(new Error('boom'));
    expect(lines[0]).toContain('boom');
  });

  test('defaults to info when LOG_LEVEL is absent or nonsense', () => {
    expect(createLogger(undefined as never, () => {}).level).toBe('info');
  });
});

describe('installStdoutGuard', () => {
  test('redirects console.log away from stdout and restores it', () => {
    const { lines, sink } = capture();
    const original = console.log;

    const restore = installStdoutGuard(createLogger('debug', sink));
    expect(console.log).not.toBe(original);

    console.log('a dependency did this');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('console.log redirected');
    expect(lines[0]).toContain('a dependency did this');

    restore();
    expect(console.log).toBe(original);
  });

  test('covers every console method that writes to stdout', () => {
    const { sink } = capture();
    const restore = installStdoutGuard(createLogger('debug', sink));
    for (const method of ['log', 'info', 'debug', 'dir', 'table', 'trace'] as const) {
      expect(typeof console[method]).toBe('function');
    }
    restore();
  });

  test('leaves console.error alone — stderr is already correct', () => {
    const { sink } = capture();
    const original = console.error;
    const restore = installStdoutGuard(createLogger('debug', sink));
    expect(console.error).toBe(original);
    restore();
  });
});
