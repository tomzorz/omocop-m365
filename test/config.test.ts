import { describe, expect, test } from 'vitest';
import { ConfigError, DEFAULT_SCOPES, loadConfig } from '../src/config.js';

const MINIMAL = { M365_CLIENT_ID: 'cid', M365_CLIENT_SECRET: 'secret' };

describe('required settings', () => {
  test('loads with only id and secret', () => {
    const config = loadConfig(MINIMAL);
    expect(config.clientId).toBe('cid');
    expect(config.clientSecret).toBe('secret');
  });

  test('names every missing setting, and explains why .env is not read', () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as Error).message;
    expect(message).toContain('M365_CLIENT_ID');
    expect(message).toContain('M365_CLIENT_SECRET');
    expect(message).toContain('does not read .env');
  });

  test('treats whitespace-only as absent', () => {
    expect(() => loadConfig({ M365_CLIENT_ID: '   ', M365_CLIENT_SECRET: 's' }))
      .toThrow(ConfigError);
  });

  test('trims surrounding whitespace', () => {
    expect(loadConfig({ M365_CLIENT_ID: '  cid  ', M365_CLIENT_SECRET: 's' }).clientId)
      .toBe('cid');
  });
});

describe('scopes', () => {
  test('defaults to the shipped set', () => {
    expect(loadConfig(MINIMAL).scopes).toEqual([...DEFAULT_SCOPES]);
  });

  test('accepts an override split on spaces or commas', () => {
    expect(loadConfig({ ...MINIMAL, M365_SCOPES: 'A B,C   D' }).scopes)
      .toEqual(['A', 'B', 'C', 'D']);
  });

  test('an empty override falls back to the defaults', () => {
    expect(loadConfig({ ...MINIMAL, M365_SCOPES: '   ' }).scopes).toEqual([...DEFAULT_SCOPES]);
  });
});

describe('authority', () => {
  test('uses the common endpoint when no tenant is given', () => {
    expect(loadConfig(MINIMAL).authority).toBe('https://login.microsoftonline.com/common');
  });

  test('uses the tenant when one is given', () => {
    expect(loadConfig({ ...MINIMAL, M365_TENANT_ID: 'abc-def' }).authority)
      .toBe('https://login.microsoftonline.com/abc-def');
  });

  test('treats a blank tenant as personal', () => {
    expect(loadConfig({ ...MINIMAL, M365_TENANT_ID: '  ' }).authority)
      .toBe('https://login.microsoftonline.com/common');
  });
});

describe('other settings', () => {
  test('defaults the timezone to UTC rather than guessing the host', () => {
    expect(loadConfig(MINIMAL).timezone).toBe('UTC');
  });

  test('accepts a Windows timezone name', () => {
    expect(loadConfig({ ...MINIMAL, M365_TIMEZONE: 'W. Europe Standard Time' }).timezone)
      .toBe('W. Europe Standard Time');
  });

  test('token store defaults under the home directory', () => {
    expect(loadConfig(MINIMAL).tokenStorePath).toContain('.omocop-m365-tokens.json');
  });

  test('token store can be overridden', () => {
    expect(loadConfig({ ...MINIMAL, M365_TOKEN_STORE: '/tmp/t.json' }).tokenStorePath)
      .toBe('/tmp/t.json');
  });

  test('redirect uri follows the auth port', () => {
    const config = loadConfig({ ...MINIMAL, M365_AUTH_PORT: '4444' });
    expect(config.authPort).toBe(4444);
    expect(config.redirectUri).toBe('http://localhost:4444/auth/callback');
  });

  test('rejects a nonsense port', () => {
    expect(() => loadConfig({ ...MINIMAL, M365_AUTH_PORT: 'banana' })).toThrow(/port number/);
    expect(() => loadConfig({ ...MINIMAL, M365_AUTH_PORT: '70000' })).toThrow(/port number/);
    expect(() => loadConfig({ ...MINIMAL, M365_AUTH_PORT: '0' })).toThrow(/port number/);
  });

  test.each(['1', 'true', 'YES', 'on'])('hideUngrantedTools accepts %s', (value) => {
    expect(loadConfig({ ...MINIMAL, M365_HIDE_UNGRANTED_TOOLS: value }).hideUngrantedTools)
      .toBe(true);
  });

  test('hideUngrantedTools defaults off', () => {
    expect(loadConfig(MINIMAL).hideUngrantedTools).toBe(false);
  });

  test('falls back to info for an unknown log level', () => {
    expect(loadConfig({ ...MINIMAL, LOG_LEVEL: 'shouty' }).logLevel).toBe('info');
    expect(loadConfig({ ...MINIMAL, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });
});
