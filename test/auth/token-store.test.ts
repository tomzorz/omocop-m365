import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import {
  AuthenticationRequiredError,
  scopesFromJwt,
  TokenStore,
  type StoredTokens,
} from '../../src/auth/token-store.js';

const silent = createLogger('error', () => {});

let dir: string;
let config: Config;
let clock = 1_000_000_000_000;
const now = () => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omocop-tokens-'));
  clock = 1_000_000_000_000;
  config = loadConfig({
    M365_CLIENT_ID: 'cid',
    M365_CLIENT_SECRET: 'secret',
    M365_TOKEN_STORE: join(dir, 'tokens.json'),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validTokens = (over: Partial<StoredTokens> = {}): StoredTokens => ({
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: clock + 3600_000,
  scopes: ['Mail.ReadWrite', 'Calendars.ReadWrite'],
  ...over,
});

/** A token endpoint returning a queue of responses, counting calls. */
function tokenEndpoint(responses: Array<{ status?: number; body: unknown }>) {
  let i = 0;
  const impl = (async () => {
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = spec?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec?.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => i };
}

describe('loading', () => {
  test('is unauthenticated when the file is absent', async () => {
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    expect(await store.isAuthenticated()).toBe(false);
    await expect(store.getAccessToken()).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  test('is unauthenticated when the file is corrupt, without throwing', async () => {
    await writeFile(config.tokenStorePath, 'not json');
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    expect(await store.isAuthenticated()).toBe(false);
  });

  test('is unauthenticated when the file has no refresh token', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify({ accessToken: 'a' }));
    expect(await new TokenStore(config, silent, tokenEndpoint([]).impl, now).isAuthenticated())
      .toBe(false);
  });

  test('returns a valid cached token without contacting the endpoint', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens()));
    const endpoint = tokenEndpoint([]);
    const store = new TokenStore(config, silent, endpoint.impl, now);

    expect(await store.getAccessToken()).toBe('access-0');
    expect(endpoint.calls()).toBe(0);
  });
});

describe('persist', () => {
  test('writes the store and reads back identically', async () => {
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    const tokens = validTokens();
    await store.persist(tokens);

    const raw = JSON.parse(await readFile(config.tokenStorePath, 'utf8')) as StoredTokens;
    expect(raw).toEqual(tokens);
  });
});

describe('refresh', () => {
  test('exchanges the refresh token and stores the result', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens({ expiresAt: clock })));
    const endpoint = tokenEndpoint([
      {
        body: {
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: 'Mail.ReadWrite Calendars.ReadWrite',
        },
      },
    ]);

    const store = new TokenStore(config, silent, endpoint.impl, now);
    expect(await store.getAccessToken()).toBe('access-1');

    const stored = JSON.parse(await readFile(config.tokenStorePath, 'utf8')) as StoredTokens;
    expect(stored.refreshToken).toBe('refresh-1');
    expect(stored.expiresAt).toBe(clock + 3600_000);
  });

  test('refreshes ahead of expiry rather than waiting to be rejected', async () => {
    // Two minutes left — inside the five-minute skew.
    await writeFile(
      config.tokenStorePath,
      JSON.stringify(validTokens({ expiresAt: clock + 120_000 })),
    );
    const endpoint = tokenEndpoint([{ body: { access_token: 'access-1', expires_in: 3600 } }]);

    await new TokenStore(config, silent, endpoint.impl, now).getAccessToken();
    expect(endpoint.calls()).toBe(1);
  });

  test('keeps the existing refresh token when the response omits one', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens({ expiresAt: clock })));
    const endpoint = tokenEndpoint([{ body: { access_token: 'a1', expires_in: 60 } }]);

    const store = new TokenStore(config, silent, endpoint.impl, now);
    await store.refresh();

    const stored = JSON.parse(await readFile(config.tokenStorePath, 'utf8')) as StoredTokens;
    expect(stored.refreshToken).toBe('refresh-0');
  });

  /**
   * Two concurrent 401s must not start two exchanges: Entra invalidates the old
   * refresh token when it issues a new one, so the loser of the race can leave a
   * dead credential on disk.
   */
  test('collapses concurrent refreshes onto one request', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens({ expiresAt: clock })));
    const endpoint = tokenEndpoint([
      { body: { access_token: 'shared', refresh_token: 'r1', expires_in: 3600 } },
    ]);

    const store = new TokenStore(config, silent, endpoint.impl, now);
    const results = await Promise.all([
      store.refresh(),
      store.refresh(),
      store.refresh(),
      store.getAccessToken(),
    ]);

    expect(endpoint.calls()).toBe(1);
    expect(new Set(results)).toEqual(new Set(['shared']));
  });

  test('allows a fresh refresh after the previous one settles', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens({ expiresAt: clock })));
    const endpoint = tokenEndpoint([
      { body: { access_token: 'a1', expires_in: 3600 } },
      { body: { access_token: 'a2', expires_in: 3600 } },
    ]);

    const store = new TokenStore(config, silent, endpoint.impl, now);
    expect(await store.refresh()).toBe('a1');
    expect(await store.refresh()).toBe('a2');
    expect(endpoint.calls()).toBe(2);
  });

  test('a revoked grant is an authentication error, not a retryable one', async () => {
    await writeFile(config.tokenStorePath, JSON.stringify(validTokens({ expiresAt: clock })));
    const endpoint = tokenEndpoint([
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'AADSTS70000: expired' },
      },
    ]);

    const store = new TokenStore(config, silent, endpoint.impl, now);
    await expect(store.refresh()).rejects.toBeInstanceOf(AuthenticationRequiredError);
    await expect(store.refresh()).rejects.toThrow(/invalid_grant/);
  });
});

describe('granted scopes', () => {
  test('come from the token response, because asking is not being granted', async () => {
    await writeFile(
      config.tokenStorePath,
      JSON.stringify(validTokens({ scopes: ['Mail.Read'] })),
    );
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    expect(await store.grantedScopes()).toEqual(['Mail.Read']);
  });

  test('prefer the access token scp claim when the token is a readable JWT', async () => {
    const payload = Buffer.from(JSON.stringify({ scp: 'Calendars.ReadWrite User.Read' }))
      .toString('base64url');
    const jwt = `header.${payload}.signature`;

    await writeFile(
      config.tokenStorePath,
      JSON.stringify(validTokens({ accessToken: jwt, scopes: ['stale'] })),
    );
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    expect(await store.grantedScopes()).toEqual(['Calendars.ReadWrite', 'User.Read']);
  });

  test('undefined when unauthenticated', async () => {
    const store = new TokenStore(config, silent, tokenEndpoint([]).impl, now);
    expect(await store.grantedScopes()).toBeUndefined();
  });
});

describe('scopesFromJwt', () => {
  test('reads scp', () => {
    const payload = Buffer.from(JSON.stringify({ scp: 'A B' })).toString('base64url');
    expect(scopesFromJwt(`h.${payload}.s`)).toEqual(['A', 'B']);
  });

  test('returns undefined for an opaque token, which personal accounts can receive', () => {
    expect(scopesFromJwt('opaque-token-value')).toBeUndefined();
    expect(scopesFromJwt('a.b.c')).toBeUndefined();
  });
});
