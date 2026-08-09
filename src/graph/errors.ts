/**
 * Graph failures, translated once.
 *
 * Two rules here, both learned from watching the alternative fail:
 *
 *   1. Never swallow. A request that fails must produce an error carrying the
 *      status, the Graph error code and the original message. Silently returning
 *      an empty or unfiltered result is worse than an exception, because the
 *      caller reports success and nobody investigates.
 *
 *   2. Translate in one place. Scattering `if (/status 403/)` through handlers
 *      guarantees they drift, and some tools end up explaining a failure while
 *      their neighbours emit a raw status line.
 */

/** Shape Graph uses for error bodies. */
interface GraphErrorBody {
  error?: {
    code?: string;
    message?: string;
    innerError?: { code?: string; 'request-id'?: string; date?: string };
  };
}

export class GraphError extends Error {
  override readonly name = 'GraphError';

  constructor(
    readonly status: number,
    /** Graph's machine-readable code, e.g. ErrorItemNotFound. Empty if absent. */
    readonly code: string,
    /** Graph's own message, always preserved. */
    readonly graphMessage: string,
    /** Correlation id, when Graph supplied one. Ask support for this. */
    readonly requestId: string | undefined,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} failed with ${status}${code ? ` (${code})` : ''}: ${graphMessage}`);
  }

  /** True when a refresh-and-retry could plausibly help. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }

  /** True when Graph asked us to back off rather than refusing outright. */
  get isThrottled(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 504;
  }
}

/** Parses a Graph error body, tolerating bodies that are not JSON at all. */
export function parseGraphError(
  status: number,
  rawBody: string,
  method: string,
  path: string,
): GraphError {
  let code = '';
  let message = rawBody.slice(0, 600);
  let requestId: string | undefined;

  try {
    const parsed = JSON.parse(rawBody) as GraphErrorBody;
    if (parsed.error) {
      code = parsed.error.code ?? '';
      message = parsed.error.message ?? message;
      requestId = parsed.error.innerError?.['request-id'];
    }
  } catch {
    // Not JSON — an HTML error page from a proxy, or an empty body. The raw
    // text is more useful than a parse failure would be.
  }

  return new GraphError(status, code, message, requestId, method, path);
}

/**
 * Guidance for a failure, or undefined when the raw message is already the best
 * thing to say. Callers append this to the underlying error, never replace it.
 */
export function explainGraphError(error: GraphError): string | undefined {
  const code = error.code.toLowerCase();

  if (error.status === 401) {
    return (
      'The access token was rejected. This usually means the refresh token has expired ' +
      'or consent was revoked — run the auth server and sign in again.'
    );
  }

  if (error.status === 403) {
    if (code.includes('accessdenied') || code.includes('erroraccessdenied')) {
      return (
        'Access denied. Either the signed-in account does not own this item — only an ' +
        "event's organiser can change or cancel it — or the operation needs a scope this " +
        'server does not request. See docs/rationale.md for which scopes are withheld ' +
        'deliberately.'
      );
    }
    return (
      'Forbidden. Most often this is a scope that was never granted; check the tool\'s ' +
      'required scopes against what your token carries.'
    );
  }

  // Checked before the generic 404: Graph delivers this code with HTTP 404, and
  // the id-container guidance below would otherwise answer first, wrongly.
  if (code.includes('mailboxnotenabledforrestapi')) {
    return (
      'This mailbox is not reachable through the Graph REST API. That normally means the ' +
      'account is not a mailbox-enabled Microsoft 365 or Outlook.com account.'
    );
  }

  if (error.status === 404) {
    return (
      'Not found. If the id came from a listing, check it is being used against the same ' +
      'container it was listed from — an event id is only valid for the calendar holding it.'
    );
  }

  if (error.status === 400) {
    if (code.includes('invalidid') || code.includes('malformed')) {
      return 'That id is malformed. Take ids verbatim from a listing rather than editing them.';
    }
    if (code.includes('recurrence')) {
      return (
        'Graph rejected the recurrence. Moving a series to a new start date requires the ' +
        'recurrence range to move with it.'
      );
    }
  }

  if (error.isThrottled) {
    return (
      'Graph is throttling this request and it was retried until the retry budget ran out. ' +
      'Reduce the request rate or narrow the query.'
    );
  }

  return undefined;
}

/** The message a tool should show: Graph's own, plus guidance when we have any. */
export function describeGraphError(error: GraphError): string {
  const guidance = explainGraphError(error);
  const correlation = error.requestId ? `\n\nGraph request id: ${error.requestId}` : '';
  // A bare 500 or 502 can arrive with an empty body, and Graph's own message is
  // then blank; the constructed message at least names the request and status.
  const base = error.graphMessage.trim() ? error.graphMessage : error.message;
  return guidance ? `${base}\n\n${guidance}${correlation}` : `${base}${correlation}`;
}
