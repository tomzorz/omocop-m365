import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuthServer, createPkcePair, escapeHtml, safeEquals } from '../../src/auth/server.js';
import { TokenStore, type StoredTokens } from '../../src/auth/token-store.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';
import { createHash } from 'node:crypto';

const silent = createLogger('error', () => {});

/** Minimal ServerResponse stand-in recording what was written. */
function fakeRes() {
  const state = { status: 0, headers: {} as Record<string, string>, body: '', headersSent: false };
  const res = {
    get headersSent() {
      return state.headersSent;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status;
      state.headers = headers ?? {};
      state.headersSent = true;
      return res;
    },
    end(body?: string) {
      state.body = body ?? '';
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

const req = (url: string): IncomingMessage => ({ url }) as IncomingMessage;

function tokenEndpoint(spec: { status?: number; body: unknown }) {
  let calls = 0;
  const bodies: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls += 1;
    bodies.push(String(init.body));
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body,
      // Expose the form body so tests can assert on PKCE.
      __body: String(init.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls, bodies };
}

let dir: string;
let config: Config;
let store: TokenStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omocop-auth-'));
  config = loadConfig({
    M365_CLIENT_ID: 'cid',
    M365_CLIENT_SECRET: 'sec',
    M365_TOKEN_STORE: join(dir, 'tokens.json'),
    M365_AUTH_PORT: '3999',
  });
  store = new TokenStore(config, silent, (async () => ({})) as unknown as typeof fetch);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('escapeHtml', () => {
  test('neutralises a script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  test('escapes quotes so attribute contexts are safe too', () => {
    expect(escapeHtml(`" onmouseover='x'`)).toBe('&quot; onmouseover=&#39;x&#39;');
  });

  test('escapes ampersands first, without double-escaping', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('safeEquals', () => {
  test('matches identical strings', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
  });

  test('rejects different strings and different lengths without throwing', () => {
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals('', 'a')).toBe(false);
  });
});

describe('PKCE', () => {
  test('challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  test('every pair is distinct', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('authorize url', () => {
  test('carries PKCE, a state, and the configured scopes', () => {
    const server = new AuthServer(config, silent, store);
    const url = new URL(server.authorizeUrl());

    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}$/);
    expect(url.searchParams.get('scope')).toContain('Calendars.ReadWrite');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3999/auth/callback');
  });

  test('a new state each time', () => {
    const server = new AuthServer(config, silent, store);
    const a = new URL(server.authorizeUrl()).searchParams.get('state');
    const b = new URL(server.authorizeUrl()).searchParams.get('state');
    expect(a).not.toBe(b);
  });
});

describe('callback', () => {
  const goodBody = {
    access_token: 'at',
    refresh_token: 'rt',
    expires_in: 3600,
    scope: 'Mail.ReadWrite Calendars.ReadWrite',
  };

  test('completes the exchange and persists tokens', async () => {
    const endpoint = tokenEndpoint({ body: goodBody });
    const server = new AuthServer(config, silent, store, endpoint.impl);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');

    const { res, state: out } = fakeRes();
    await server.handle(req(`/auth/callback?code=abc&state=${state}`), res);

    expect(out.status).toBe(200);
    expect(out.body).toContain('Signed in');
    const stored = JSON.parse(await readFile(config.tokenStorePath, 'utf8')) as StoredTokens;
    expect(stored.refreshToken).toBe('rt');
    expect(stored.scopes).toEqual(['Mail.ReadWrite', 'Calendars.ReadWrite']);
  });

  test('sends client_secret when configured, omits it for a public client', async () => {
    // Confidential client: the secret goes out.
    const withSecret = tokenEndpoint({ body: goodBody });
    const server = new AuthServer(config, silent, store, withSecret.impl);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');
    await server.handle(req(`/auth/callback?code=abc&state=${state}`), fakeRes().res);
    expect(withSecret.bodies[0]).toContain('client_secret=sec');

    // Public client: no secret exists, and an empty one must not be sent —
    // PKCE (the code_verifier) carries the flow alone.
    const publicConfig = loadConfig({
      M365_CLIENT_ID: 'cid',
      M365_TOKEN_STORE: join(dir, 'tokens-public.json'),
      M365_AUTH_PORT: '3999',
    });
    const publicStore = new TokenStore(publicConfig, silent, (async () => ({})) as unknown as typeof fetch);
    const noSecret = tokenEndpoint({ body: goodBody });
    const publicServer = new AuthServer(publicConfig, silent, publicStore, noSecret.impl);
    const publicState = new URL(publicServer.authorizeUrl()).searchParams.get('state');
    await publicServer.handle(req(`/auth/callback?code=abc&state=${publicState}`), fakeRes().res);
    expect(noSecret.bodies[0]).not.toContain('client_secret');
    expect(noSecret.bodies[0]).toContain('code_verifier=');
  });

  test('reports the signed-in account when the id token carries one', async () => {
    const claims = Buffer.from(JSON.stringify({ preferred_username: 'agent@example.com' }))
      .toString('base64url');
    const endpoint = tokenEndpoint({ body: { ...goodBody, id_token: `h.${claims}.s` } });
    const server = new AuthServer(config, silent, store, endpoint.impl);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');

    const { res, state: out } = fakeRes();
    await server.handle(req(`/auth/callback?code=abc&state=${state}`), res);

    expect(out.body).toContain('agent@example.com');
    const stored = JSON.parse(await readFile(config.tokenStorePath, 'utf8')) as StoredTokens;
    expect(stored.account).toBe('agent@example.com');
  });

  /**
   * The CSRF case: a callback that did not originate from a sign-in this server
   * started must not be exchanged, or an attacker can bind their account here.
   */
  test('rejects a mismatched state and exchanges nothing', async () => {
    const endpoint = tokenEndpoint({ body: goodBody });
    const server = new AuthServer(config, silent, store, endpoint.impl);
    server.authorizeUrl();

    const { res, state: out } = fakeRes();
    await server.handle(req('/auth/callback?code=abc&state=not-the-state'), res);

    expect(out.status).toBe(400);
    expect(endpoint.calls()).toBe(0);
  });

  test('rejects a callback when no sign-in was started at all', async () => {
    const endpoint = tokenEndpoint({ body: goodBody });
    const server = new AuthServer(config, silent, store, endpoint.impl);

    const { res, state: out } = fakeRes();
    await server.handle(req('/auth/callback?code=abc&state=anything'), res);

    expect(out.status).toBe(400);
    expect(endpoint.calls()).toBe(0);
  });

  test('a state is single-use', async () => {
    const endpoint = tokenEndpoint({ body: goodBody });
    const server = new AuthServer(config, silent, store, endpoint.impl);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');

    await server.handle(req(`/auth/callback?code=abc&state=${state}`), fakeRes().res);
    const { res, state: out } = fakeRes();
    await server.handle(req(`/auth/callback?code=abc&state=${state}`), res);

    expect(out.status).toBe(400);
    expect(endpoint.calls()).toBe(1);
  });

  /**
   * The XSS case: the provider returns error text as a query parameter, and it is
   * rendered back to the user. Unescaped, that is script execution on localhost.
   */
  test('escapes provider error text rather than reflecting it', async () => {
    const server = new AuthServer(config, silent, store);
    const { res, state: out } = fakeRes();

    await server.handle(
      req('/auth/callback?error=bad&error_description=' +
        encodeURIComponent('<img src=x onerror=alert(1)>')),
      res,
    );

    expect(out.status).toBe(400);
    expect(out.body).not.toContain('<img');
    expect(out.body).toContain('&lt;img');
  });

  test('a failed exchange reports the reason without persisting anything', async () => {
    const endpoint = tokenEndpoint({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'code expired' },
    });
    const server = new AuthServer(config, silent, store, endpoint.impl);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');

    const { res, state: out } = fakeRes();
    await server.handle(req(`/auth/callback?code=abc&state=${state}`), res);

    expect(out.status).toBe(500);
    expect(out.body).toContain('invalid_grant');
    await expect(readFile(config.tokenStorePath, 'utf8')).rejects.toThrow();
  });

  test('missing code is refused', async () => {
    const server = new AuthServer(config, silent, store);
    const state = new URL(server.authorizeUrl()).searchParams.get('state');
    const { res, state: out } = fakeRes();
    await server.handle(req(`/auth/callback?state=${state}`), res);
    expect(out.status).toBe(400);
  });
});

describe('routing', () => {
  test('root redirects to the provider', async () => {
    const server = new AuthServer(config, silent, store);
    const { res, state: out } = fakeRes();
    await server.handle(req('/'), res);

    expect(out.status).toBe(302);
    expect(out.headers['Location']).toContain('login.microsoftonline.com');
  });

  test('anything else is a 404', async () => {
    const server = new AuthServer(config, silent, store);
    const { res, state: out } = fakeRes();
    await server.handle(req('/wat'), res);
    expect(out.status).toBe(404);
  });
});

describe('listen', () => {
  /**
   * This server exchanges authorization codes for tokens; bound to all
   * interfaces it would be reachable from the local network.
   */
  test('binds to the loopback interface only', async () => {
    const server = new AuthServer(config, silent, store);
    await server.listen();
    try {
      const address = (server as unknown as { server: HttpServer }).server.address();
      expect(address).toMatchObject({ address: '127.0.0.1', port: 3999 });
    } finally {
      await server.close();
    }
  });
});
