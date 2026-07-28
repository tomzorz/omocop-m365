import { beforeEach, describe, expect, test } from 'vitest';
import { GraphClient, type TokenProvider } from '../../src/graph/client.js';
import { GraphError } from '../../src/graph/errors.js';
import { createLogger } from '../../src/logging.js';

/** A queue-driven fetch stand-in that records what it was asked for. */
function fakeFetch(responses: Array<Partial<Response> & { bodyText?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;

  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = spec?.status ?? 200;
    const body = spec?.bodyText ?? '';
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers((spec?.headers as HeadersInit) ?? {}),
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls, count: () => i };
}

function makeTokens(): TokenProvider & { refreshes: number } {
  let n = 0;
  return {
    get refreshes() {
      return n;
    },
    getAccessToken: async () => `token-${n}`,
    refresh: async () => {
      n += 1;
      return `token-${n}`;
    },
  };
}

const silent = createLogger('error', () => {});

let tokens: ReturnType<typeof makeTokens>;
beforeEach(() => {
  tokens = makeTokens();
});

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new GraphClient({
    endpoint: 'https://graph.test/v1.0/',
    tokens,
    logger: silent,
    fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
}

describe('requests', () => {
  test('sends a bearer token and parses JSON', async () => {
    const f = fakeFetch([{ status: 200, bodyText: '{"id":"1"}' }]);
    const result = await client(f.impl).get<{ id: string }>('me/messages');

    expect(result.id).toBe('1');
    expect(f.calls[0]?.url).toBe('https://graph.test/v1.0/me/messages');
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-0');
  });

  test('returns an empty object for 204', async () => {
    const f = fakeFetch([{ status: 204 }]);
    await expect(client(f.impl).json('me/x', { method: 'DELETE' })).resolves.toEqual({});
  });

  test('serialises a JSON body and sets the content type', async () => {
    const f = fakeFetch([{ status: 201, bodyText: '{}' }]);
    await client(f.impl).post('me/events', { subject: 'x' });

    expect(f.calls[0]?.init.body).toBe('{"subject":"x"}');
    expect((f.calls[0]?.init.headers as Record<string, string>)['Content-Type'])
      .toBe('application/json');
  });
});

describe('authentication', () => {
  test('refreshes once on 401 and retries', async () => {
    const f = fakeFetch([
      { status: 401, bodyText: '{"error":{"code":"InvalidAuthenticationToken"}}' },
      { status: 200, bodyText: '{"ok":true}' },
    ]);

    await expect(client(f.impl).get('me')).resolves.toEqual({ ok: true });
    expect(tokens.refreshes).toBe(1);
    expect((f.calls[1]?.init.headers as Record<string, string>)['Authorization'])
      .toBe('Bearer token-1');
  });

  test('surfaces a second 401 rather than looping', async () => {
    const f = fakeFetch([
      { status: 401, bodyText: '{"error":{"code":"X","message":"bad token"}}' },
      { status: 401, bodyText: '{"error":{"code":"X","message":"bad token"}}' },
    ]);

    await expect(client(f.impl).get('me')).rejects.toThrow(GraphError);
    expect(tokens.refreshes).toBe(1);
    expect(f.count()).toBe(2);
  });
});

describe('throttling', () => {
  test('honours Retry-After in seconds', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '7' }, bodyText: '{}' },
      { status: 200, bodyText: '{"ok":1}' },
    ]);

    await client(f.impl, { sleep: async (ms: number) => void waits.push(ms) }).get('me');
    expect(waits).toEqual([7000]);
  });

  test('falls back to exponential backoff when Retry-After is absent', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      { status: 503, bodyText: '{}' },
      { status: 503, bodyText: '{}' },
      { status: 200, bodyText: '{"ok":1}' },
    ]);

    await client(f.impl, { sleep: async (ms: number) => void waits.push(ms) }).get('me');
    expect(waits).toEqual([1000, 2000]);
  });

  test('caps the wait', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '9999' }, bodyText: '{}' },
      { status: 200, bodyText: '{}' },
    ]);

    await client(f.impl, {
      sleep: async (ms: number) => void waits.push(ms),
      maxBackoffMs: 5000,
    }).get('me');
    expect(waits).toEqual([5000]);
  });

  test('gives up after maxAttempts and throws rather than returning empty', async () => {
    const f = fakeFetch([{ status: 429, bodyText: '{"error":{"message":"slow down"}}' }]);
    const c = client(f.impl, { maxAttempts: 3 });

    await expect(c.get('me')).rejects.toMatchObject({ status: 429 });
    expect(f.count()).toBe(3);
  });
});

describe('errors are never swallowed', () => {
  test('a 400 becomes a GraphError carrying code and message', async () => {
    const f = fakeFetch([
      {
        status: 400,
        bodyText: JSON.stringify({
          error: {
            code: 'ErrorInvalidIdMalformed',
            message: 'Id is malformed.',
            innerError: { 'request-id': 'abc-123' },
          },
        }),
      },
    ]);

    await expect(client(f.impl).get('me/messages/x')).rejects.toMatchObject({
      status: 400,
      code: 'ErrorInvalidIdMalformed',
      graphMessage: 'Id is malformed.',
      requestId: 'abc-123',
    });
  });

  test('tolerates a non-JSON error body', async () => {
    const f = fakeFetch([{ status: 502, bodyText: '<html>gateway</html>' }]);
    await expect(client(f.impl).get('me')).rejects.toMatchObject({
      status: 502,
      graphMessage: '<html>gateway</html>',
    });
  });

  test('a success body that is not JSON is an error, not a silent empty result', async () => {
    const f = fakeFetch([{ status: 200, bodyText: 'not json at all' }]);
    await expect(client(f.impl).get('me')).rejects.toMatchObject({
      code: 'InvalidJsonResponse',
    });
  });
});

describe('pagination', () => {
  test('follows nextLink until the pages run out', async () => {
    const f = fakeFetch([
      { status: 200, bodyText: '{"value":[1,2],"@odata.nextLink":"https://graph.test/page2"}' },
      { status: 200, bodyText: '{"value":[3]}' },
    ]);

    const { items, truncated } = await client(f.impl).collect<number>('me/messages');
    expect(items).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
    expect(f.calls[1]?.url).toBe('https://graph.test/page2');
  });

  test('stops at the limit and reports truncation', async () => {
    const f = fakeFetch([
      { status: 200, bodyText: '{"value":[1,2,3],"@odata.nextLink":"https://graph.test/p2"}' },
    ]);

    const { items, truncated } = await client(f.impl).collect<number>('me/m', {}, 2);
    expect(items).toEqual([1, 2]);
    expect(truncated).toBe(true);
  });

  test('a single short page is not truncated', async () => {
    const f = fakeFetch([{ status: 200, bodyText: '{"value":[1]}' }]);
    const { items, truncated } = await client(f.impl).collect<number>('me/m', {}, 10);
    expect(items).toEqual([1]);
    expect(truncated).toBe(false);
  });
});

describe('binary and uploads', () => {
  test('bytes returns a Buffer', async () => {
    const f = fakeFetch([{ status: 200, bodyText: 'PDF-BYTES' }]);
    const buf = await client(f.impl).bytes('me/messages/1/attachments/2/$value');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('PDF-BYTES');
  });

  test('uploadChunk sets Content-Range and sends no bearer token', async () => {
    const f = fakeFetch([{ status: 202, bodyText: '{}' }]);
    await client(f.impl).uploadChunk('https://upload.test/session', Buffer.alloc(100), 0, 250);

    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers['Content-Range']).toBe('bytes 0-99/250');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('a failed chunk throws with the range in the path', async () => {
    const f = fakeFetch([{ status: 416, bodyText: '{"error":{"message":"bad range"}}' }]);
    await expect(
      client(f.impl).uploadChunk('https://upload.test/s', Buffer.alloc(10), 5, 20),
    ).rejects.toMatchObject({ status: 416 });
  });
});
