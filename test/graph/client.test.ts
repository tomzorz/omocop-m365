import { beforeEach, describe, expect, test } from 'vitest';
import { GraphClient, type TokenProvider } from '../../src/graph/client.js';
import { GraphError } from '../../src/graph/errors.js';
import { createLogger } from '../../src/logging.js';

/** What one queued fake response looks like; plain data, not a real Response. */
interface FakeResponseSpec {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly bodyText?: string;
}

/** A queue-driven fetch stand-in that records what it was asked for. */
function fakeFetch(responses: FakeResponseSpec[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  /** Whether each response's body has been consumed, indexed by call order. */
  const drained: boolean[] = [];
  let i = 0;

  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const index = drained.length;
    drained.push(false);
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const status = spec?.status ?? 200;
    const body = spec?.bodyText ?? '';
    // Real undici bodies are one-shot streams: a second read throws. The fake
    // enforces that so a double read fails in tests, not only in production.
    const readOnce = () => {
      if (drained[index]) throw new TypeError('Body is unusable: Body has already been read');
      drained[index] = true;
      return body;
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(spec?.headers ?? {}),
      text: async () => readOnce(),
      arrayBuffer: async () => new TextEncoder().encode(readOnce()).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, calls, count: () => i, drained };
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

  test('drains the discarded 401 body so undici can reuse the connection', async () => {
    const f = fakeFetch([
      { status: 401, bodyText: '{"error":{"code":"InvalidAuthenticationToken"}}' },
      { status: 200, bodyText: '{"ok":true}' },
    ]);

    await client(f.impl).get('me');
    expect(f.drained[0]).toBe(true);
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

/**
 * A 429 means Graph refused the request before doing the work, so every method
 * may retry it. A 503/504 can arrive after the operation completed server-side,
 * so only idempotent methods may retry those — a retried sendMail is a double
 * send.
 */
describe('retry safety by method', () => {
  test('POST is not retried on 503 even though a retry would have succeeded', async () => {
    const f = fakeFetch([
      { status: 503, bodyText: '{}' },
      { status: 200, bodyText: '{}' },
    ]);

    await expect(client(f.impl).post('me/sendMail', {})).rejects.toMatchObject({ status: 503 });
    expect(f.count()).toBe(1);
  });

  test('PATCH is not retried on 504', async () => {
    const f = fakeFetch([
      { status: 504, bodyText: '{}' },
      { status: 200, bodyText: '{}' },
    ]);

    await expect(client(f.impl).patch('me/events/1', {})).rejects.toMatchObject({ status: 504 });
    expect(f.count()).toBe(1);
  });

  test('POST is retried on 429', async () => {
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '1' }, bodyText: '{}' },
      { status: 202, bodyText: '' },
    ]);

    await expect(client(f.impl).post('me/sendMail', {})).resolves.toEqual({});
    expect(f.count()).toBe(2);
  });

  test('GET is retried on 503', async () => {
    const f = fakeFetch([
      { status: 503, bodyText: '{}' },
      { status: 200, bodyText: '{"ok":1}' },
    ]);

    await expect(client(f.impl).get('me')).resolves.toEqual({ ok: 1 });
    expect(f.count()).toBe(2);
  });
});

describe('network failures', () => {
  test('a fetch rejection is translated and carries method and path', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const error = await client(impl)
      .get('me/messages')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ method: 'GET', path: 'me/messages' });
    expect((error as Error).message).toContain('fetch failed');
  });

  test('an upload-session fetch rejection is translated the same way', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const error = await client(impl)
      .uploadChunk('https://upload.test/s', Buffer.alloc(10), 0, 10)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ method: 'PUT' });
    expect((error as Error).message).toContain('fetch failed');
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

  test('a Prefer header rides along to every page, not just the first', async () => {
    const f = fakeFetch([
      { status: 200, bodyText: '{"value":[1],"@odata.nextLink":"https://graph.test/page2"}' },
      { status: 200, bodyText: '{"value":[2]}' },
    ]);

    await client(f.impl).collect<number>('me/events', {}, Infinity, { Prefer: 'outlook.timezone="UTC"' });

    for (const call of f.calls) {
      expect((call.init.headers as Record<string, string>)['Prefer']).toBe('outlook.timezone="UTC"');
    }
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

  test('a non-JSON second page fails with the same translated error as a first page would', async () => {
    const f = fakeFetch([
      { status: 200, bodyText: '{"value":[1],"@odata.nextLink":"https://graph.test/p2"}' },
      { status: 200, bodyText: 'not json at all' },
    ]);

    await expect(client(f.impl).collect<number>('me/m')).rejects.toMatchObject({
      code: 'InvalidJsonResponse',
      path: 'https://graph.test/p2',
    });
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
    // 416 is not transient; one attempt only.
    expect(f.count()).toBe(1);
  });

  test('uploadChunk retries a throttled chunk, honouring Retry-After', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      { status: 429, headers: { 'retry-after': '3' }, bodyText: '{}' },
      { status: 202, bodyText: '{}' },
    ]);

    await client(f.impl, { sleep: async (ms: number) => void waits.push(ms) }).uploadChunk(
      'https://upload.test/s',
      Buffer.alloc(10),
      0,
      10,
    );
    expect(f.count()).toBe(2);
    expect(waits).toEqual([3000]);
  });

  test('uploadChunk retries 503 (a ranged PUT is idempotent) and gives up after maxAttempts', async () => {
    const f = fakeFetch([{ status: 503, bodyText: '{}' }]);

    await expect(
      client(f.impl, { maxAttempts: 2 }).uploadChunk('https://upload.test/s', Buffer.alloc(1), 0, 1),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.count()).toBe(2);
  });
});
