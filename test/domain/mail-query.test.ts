import { describe, expect, test } from 'vitest';
import { buildMailQuery, hasCriteria } from '../../src/domain/mail-query.js';

const build = (criteria: Parameters<typeof buildMailQuery>[0], count = 10) =>
  buildMailQuery(criteria, count);

describe('filter queries', () => {
  test('sort newest first when there is no text search', () => {
    const { params, relevanceOrdered } = build({});
    expect(params['$orderby']).toBe('receivedDateTime desc');
    expect(params['$search']).toBeUndefined();
    expect(relevanceOrdered).toBe(false);
  });

  test('build an OData filter from criteria', () => {
    const { params } = build({ from: 'alice@example.com', hasAttachments: true, unreadOnly: true });
    expect(params['$filter']).toBe(
      'receivedDateTime ge 1900-01-01T00:00:00Z and ' +
        "from/emailAddress/address eq 'alice@example.com' and hasAttachments eq true and " +
        'isRead eq false',
    );
  });

  /**
   * Graph requires every `$orderby` property to appear in `$filter` before any
   * other clause. Without a receivedDateTime clause, `isRead eq false` alone
   * alongside the ordering is a 400 InefficientFilter from live Graph.
   */
  test('a filter without a date criterion still starts with receivedDateTime', () => {
    const { params } = build({ unreadOnly: true });
    expect(String(params['$filter'])).toMatch(/^receivedDateTime ge 1900-01-01T00:00:00Z and /);
    expect(params['$orderby']).toBe('receivedDateTime desc');
  });

  test('date criteria come first, before clauses on other properties', () => {
    const { params } = build({ since: '2026-08-01T00:00:00Z', unreadOnly: true });
    expect(params['$filter']).toBe(
      'receivedDateTime ge 2026-08-01T00:00:00Z and isRead eq false',
    );
  });

  test('escape single quotes, which would otherwise break the filter', () => {
    const { params } = build({ from: "o'brien@example.com" });
    expect(params['$filter']).toContain("'o''brien@example.com'");
  });

  test('range over receivedDateTime, the same property it sorts by', () => {
    const { params } = build({ since: '2026-08-01T00:00:00Z', until: '2026-08-31T00:00:00Z' });
    expect(params['$filter']).toContain('receivedDateTime ge 2026-08-01T00:00:00Z');
    expect(params['$filter']).toContain('receivedDateTime le 2026-08-31T00:00:00Z');
    expect(params['$orderby']).toBe('receivedDateTime desc');
  });

  test('omit the filter entirely when nothing was asked for', () => {
    // Plain $orderby with no $filter is a combination Graph accepts; the
    // always-true clause is only needed once a filter exists.
    const { params } = build({});
    expect(params['$filter']).toBeUndefined();
    expect(params['$orderby']).toBe('receivedDateTime desc');
  });

  /** Filtering by recipient is not supported on the messages collection. */
  test('say so when `to` cannot be honoured, rather than ignoring it silently', () => {
    const { notes, params } = build({ to: 'bob@example.com' });
    expect(params['$filter']).toBeUndefined();
    expect(notes.join()).toContain('`to` criterion was ignored');
  });
});

describe('text search', () => {
  /**
   * The failure being designed out: Graph rejects $orderby alongside $search, and
   * code that catches the 400 returns the unfiltered inbox — a search that looks
   * like it worked and found the wrong things.
   */
  test('never combine $search with $orderby', () => {
    const { params } = build({ query: 'invoice' });
    expect(params['$search']).toBe('"invoice"');
    expect(params['$orderby']).toBeUndefined();
  });

  test('never combine $search with $filter', () => {
    const { params } = build({ query: 'invoice', from: 'alice@example.com' });
    expect(params['$filter']).toBeUndefined();
  });

  test('fold other criteria into KQL instead of dropping them', () => {
    const { params } = build({
      query: 'invoice',
      from: 'alice@example.com',
      subject: 'Q3 report',
      hasAttachments: true,
    });
    const search = String(params['$search']);
    expect(search).toContain('invoice');
    expect(search).toContain('from:alice@example.com');
    expect(search).toContain('subject:\\"Q3 report\\"');
    // KQL spells this singular, unlike the OData property.
    expect(search).toContain('hasattachment:true');
  });

  /**
   * The KQL travels inside one double-quoted $search parameter, so the quotes
   * KQL adds around a multi-word value must arrive backslash-escaped — bare,
   * they would terminate the wrapper mid-way.
   */
  test('quote KQL values containing spaces, escaped for the $search wrapper', () => {
    const search = String(build({ query: 'x', subject: 'two words' }).params['$search']);
    expect(search).toContain('subject:\\"two words\\"');
    expect(search).toMatch(/^"/);
    expect(search).toMatch(/[^\\]"$/);
    expect(String(build({ query: 'x', subject: 'oneword' }).params['$search']))
      .toContain('subject:oneword');
  });

  test('a double quote in the free text does not break the wrapper', () => {
    const search = String(build({ query: 'the "big" report' }).params['$search']);
    expect(search).toBe('"the \\"big\\" report"');
  });

  test('convert date bounds to KQL received terms', () => {
    const search = String(build({ query: 'x', since: '2026-08-01T00:00:00Z' }).params['$search']);
    expect(search).toContain('received>=2026-08-01');
  });

  /** Nothing is silently dropped — a truncated time-of-day is reported. */
  test('say so when truncating a date bound drops a time of day', () => {
    const { notes } = build({ query: 'x', since: '2026-08-01T14:30:00Z' });
    expect(notes.join()).toContain('time of day on `since` was dropped');
  });

  test('a date-only bound loses nothing, so no truncation note', () => {
    const { notes } = build({ query: 'x', until: '2026-08-31' });
    expect(notes.join()).not.toContain('dropped');
  });

  test('report that ordering is by relevance', () => {
    const { notes, relevanceOrdered } = build({ query: 'invoice' });
    expect(relevanceOrdered).toBe(true);
    expect(notes.join()).toContain('relevance rather than date');
  });

  test('report that unread-only could not be applied', () => {
    const { notes } = build({ query: 'invoice', unreadOnly: true });
    expect(notes.join()).toContain('unread-only filter cannot be combined');
  });

  test('treat whitespace-only query as no query', () => {
    const { params, relevanceOrdered } = build({ query: '   ', from: 'a@b.com' });
    expect(relevanceOrdered).toBe(false);
    expect(params['$filter']).toContain('a@b.com');
  });
});

describe('paging', () => {
  test('pass the count through and always select the list fields', () => {
    const { params } = build({}, 25);
    expect(params['$top']).toBe(25);
    expect(String(params['$select'])).toContain('receivedDateTime');
    expect(String(params['$select'])).not.toContain('body,');
  });
});

describe('hasCriteria', () => {
  test('false for an empty search', () => {
    expect(hasCriteria({})).toBe(false);
    expect(hasCriteria({ query: '  ' })).toBe(false);
  });

  test('true for any criterion', () => {
    expect(hasCriteria({ from: 'a@b.com' })).toBe(true);
    expect(hasCriteria({ hasAttachments: true })).toBe(true);
    expect(hasCriteria({ since: '2026-01-01' })).toBe(true);
  });
});
