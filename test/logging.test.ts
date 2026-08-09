import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  STDOUT_CONSOLE_METHODS,
  createLogger,
  installStdoutGuard,
  redact,
} from '../src/logging.js';

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

});

describe('LOG_LEVEL default', () => {
  // The default level comes from the ambient environment, so it is pinned and
  // restored explicitly — otherwise this suite would pass or fail depending on
  // what the host machine happens to export.
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['LOG_LEVEL'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = saved;
  });

  test('defaults to info when LOG_LEVEL is absent', () => {
    delete process.env['LOG_LEVEL'];
    expect(createLogger(undefined as never, () => {}).level).toBe('info');
  });

  test('falls back to info when LOG_LEVEL is nonsense', () => {
    process.env['LOG_LEVEL'] = 'shouty';
    expect(createLogger(undefined as never, () => {}).level).toBe('info');
  });

  test('honours a valid LOG_LEVEL, however cased', () => {
    process.env['LOG_LEVEL'] = ' DEBUG ';
    expect(createLogger(undefined as never, () => {}).level).toBe('debug');
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

  test('every listed method reaches stderr and never stdout once guarded', () => {
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    // The logger is built with the default sink so the probe exercises the real
    // path to stderr, not an injected capture.
    const restore = installStdoutGuard(createLogger('debug'));
    try {
      for (const method of STDOUT_CONSOLE_METHODS) {
        stdoutWrites.length = 0;
        stderrWrites.length = 0;
        (console[method] as (...args: unknown[]) => void)(`probe via ${method}`);
        expect(stdoutWrites, `console.${method} leaked to stdout`).toEqual([]);
        expect(stderrWrites.join(''), `console.${method} produced no stderr`).toContain(method);
      }
    } finally {
      restore();
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  });

  test('leaves console.error alone — stderr is already correct', () => {
    const { sink } = capture();
    const original = console.error;
    const restore = installStdoutGuard(createLogger('debug', sink));
    expect(console.error).toBe(original);
    restore();
  });
});
