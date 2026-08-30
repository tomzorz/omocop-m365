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

/**
 * Methods safe to repeat when the outcome of the first attempt is unknown.
 * POST and PATCH are excluded: a 503/504 from a gateway can arrive after Graph
 * completed the operation, so a retried `POST /me/sendMail` delivers the
 * message twice. GET, PUT and DELETE repeated against the same resource
 * converge on the same state.
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE']);

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
    // A nextLink request carries an empty relative path; errors and logs must
    // still name the target.
    const target = path || url;

    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      const token = await this.tokens.getAccessToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...options.headers,
      };
      if (options.body !== undefined) headers['Content-Type'] ??= 'application/json';

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (cause) {
        throw this.networkError(cause, method, target);
      }

      if (response.ok) return response;

      // A rejected token is worth exactly one refresh; a second 401 is a real
      // authentication failure and must surface rather than loop.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        // Undici parks the connection until the body is consumed or cancelled;
        // discarding the 401 without draining it pins a socket per refresh.
        await response.text();
        this.logger.debug(`${method} ${target} returned 401; refreshing the access token`);
        await this.tokens.refresh();
        continue;
      }

      const body = await response.text();
      const error = parseGraphError(response.status, body, method, target);

      // 429 is safe to retry for every method: Graph rejects a throttled
      // request before doing the work. 503/504 are not — the gateway may time
      // out after the operation completed server-side — so those retry only
      // for idempotent methods, and POST/PATCH surface the error immediately.
      const retryable =
        response.status === 429 ||
        ((response.status === 503 || response.status === 504) && IDEMPOTENT_METHODS.has(method));

      if (retryable && attempt < this.maxAttempts) {
        const wait = this.backoffMs(attempt, response.headers.get('retry-after'));
        this.logger.warn(
          `${method} ${target} throttled (${response.status}); retrying in ${wait}ms ` +
            `(attempt ${attempt} of ${this.maxAttempts})`,
        );
        await this.sleep(wait);
        continue;
      }

      throw error;
    }
  }

  /** Graph's own Retry-After wins; the exponential fallback is for when it is silent. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    return Math.min(retryAfterMs(retryAfter) ?? 2 ** attempt * 500, this.maxBackoffMs);
  }

  /**
   * `fetch` rejects network-level failures (DNS, connection reset) with a bare
   * TypeError naming neither the request nor the target; unless translated
   * here, the caller sees "fetch failed" with no way to tell which call died.
   */
  private networkError(cause: unknown, method: string, target: string): GraphError {
    return new GraphError(
      0,
      'NetworkError',
      `Request failed before a response arrived: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      undefined,
      method,
      target,
    );
  }

  /** A JSON request. Returns `{}` for 204 and other empty successes. */
  async json<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    return this.parseBody<T>(response, options.method ?? 'GET', path);
  }

  /** Empty and 204 successes parse to `{}`; a non-JSON success is an error, never a silent empty. */
  private async parseBody<T>(response: Response, method: string, path: string): Promise<T> {
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
        method,
        path,
      );
    }
  }

  get<T = unknown>(
    path: string,
    query?: Record<string, QueryValue>,
    headers?: Record<string, string>,
  ): Promise<T> {
    return this.json<T>(path, {
      method: 'GET',
      ...(query ? { query } : {}),
      ...(headers ? { headers } : {}),
    });
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
    headers?: Record<string, string>,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let next: string | undefined;
    let first = true;

    while (items.length < limit) {
      const page = first
        ? await this.json<{ value?: T[]; '@odata.nextLink'?: string }>(path, {
            method: 'GET',
            query,
            ...(headers ? { headers } : {}),
          })
        : await this.followNextLink<T>(next as string, headers);
      first = false;

      items.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
      if (!next) return { items: items.slice(0, limit), truncated: items.length > limit };
    }

    return { items: items.slice(0, limit), truncated: true };
  }

  private async followNextLink<T>(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ value?: T[]; '@odata.nextLink'?: string }> {
    // A Prefer header shapes what Graph returns, so it must ride along to every
    // page — page two answering in a different zone than page one is a bug.
    const response = await this.send('', { method: 'GET', ...(headers ? { headers } : {}) }, url);
    // Same parse-and-translate as the first page: a proxy can hand back a
    // non-JSON 200 on any page, and page two must not fail with a different
    // error shape than page one would.
    return this.parseBody<{ value?: T[]; '@odata.nextLink'?: string }>(response, 'GET', url);
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
    const target = `<upload-session> bytes ${start}-${end}/${total}`;

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(uploadUrl, {
          method: 'PUT',
          // Content-Length is a forbidden header for fetch; the runtime sets it from
          // the body. Content-Range is what the upload session actually needs.
          headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
          body: new Uint8Array(chunk),
        });
      } catch (cause) {
        throw this.networkError(cause, 'PUT', target);
      }

      if (response.ok) return;

      const error = parseGraphError(response.status, await response.text(), 'PUT', target);

      // A ranged PUT is idempotent — the session accepts a re-sent chunk it
      // already holds — so 503/504 retry here as well as 429. Without this, one
      // transient throttle mid-upload kills the entire large upload.
      if (
        (response.status === 429 || response.status === 503 || response.status === 504) &&
        attempt < this.maxAttempts
      ) {
        const wait = this.backoffMs(attempt, response.headers.get('retry-after'));
        this.logger.warn(
          `PUT ${target} throttled (${response.status}); retrying in ${wait}ms ` +
            `(attempt ${attempt} of ${this.maxAttempts})`,
        );
        await this.sleep(wait);
        continue;
      }

      throw error;
    }
  }

  /** Exposed for the auth server, which builds its own query strings. */
  static query = buildQuery;
}
