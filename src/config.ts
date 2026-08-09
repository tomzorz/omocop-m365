/**
 * Configuration, resolved once and validated.
 *
 * Every setting has exactly one name. A credential that is present under one name
 * and read under another presents as "authentication keeps breaking" rather than
 * as a configuration error, which is close to undiagnosable from the symptom.
 *
 * LOG_LEVEL is deliberately not resolved here: src/logging.ts owns it, because
 * the logger must exist before configuration loads (a config error itself needs
 * to be logged somewhere).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Scopes requested at sign-in — what the shipped tools need to work, and nothing
 * beyond it. `Mail.ReadWrite` implies `Mail.Read` and `Calendars.ReadWrite`
 * implies `Calendars.Read`, so the narrower forms are not requested separately.
 *
 * docs/rationale.md explains how this list was chosen.
 */
export const DEFAULT_SCOPES: readonly string[] = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
];

export const GRAPH_ENDPOINT = 'https://graph.microsoft.com/v1.0/';

type Env = Record<string, string | undefined>;

const PositivePort = z.coerce.number().int().min(1).max(65535);

export interface Config {
  readonly clientId: string;
  /**
   * Absent for a public-client app registration ("Mobile and desktop
   * applications" platform in Azure): the auth-code flow then relies on PKCE
   * alone, which is the intended design for anything that cannot keep a
   * secret — and means there is no secret to store, leak, or rotate.
   */
  readonly clientSecret?: string;
  /** Empty for personal Microsoft accounts, which use the shared endpoint. */
  readonly tenantId: string;
  readonly authority: string;
  readonly scopes: readonly string[];
  /** Windows timezone name applied to naive timestamps, e.g. "W. Europe Standard Time". */
  readonly timezone: string;
  readonly tokenStorePath: string;
  readonly authPort: number;
  readonly redirectUri: string;
  readonly graphEndpoint: string;
  readonly hideUngrantedTools: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Reads a setting, treating whitespace-only as absent. */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

const booleanish = (value: string | undefined): boolean =>
  value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());

/**
 * Builds the configuration, or throws with a message that says what to do.
 *
 * @param env defaults to process.env; injectable so tests do not mutate it
 */
export function loadConfig(env: Env = process.env): Config {
  const clientId = read(env, 'M365_CLIENT_ID');
  // Optional: absent means a public-client registration, where PKCE carries
  // the whole flow and no secret exists at all.
  const clientSecret = read(env, 'M365_CLIENT_SECRET');

  if (!clientId) {
    throw new ConfigError(
      `Missing required configuration: M365_CLIENT_ID.\n\n` +
        `An MCP server is launched by its client, not by a shell, so it does not inherit ` +
        `your environment and does not read .env. These must be set in the "env" block of ` +
        `your MCP client configuration.\n\n` +
        `See docs/setup.md. The auth server does read .env, and .env.example shows the shape.`,
    );
  }

  const tenantId = read(env, 'M365_TENANT_ID') ?? '';

  const rawScopes = read(env, 'M365_SCOPES');
  const scopes = rawScopes ? rawScopes.split(/[\s,]+/).filter(Boolean) : [...DEFAULT_SCOPES];

  // Without `offline_access` a sign-in gets no refresh token: everything works
  // until the first expiry, then presents as "authentication keeps breaking" —
  // the exact symptom this file exists to prevent. An override that omits it is
  // treated as an oversight, not a choice.
  if (!scopes.some((scope) => scope.toLowerCase() === 'offline_access')) {
    scopes.push('offline_access');
  }

  const authPortRaw = read(env, 'M365_AUTH_PORT') ?? '3333';
  const parsedPort = PositivePort.safeParse(authPortRaw);
  if (!parsedPort.success) {
    throw new ConfigError(
      `M365_AUTH_PORT must be a port number between 1 and 65535, got "${authPortRaw}".`,
    );
  }

  return {
    clientId,
    clientSecret,
    tenantId,
    // Personal Microsoft accounts have no tenant of their own and use 'common'.
    authority: `https://login.microsoftonline.com/${tenantId || 'common'}`,
    scopes,
    timezone: read(env, 'M365_TIMEZONE') ?? 'UTC',
    tokenStorePath:
      read(env, 'M365_TOKEN_STORE') ?? join(homedir(), '.omocop-m365-tokens.json'),
    authPort: parsedPort.data,
    redirectUri: `http://localhost:${parsedPort.data}/auth/callback`,
    graphEndpoint: GRAPH_ENDPOINT,
    hideUngrantedTools: booleanish(env['M365_HIDE_UNGRANTED_TOOLS']),
  };
}
