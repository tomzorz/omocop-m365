/**
 * The local sign-in server.
 *
 * Runs long enough to complete an authorization-code exchange, then keeps
 * listening so a failed attempt can be retried without restarting.
 *
 * Three things are deliberate:
 *
 *   - **PKCE, even though this client has a secret.** It costs nothing and it
 *     removes the value of an intercepted authorization code.
 *   - **`state` is a UUID compared in constant time.** A predictable or unchecked
 *     `state` is a CSRF hole: an attacker who can make the browser hit the
 *     callback with their own code binds the agent account to their session.
 *   - **Every value interpolated into a response is escaped.** The provider sends
 *     `error` and `error_description` back as query parameters, and echoing them
 *     into HTML unescaped is a reflected-XSS vector on localhost.
 */
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { createLogger, type Logger } from '../logging.js';
import { TokenStore, type StoredTokens } from './token-store.js';

/** Escapes text for interpolation into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compares two strings without leaking their contents through timing. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface PendingAuth {
  readonly state: string;
  readonly pkce: PkcePair;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Reads the account name from an id_token without verifying it — display only. */
function accountFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      preferred_username?: string;
      email?: string;
    };
    return claims.preferred_username ?? claims.email;
  } catch {
    return undefined;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.2rem}</style>
<h1>${escapeHtml(title)}</h1>${body}`;
}

export class AuthServer {
  private pending: PendingAuth | undefined;
  private server: Server | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The URL a user visits to begin sign-in. Regenerates state and PKCE. */
  authorizeUrl(): string {
    const pkce = createPkcePair();
    const state = randomUUID();
    this.pending = { state, pkce };

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      response_mode: 'query',
      scope: this.config.scopes.join(' '),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    return `${this.config.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  private async exchange(code: string, verifier: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
      scope: this.config.scopes.join(' '),
    });

    const response = await this.fetchImpl(`${this.config.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok || !payload.access_token || !payload.refresh_token) {
      const detail = payload.error
        ? `${payload.error}: ${payload.error_description ?? ''}`.trim()
        : `HTTP ${response.status}`;
      throw new Error(`Token exchange failed — ${detail}`);
    }

    const account = accountFromIdToken(payload.id_token);

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
      scopes: payload.scope ? payload.scope.split(' ').filter(Boolean) : [...this.config.scopes],
      ...(account ? { account } : {}),
    };
  }

  /** Handles one request. Exported shape kept small so tests can drive it directly. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.config.authPort}`);

    if (url.pathname === '/') {
      res.writeHead(302, { Location: this.authorizeUrl() }).end();
      return;
    }

    if (url.pathname !== '/auth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Not found', '<p>Nothing here. Start at <code>/</code>.</p>'));
      return;
    }

    const providerError = url.searchParams.get('error');
    if (providerError) {
      const description = url.searchParams.get('error_description') ?? '';
      this.logger.error(`Sign-in was refused: ${providerError} ${description}`);
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          'Sign-in failed',
          `<p><code>${escapeHtml(providerError)}</code></p><p>${escapeHtml(description)}</p>`,
        ),
      );
      return;
    }

    const pending = this.pending;
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';

    if (!pending || !safeEquals(state, pending.state)) {
      this.logger.error('Callback rejected: state did not match a sign-in started here.');
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          'Sign-in failed',
          '<p>That callback did not match a sign-in started by this server. ' +
            'Start again from <code>/</code>.</p>',
        ),
      );
      return;
    }

    // One state, one use.
    this.pending = undefined;

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('Sign-in failed', '<p>No authorization code was returned.</p>'));
      return;
    }

    try {
      const tokens = await this.exchange(code, pending.pkce.verifier);
      await this.store.persist(tokens);

      const granted = tokens.scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('');
      this.logger.info(
        `Signed in${tokens.account ? ` as ${tokens.account}` : ''}; ` +
          `${tokens.scopes.length} scopes granted`,
      );

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          'Signed in',
          `<p>Signed in${tokens.account ? ` as <code>${escapeHtml(tokens.account)}</code>` : ''}. ` +
            'You can close this tab.</p><p>Scopes granted:</p><ul>' + granted + '</ul>',
        ),
      );
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        page(
          'Sign-in failed',
          `<p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
        ),
      );
    }
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.logger.error('Unhandled error in auth server', error);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(this.config.authPort, resolve);
    });

    this.logger.info(
      `Sign-in server listening. Open http://localhost:${this.config.authPort}/ to authenticate.`,
    );
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }
}

/** CLI entry point: `npm run auth`. */
async function main(): Promise<void> {
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const logger = createLogger();
  const config = loadConfig(process.env);
  const store = new TokenStore(config, logger);
  await new AuthServer(config, logger, store).listen();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    createLogger().error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
