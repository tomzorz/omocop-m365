import type { GraphClient } from '../../src/graph/client.js';
import type { ToolContext } from '../../src/server/tool.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

export interface GraphCall {
  readonly method: 'GET' | 'COLLECT' | 'POST' | 'PATCH' | 'DELETE' | 'BYTES' | 'UPLOAD';
  readonly path: string;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly limit?: number;
}

/** Answers a call, or returns undefined to fall through to the next responder. */
export type Responder = (call: GraphCall) => unknown;

/**
 * Enforces Graph's `/messages` query-combination rules, so a request shape the
 * live service would 400 fails here instead of sailing through a green suite —
 * a 400 InefficientFilter shipped precisely because this fake accepted shapes
 * Graph does not.
 *
 * The rules: `$search` combines with neither `$orderby` nor `$filter`, and every
 * `$orderby` property must appear in `$filter` before any clause on another
 * property.
 */
function assertLegalMessagesQuery(call: GraphCall): void {
  if (!/\bmessages\b/.test(call.path) || !call.query) return;

  const search = call.query['$search'];
  const orderby = call.query['$orderby'];
  const filter = call.query['$filter'];

  if (search !== undefined && orderby !== undefined) {
    throw new Error(
      `fake-graph: Graph rejects $search combined with $orderby on /messages ` +
        `(${call.method} ${call.path})`,
    );
  }
  if (search !== undefined && filter !== undefined) {
    throw new Error(
      `fake-graph: Graph rejects $search combined with $filter on /messages ` +
        `(${call.method} ${call.path})`,
    );
  }
  if (orderby !== undefined && filter !== undefined) {
    const orderbyProperties = String(orderby)
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0] ?? '')
      .filter(Boolean);
    const clauses = String(filter).split(/\s+and\s+/i);
    const unseen = new Set(orderbyProperties);
    for (const clause of clauses) {
      if (unseen.size === 0) break;
      const matched = [...unseen].find((property) => clause.includes(property));
      if (matched === undefined) {
        throw new Error(
          `fake-graph: Graph requires every $orderby property to appear at the start of ` +
            `$filter (InefficientFilter). $orderby "${String(orderby)}" vs $filter ` +
            `"${String(filter)}" (${call.method} ${call.path})`,
        );
      }
      unseen.delete(matched);
    }
    if (unseen.size > 0) {
      throw new Error(
        `fake-graph: Graph requires every $orderby property to also appear in $filter ` +
          `(InefficientFilter). Missing: ${[...unseen].join(', ')} ` +
          `(${call.method} ${call.path})`,
      );
    }
  }
}

/**
 * A GraphClient stand-in that records every call and answers from a list of
 * responders, first match winning.
 */
export function fakeGraph(...responders: Responder[]) {
  const calls: GraphCall[] = [];

  const answer = (call: GraphCall): unknown => {
    calls.push(call);
    if (call.method === 'GET' || call.method === 'COLLECT') assertLegalMessagesQuery(call);
    for (const responder of responders) {
      const result = responder(call);
      if (result !== undefined) return result;
    }
    // A COLLECT's caller destructures `items`, so a silent `{}` here surfaces
    // as `items.map is not a function` far from the actual omission.
    if (call.method === 'COLLECT') {
      throw new Error(`fake-graph: no responder matched COLLECT ${call.path}`);
    }
    return {};
  };

  const graph = {
    get: async (path: string, query?: Record<string, unknown>) =>
      answer({ method: 'GET', path, ...(query ? { query } : {}) }),
    collect: async (path: string, query?: Record<string, unknown>, limit?: number) =>
      answer({ method: 'COLLECT', path, ...(query ? { query } : {}), ...(limit !== undefined ? { limit } : {}) }),
    post: async (path: string, body?: unknown) => answer({ method: 'POST', path, body }),
    patch: async (path: string, body: unknown) => answer({ method: 'PATCH', path, body }),
    delete: async (path: string) => {
      answer({ method: 'DELETE', path });
    },
    bytes: async (path: string) => answer({ method: 'BYTES', path }) as Buffer,
    uploadChunk: async (uploadUrl: string, chunk: Buffer, start: number, total: number) => {
      answer({ method: 'UPLOAD', path: uploadUrl, body: { start, total, length: chunk.length } });
    },
  };

  return {
    graph: graph as unknown as GraphClient,
    calls,
    /** Calls matching a method, in order. */
    of: (method: GraphCall['method']) => calls.filter((c) => c.method === method),
    /** The first call whose path contains the fragment. */
    find: (fragment: string) => calls.find((c) => c.path.includes(fragment)),
  };
}

/** Matches a method and a path fragment. */
export const on =
  (method: GraphCall['method'], fragment: string, value: unknown): Responder =>
  (call) =>
    call.method === method && call.path.includes(fragment) ? value : undefined;

export const TEST_CONFIG: Config = loadConfig({
  M365_CLIENT_ID: 'cid',
  M365_CLIENT_SECRET: 'sec',
  M365_TIMEZONE: 'W. Europe Standard Time',
});

/** A ToolContext wired to a fake Graph, with a silent logger. */
export function testContext(graph: GraphClient, lines: string[] = []): ToolContext {
  return {
    graph,
    config: TEST_CONFIG,
    logger: createLogger('debug', (c) => void lines.push(c)),
    resolved: new Map(),
  };
}

/** Scopes covering everything the tools declare, so the gate stays out of the way. */
export const ALL_SCOPES = ['Calendars.ReadWrite', 'Mail.ReadWrite', 'Mail.Send', 'User.Read'];

/** Convenience: the text of a tool result. */
export const textOf = (result: { content: readonly { type: string }[] }): string =>
  result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
