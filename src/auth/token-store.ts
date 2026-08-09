/**
 * Token storage and refresh.
 *
 * Three things here are load-bearing.
 *
 * **One refresh at a time.** Two concurrent 401s must not start two refreshes:
 * Entra invalidates the old refresh token when it issues a new one, so the second
 * exchange races the first and can leave the stored credential dead. A single
 * in-flight promise, shared by every caller, is the whole fix.
 *
 * **Granted scopes come from the token response, not from the request.** Asking
 * for a scope is not being given it. The token endpoint reports what was actually
 * granted, and that is what the tool surface is gated on.
 *
 * **Nothing here logs token material.** The logger redacts as a backstop, but the
 * rule is that this module does not pass tokens to it in the first place.
 *
 * **The token file is shared with other processes.** `npm run auth` and any
 * second server instance write the same file, and Entra invalidates the old
 * refresh token when it rotates one. So: a refresh re-reads disk before
 * exchanging, an invalid_grant is retried once with whatever token is on disk,
 * writes are write-then-rename so a crash cannot truncate the store, and
 * "not authenticated" is never memoised past the failure that discovered it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { TokenProvider } from '../graph/client.js';

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /** Scopes the token endpoint reported as granted. */
  readonly scopes: readonly string[];
  /** Signed-in account, when the response carried one. Useful for "as whom?". */
  readonly account?: string;
}

/** Shape of a successful token endpoint response. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export class AuthenticationRequiredError extends Error {
  override readonly name = 'AuthenticationRequiredError';
  constructor(detail?: string) {
    super(
      'Not authenticated. Run the auth server (`npm run auth`) and sign in, then retry.' +
        (detail ? `\n\n${detail}` : ''),
    );
  }
}

/** Refresh this long before expiry rather than waiting to be rejected. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Reads the `scp` claim from a JWT without verifying it — informational only. */
export function scopesFromJwt(token: string): readonly string[] | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      scp?: string;
    };
    return typeof payload.scp === 'string' ? payload.scp.split(' ').filter(Boolean) : undefined;
  } catch {
    // Personal Microsoft accounts can receive opaque tokens. The stored scope
    // list from the token response covers that case, so this is best-effort.
    return undefined;
  }
}

export class TokenStore implements TokenProvider {
  private inFlight: Promise<StoredTokens> | undefined;

  /**
   * Memoised as a promise rather than guarded by a boolean.
   *
   * A `loaded` flag set before the file read is a race: concurrent callers see
   * the flag, find the field still empty, and conclude "not authenticated" while
   * the read is in flight. Sharing the promise is the same single-flight shape as
   * the refresh below, and for the same reason.
   */
  private loadPromise: Promise<StoredTokens | undefined> | undefined;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<StoredTokens | undefined> {
    this.loadPromise ??= this.readFromDisk().then((tokens) => {
      // "Not authenticated" is never memoised: signing in happens in another
      // process (`npm run auth`), so the next call must re-read the file rather
      // than repeat a stale verdict until this server restarts.
      if (!tokens) this.loadPromise = undefined;
      return tokens;
    });
    return this.loadPromise;
  }

  /**
   * Every give-up path funnels here. The error's own advice is "sign in, then
   * retry", and signing in writes a new token file from another process — the
   * retry can only see it if the memoised load is dropped.
   */
  private authRequired(detail?: string): AuthenticationRequiredError {
    this.loadPromise = undefined;
    return new AuthenticationRequiredError(detail);
  }

  /** A missing or corrupt file means "not authenticated", never an exception. */
  private async readFromDisk(): Promise<StoredTokens | undefined> {
    try {
      const raw = await readFile(this.config.tokenStorePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredTokens;
      if (typeof parsed?.refreshToken === 'string' && parsed.refreshToken.length > 0) {
        return parsed;
      }
      this.logger.warn('Token store exists but holds no refresh token; re-authentication needed.');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(
          `Token store at ${this.config.tokenStorePath} could not be read (${code ?? 'parse error'}); ` +
            'treating as not authenticated.',
        );
      }
    }
    return undefined;
  }

  async persist(tokens: StoredTokens): Promise<void> {
    // Replace the memoised read so later callers see the new value, not the old file.
    this.loadPromise = Promise.resolve(tokens);
    await mkdir(dirname(this.config.tokenStorePath), { recursive: true });
    // Write-then-rename: a crash mid-write must leave the previous store intact,
    // not a truncated file that silently reads as "not authenticated". The temp
    // file sits in the same directory so the rename cannot cross filesystems;
    // the pid keeps two processes from clobbering each other's temp file.
    const tempPath = `${this.config.tokenStorePath}.${process.pid}.tmp`;
    // 0600: the refresh token is a long-lived credential.
    await writeFile(tempPath, JSON.stringify(tokens, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(tempPath, this.config.tokenStorePath);
    this.logger.debug(`Token store written (${tokens.scopes.length} scopes granted)`);
  }

  /** Scopes actually granted, or undefined when not yet authenticated. */
  async grantedScopes(): Promise<readonly string[] | undefined> {
    const tokens = await this.load();
    if (!tokens) return undefined;
    return scopesFromJwt(tokens.accessToken) ?? tokens.scopes;
  }

  /** The signed-in account, when known. */
  async account(): Promise<string | undefined> {
    return (await this.load())?.account;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw this.authRequired();

    if (tokens.expiresAt - this.now() > EXPIRY_SKEW_MS) return tokens.accessToken;

    this.logger.debug('Access token is at or near expiry; refreshing before use');
    return (await this.refreshTokens()).accessToken;
  }

  async refresh(): Promise<string> {
    return (await this.refreshTokens()).accessToken;
  }

  /**
   * Exchanges the refresh token, collapsing concurrent callers onto one request.
   */
  private async refreshTokens(): Promise<StoredTokens> {
    if (this.inFlight) return this.inFlight;

    const run = async (): Promise<StoredTokens> => {
      let current = await this.load();
      if (!current) throw this.authRequired();

      // Another process sharing this file may have refreshed moments ago, and
      // Entra invalidates the old refresh token on rotation — exchanging the
      // in-memory one after a rotation elsewhere kills the stored credential.
      // Disk is re-read inside the critical section so the rotated tokens win.
      const onDisk = await this.readFromDisk();
      if (
        onDisk &&
        (onDisk.accessToken !== current.accessToken ||
          onDisk.refreshToken !== current.refreshToken)
      ) {
        current = onDisk;
        this.loadPromise = Promise.resolve(onDisk);
        if (onDisk.expiresAt - this.now() > EXPIRY_SKEW_MS) {
          this.logger.debug('Adopted tokens refreshed by another process; skipping the exchange');
          return onDisk;
        }
      }

      let outcome = await this.exchange(current.refreshToken);

      if (!outcome.ok && outcome.payload.error === 'invalid_grant') {
        // invalid_grant usually means spent or revoked — but when another
        // process rotated the token between our disk read and the POST, the
        // rotated token is on disk now and is worth exactly one retry before
        // demanding a fresh sign-in.
        const latest = await this.readFromDisk();
        if (latest && latest.refreshToken !== current.refreshToken) {
          current = latest;
          this.loadPromise = Promise.resolve(latest);
          outcome = await this.exchange(latest.refreshToken);
        }
      }

      const { payload } = outcome;
      if (!outcome.ok || !payload.access_token) {
        const detail = payload.error
          ? `${payload.error}: ${payload.error_description ?? ''}`.trim()
          : `HTTP ${outcome.status}`;
        throw this.authRequired(`The refresh failed — ${detail}`);
      }

      const refreshed: StoredTokens = {
        accessToken: payload.access_token,
        // Entra rotates refresh tokens; keeping the old one on absence is correct.
        refreshToken: payload.refresh_token ?? current.refreshToken,
        expiresAt: this.now() + (payload.expires_in ?? 3600) * 1000,
        scopes: payload.scope ? payload.scope.split(' ').filter(Boolean) : current.scopes,
        ...(current.account ? { account: current.account } : {}),
      };

      await this.persist(refreshed);
      this.logger.info('Access token refreshed');
      return refreshed;
    };

    this.inFlight = run().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }

  /** One refresh-token exchange; the caller owns the retry and give-up decisions. */
  private async exchange(
    refreshToken: string,
  ): Promise<{ ok: boolean; status: number; payload: TokenResponse }> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: this.config.scopes.join(' '),
    });
    // A public-client registration has no secret; sending an empty one is an error.
    if (this.config.clientSecret) body.set('client_secret', this.config.clientSecret);

    const response = await this.fetchImpl(`${this.config.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as TokenResponse;
    return { ok: response.ok && Boolean(payload.access_token), status: response.status, payload };
  }
}
