/**
 * The Microsoft Graph client.
 *
 * One client, three transports — JSON, raw bytes, and upload sessions — sharing
 * the same retry, error translation and token handling. Splitting those concerns
 * across call sites is how a codebase ends up with retry on some paths and not
 * others.
 *
 * Graph throttles aggressively and says so precisely, via 429 and a `Retry-After`
 * header. Honouring it is not optional politeness: ignoring it turns a brief
 * slowdown into a spreading failure.
 */
import { GraphError, parseGraphError } from './errors.js';
import { buildQuery, graphUrl, type QueryValue } from './path.js';
import type { Logger } from '../logging.js';

/** Supplies a bearer token, refreshing it when Graph rejects the current one. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Called after a 401 so the next attempt uses a fresh token. */
  refresh(): Promise<string>;
}

export interface GraphClientOptions {
  readonly endpoint: string;
  readonly tokens: TokenProvider;
  readonly logger: Logger;
  /** Attempts per request, including the first. Default 4. */
  readonly maxAttempts?: number;
  /** Ceiling on a single backoff wait, ms. Default 20000. */
  readonly maxBackoffMs?: number;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Record<string, QueryValue>;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

export class GraphClient {
  private readonly endpoint: string;
  private readonly tokens: TokenProvider;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly maxBackoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GraphClientOptions) {
    this.endpoint = options.endpoint;
    this.tokens = options.tokens;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.maxBackoffMs = options.maxBackoffMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Performs a request with retry, refreshing once on 401.
   *
   * @param absoluteUrl set when following an @odata.nextLink, which is already complete
   */
  private async send(
    path: string,
    options: RequestOptions,
    absoluteUrl?: string,
  ): Promise<Response> {
    const method = options.method ?? 'GET';
    const url = absoluteUrl ?? graphUrl(this.endpoint, path, options.query ?? {});

    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      const token = await this.tokens.getAccessToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...options.headers,
      };
      if (options.body !== undefined) headers['Content-Type'] ??= 'application/json';

      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.ok) return response;

      // A rejected token is worth exactly one refresh; a second 401 is a real
      // authentication failure and must surface rather than loop.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.logger.debug(`${method} ${path} returned 401; refreshing the access token`);
        await this.tokens.refresh();
        continue;
      }

      const body = await response.text();
      const error = parseGraphError(response.status, body, method, path);

      if (error.isThrottled && attempt < this.maxAttempts) {
        const advised = retryAfterMs(response.headers.get('retry-after'));
        // Graph's own advice wins; the exponential fallback is for when it is silent.
        const wait = Math.min(advised ?? 2 ** attempt * 500, this.maxBackoffMs);
        this.logger.warn(
          `${method} ${path} throttled (${response.status}); retrying in ${wait}ms ` +
            `(attempt ${attempt} of ${this.maxAttempts})`,
        );
        await this.sleep(wait);
        continue;
      }

      throw error;
    }
  }

  /** A JSON request. Returns `{}` for 204 and other empty successes. */
  async json<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new GraphError(
        response.status,
        'InvalidJsonResponse',
        `Graph returned a body that is not JSON: ${String(cause)}`,
        undefined,
        options.method ?? 'GET',
        path,
      );
    }
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.json<T>(path, { method: 'GET', ...(query ? { query } : {}) });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.json<T>(path, { method: 'POST', body: body ?? {} });
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'PATCH', body });
  }

  async delete(path: string): Promise<void> {
    await this.send(path, { method: 'DELETE' });
  }

  /**
   * Follows `@odata.nextLink` until `limit` items are collected or pages run out.
   *
   * Graph pages at its own discretion — a `$top` of 50 does not guarantee 50 in
   * one response — so anything reading a collection must page or knowingly accept
   * a partial answer.
   */
  async collect<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    limit = Infinity,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let next: string | undefined;
    let first = true;

    while (items.length < limit) {
      const page = first
        ? await this.json<{ value?: T[]; '@odata.nextLink'?: string }>(path, {
            method: 'GET',
            query,
          })
        : await this.followNextLink<T>(next as string);
      first = false;

      items.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
      if (!next) return { items: items.slice(0, limit), truncated: items.length > limit };
    }

    return { items: items.slice(0, limit), truncated: true };
  }

  private async followNextLink<T>(
    url: string,
  ): Promise<{ value?: T[]; '@odata.nextLink'?: string }> {
    const response = await this.send('', { method: 'GET' }, url);
    const text = await response.text();
    return text ? (JSON.parse(text) as { value?: T[]; '@odata.nextLink'?: string }) : {};
  }

  /**
   * Fetches raw bytes — attachment content, and anything else Graph serves as a
   * stream rather than JSON.
   *
   * `fetch` strips the Authorization header across an origin change, which is
   * exactly right: Graph answers these with a redirect to a pre-authenticated
   * storage URL that rejects a bearer token.
   */
  async bytes(path: string, query?: Record<string, QueryValue>): Promise<Buffer> {
    const response = await this.send(path, {
      method: 'GET',
      ...(query ? { query } : {}),
      headers: { Accept: '*/*' },
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * PUTs one chunk to an upload-session URL.
   *
   * The URL is pre-authenticated and short-lived; sending a bearer token to it is
   * an error, so this deliberately bypasses `send`.
   */
  async uploadChunk(
    uploadUrl: string,
    chunk: Buffer,
    start: number,
    total: number,
  ): Promise<void> {
    const end = start + chunk.length - 1;
    const response = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      // Content-Length is a forbidden header for fetch; the runtime sets it from
      // the body. Content-Range is what the upload session actually needs.
      headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
      body: new Uint8Array(chunk),
    });

    if (!response.ok) {
      throw parseGraphError(
        response.status,
        await response.text(),
        'PUT',
        `<upload-session> bytes ${start}-${end}/${total}`,
      );
    }
  }

  /** Exposed for the auth server, which builds its own query strings. */
  static query = buildQuery;
}
