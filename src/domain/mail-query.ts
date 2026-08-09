/**
 * Building mail queries that Graph will actually accept.
 *
 * Graph's `/messages` collection has combination rules that are easy to violate
 * and unpleasant when violated: `$search` cannot be combined with `$filter` or
 * `$orderby` at all, and a `$filter` on one property alongside an `$orderby` on
 * another is rejected as too complex. The failure is a 400 — but code that
 * catches and ignores it returns the unfiltered inbox instead, which looks like
 * a working search that found the wrong things.
 *
 * So the rules are encoded here rather than discovered at runtime, and the query
 * reports in prose what it had to give up. Nothing is silently dropped.
 */

export interface SearchCriteria {
  /** Free text. Its presence switches the whole query to KQL search. */
  readonly query?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly subject?: string | undefined;
  readonly hasAttachments?: boolean | undefined;
  readonly unreadOnly?: boolean | undefined;
  /** ISO 8601. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
}

export interface BuiltQuery {
  readonly params: Record<string, string | number>;
  /** What the caller should be told about how the query was shaped. */
  readonly notes: readonly string[];
  /** True when Graph will order by relevance rather than date. */
  readonly relevanceOrdered: boolean;
}

/** Fields a listing needs; deliberately excludes the body. */
export const MESSAGE_LIST_SELECT =
  'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,importance,isRead,isDraft,conversationId';

/** Everything read-email needs, including the body. */
export const MESSAGE_DETAIL_SELECT =
  'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,hasAttachments,importance,isRead,isDraft,webLink';

/** Escapes a value for an OData string literal. */
const odataString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Escapes a value for a KQL term, quoting when it contains whitespace. */
function kqlValue(value: string): string {
  const trimmed = value.trim().replace(/"/g, '');
  return /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
}

function buildKql(criteria: SearchCriteria, notes: string[]): string {
  const terms: string[] = [];

  if (criteria.query?.trim()) terms.push(criteria.query.trim());
  if (criteria.from?.trim()) terms.push(`from:${kqlValue(criteria.from)}`);
  if (criteria.to?.trim()) terms.push(`to:${kqlValue(criteria.to)}`);
  if (criteria.subject?.trim()) terms.push(`subject:${kqlValue(criteria.subject)}`);
  // KQL spells this singular, unlike the OData property.
  if (criteria.hasAttachments) terms.push('hasattachment:true');
  // KQL received terms compare whole days, so a time-of-day bound cannot be
  // honoured in a text search; when one was given, say what was dropped.
  if (criteria.since) {
    terms.push(`received>=${criteria.since.slice(0, 10)}`);
    if (criteria.since.includes('T')) {
      notes.push(
        'The time of day on `since` was dropped: a text search compares received dates by ' +
          'whole days.',
      );
    }
  }
  if (criteria.until) {
    terms.push(`received<=${criteria.until.slice(0, 10)}`);
    if (criteria.until.includes('T')) {
      notes.push(
        'The time of day on `until` was dropped: a text search compares received dates by ' +
          'whole days.',
      );
    }
  }

  return terms.join(' ');
}

function buildFilter(criteria: SearchCriteria): string[] {
  const clauses: string[] = [];

  // Graph requires every property in `$orderby` to also appear in `$filter`,
  // and to appear before any clause on another property — otherwise the request
  // fails with 400 InefficientFilter. The query always orders by
  // receivedDateTime, so its clauses go first.
  if (criteria.since) clauses.push(`receivedDateTime ge ${criteria.since}`);
  if (criteria.until) clauses.push(`receivedDateTime le ${criteria.until}`);

  if (criteria.from?.trim()) {
    clauses.push(`from/emailAddress/address eq ${odataString(criteria.from.trim())}`);
  }
  if (criteria.subject?.trim()) {
    clauses.push(`contains(subject, ${odataString(criteria.subject.trim())})`);
  }
  if (criteria.hasAttachments) clauses.push('hasAttachments eq true');
  if (criteria.unreadOnly) clauses.push('isRead eq false');

  return clauses;
}

/**
 * Builds the query parameters for a message search.
 *
 * @param count maximum messages to request
 */
export function buildMailQuery(criteria: SearchCriteria, count: number): BuiltQuery {
  const notes: string[] = [];
  const params: Record<string, string | number> = {
    $top: count,
    $select: MESSAGE_LIST_SELECT,
  };

  const usesSearch = Boolean(criteria.query?.trim());

  if (usesSearch) {
    // The KQL is passed as one double-quoted parameter, so any double quote the
    // KQL itself carries (quoted multi-word values, quotes in the free text)
    // must be escaped or it terminates the wrapper early.
    params['$search'] = `"${buildKql(criteria, notes).replace(/"/g, '\\"')}"`;

    // Graph rejects $orderby alongside $search outright, and ignores $filter.
    // Saying so beats returning relevance-ordered results that look like the
    // newest ones.
    notes.push(
      'Ordered by relevance rather than date, because a text search was used — Graph does ' +
        'not allow sorting a search.',
    );

    if (criteria.unreadOnly) {
      notes.push(
        'The unread-only filter cannot be combined with a text search; results were not ' +
          'restricted to unread messages.',
      );
    }

    return { params, notes, relevanceOrdered: true };
  }

  const clauses = buildFilter(criteria);

  // Graph's rule for /messages: every property in `$orderby` must also appear
  // in `$filter`, before any clause on another property. A filter without a
  // receivedDateTime clause alongside this ordering is a 400 InefficientFilter,
  // so one that is always true is prepended. No clauses at all is fine — plain
  // `$orderby` needs no `$filter`.
  if (clauses.length > 0) {
    if (!clauses.some((clause) => clause.includes('receivedDateTime'))) {
      clauses.unshift('receivedDateTime ge 1900-01-01T00:00:00Z');
    }
    params['$filter'] = clauses.join(' and ');
  }

  // Ordering by the same property the filter ranges over is the combination Graph
  // reliably accepts.
  params['$orderby'] = 'receivedDateTime desc';

  if (criteria.to?.trim()) {
    notes.push(
      'Filtering by recipient is not supported without a text search; the `to` criterion ' +
        'was ignored. Pass it as `query` instead.',
    );
  }

  return { params, notes, relevanceOrdered: false };
}

/** True when any criterion beyond paging was supplied. */
export const hasCriteria = (criteria: SearchCriteria): boolean =>
  Boolean(
    criteria.query?.trim() ||
      criteria.from?.trim() ||
      criteria.to?.trim() ||
      criteria.subject?.trim() ||
      criteria.hasAttachments ||
      criteria.unreadOnly ||
      criteria.since ||
      criteria.until,
  );
