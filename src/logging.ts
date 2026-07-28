/**
 * Logging, and the guard that keeps stdout usable.
 *
 * An MCP server speaking the stdio transport owns stdout entirely: every byte on
 * it must be a JSON-RPC frame. A single stray `console.log` — ours, or one buried
 * in a dependency — corrupts the stream, and the client fails with a parse error
 * that says nothing about where it came from. It is a common way for a stdio
 * server to break, and the symptom never points at the cause.
 *
 * Two defences, because a lint rule cannot see inside `node_modules`:
 *   - `no-console` in eslint.config.js, for our own code
 *   - `installStdoutGuard()`, which redirects the console methods that write to
 *     stdout onto stderr at runtime, for everyone else's
 *
 * Everything here writes to stderr. That is not a limitation to work around; it
 * is the only correct destination while stdio is the transport.
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function parseLevel(raw: string | undefined): LogLevel {
  const value = String(raw ?? 'info').trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : 'info';
}

/**
 * Patterns for material that must never reach a log, at any level.
 *
 * Token content in debug output is the classic way an OAuth client leaks a
 * credential. Redacting at the sink rather than at every call site is what makes
 * it non-recurring: a caller cannot leak a token by forgetting, only by actively
 * defeating this.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWTs — three base64url segments. Graph access tokens are these.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<jwt:redacted>'],
  // Bearer headers, however they were assembled.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer <redacted>'],
  // Anything self-describing as a secret/token/password in key=value or JSON form.
  // This is what catches an Azure client secret, which is otherwise just an
  // opaque high-entropy string with no shape worth matching on.
  [
    /(["']?(?:client_?secret|access_?token|refresh_?token|password|api_?key)["']?\s*[:=]\s*["']?)([^"',\s}]{6,})/gi,
    '$1<redacted>',
  ],
];

/** Strips credential-shaped substrings from a log line. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  error(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  debug(...parts: unknown[]): void;
  readonly level: LogLevel;
}

/**
 * Builds a logger writing to stderr.
 * @param level defaults to $LOG_LEVEL, then 'info'
 * @param sink defaults to process.stderr — injectable so tests do not race on it
 */
export function createLogger(
  level: LogLevel = parseLevel(process.env['LOG_LEVEL']),
  sink: (chunk: string) => void = (chunk) => void process.stderr.write(chunk),
): Logger {
  const emit = (at: LogLevel, parts: unknown[]): void => {
    if (LEVEL_RANK[at] > LEVEL_RANK[level]) return;
    const line = parts.map(format).join(' ');
    sink(`[omocop-m365] ${at}: ${redact(line)}\n`);
  };

  return {
    level,
    error: (...parts) => emit('error', parts),
    warn: (...parts) => emit('warn', parts),
    info: (...parts) => emit('info', parts),
    debug: (...parts) => emit('debug', parts),
  };
}

/** Console methods that write to stdout, and so must never reach it. */
const STDOUT_CONSOLE_METHODS = ['log', 'info', 'debug', 'dir', 'table', 'trace', 'group', 'groupCollapsed', 'count', 'timeEnd', 'timeLog'] as const;

/**
 * Redirects every stdout-writing console method onto stderr.
 *
 * Call this before the transport is connected. It is a runtime backstop for code
 * we do not control — our own code is held to `no-console` by eslint.
 *
 * @returns a function restoring the original methods, for tests
 */
export function installStdoutGuard(logger: Logger = createLogger()): () => void {
  const saved = new Map<string, unknown>();

  for (const method of STDOUT_CONSOLE_METHODS) {
    const original = (console as unknown as Record<string, unknown>)[method];
    saved.set(method, original);
    (console as unknown as Record<string, unknown>)[method] = (...parts: unknown[]): void => {
      logger.debug(`[console.${method} redirected]`, ...parts);
    };
  }

  return () => {
    for (const [method, original] of saved) {
      (console as unknown as Record<string, unknown>)[method] = original;
    }
  };
}
