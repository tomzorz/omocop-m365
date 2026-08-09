import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { emailTools } from '../../src/tools/email.js';
import { runTool } from '../../src/server/tool.js';
import type { AnyToolDefinition } from '../../src/server/registry.js';
import { ALL_SCOPES, fakeGraph, on, testContext, textOf } from '../support/fake-graph.js';

const tool = (name: string): AnyToolDefinition => {
  const found = emailTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

async function call(
  name: string,
  args: Record<string, unknown>,
  ...responders: Parameters<typeof fakeGraph>
) {
  const fake = fakeGraph(...responders);
  const result = await runTool(tool(name), args as never, testContext(fake.graph), ALL_SCOPES);
  return { ...fake, result, text: textOf(result) };
}

const MESSAGE = {
  id: 'msg1',
  subject: 'Q3 numbers',
  from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
  toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
  receivedDateTime: '2026-08-05T09:00:00Z',
  bodyPreview: 'Here are the numbers you asked for',
  hasAttachments: true,
  isRead: false,
};

const FOLDER_TREE = {
  items: [
    { id: 'inbox-id', displayName: 'Inbox', childFolderCount: 1 },
    { id: 'projects-id', displayName: 'Projects', childFolderCount: 0 },
  ],
  truncated: false,
};

const INBOX_CHILDREN = {
  items: [{ id: 'receipts-id', displayName: 'Receipts', childFolderCount: 0 }],
  truncated: false,
};

/**
 * Path matching has to be exact here: `me/mailFolders` is a prefix of
 * `me/mailFolders/{id}/childFolders`, so a loose match feeds the root listing
 * back as its own children and every folder appears twice.
 */
const folderTreeResponders = [
  (c: { method: string; path: string }) =>
    c.method === 'COLLECT' && c.path === 'me/mailFolders' ? FOLDER_TREE : undefined,
  (c: { method: string; path: string }) =>
    c.method === 'COLLECT' && c.path === 'me/mailFolders/inbox-id/childFolders'
      ? INBOX_CHILDREN
      : undefined,
];

describe('list-emails', () => {
  test('lists messages with sender, date, unread and attachment markers', async () => {
    const { text } = await call(
      'list-emails',
      {},
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: false }),
    );
    expect(text).toContain('Q3 numbers');
    expect(text).toContain('[unread]');
    expect(text).toContain('[attachments]');
    expect(text).toContain('Alice <alice@example.com>');
    expect(text).toContain('ID: msg1');
  });

  /**
   * Graph rejects `$filter=isRead eq false` next to `$orderby=receivedDateTime`
   * with 400 InefficientFilter: every $orderby property must lead the $filter.
   * The fake enforces the same rule, so this passing means the shape is legal.
   */
  test('unreadOnly filters with the orderby property leading the filter', async () => {
    const { result, of } = await call(
      'list-emails',
      { unreadOnly: true },
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: false }),
    );
    expect(result.isError).toBeUndefined();
    const filter = String(of('COLLECT')[0]?.query?.['$filter']);
    expect(filter).toMatch(/^receivedDateTime ge /);
    expect(filter).toContain('isRead eq false');
  });

  test('uses a well-known folder name directly, without walking the tree', async () => {
    const { find, of } = await call(
      'list-emails',
      { folder: 'inbox' },
      on('COLLECT', 'mailFolders/inbox/messages', { items: [], truncated: false }),
    );
    expect(find('mailFolders/inbox/messages')).toBeDefined();
    expect(of('COLLECT').some((c) => c.path === 'me/mailFolders')).toBe(false);
  });

  test('maps an alias onto the well-known name', async () => {
    const { find } = await call(
      'list-emails',
      { folder: 'trash' },
      on('COLLECT', 'deleteditems', { items: [], truncated: false }),
    );
    expect(find('mailFolders/deleteditems/messages')).toBeDefined();
  });

  test('walks the tree for a user folder', async () => {
    const { find } = await call(
      'list-emails',
      { folder: 'Projects' },
      ...folderTreeResponders,
      on('COLLECT', 'projects-id/messages', { items: [], truncated: false }),
    );
    expect(find('mailFolders/projects-id/messages')).toBeDefined();
  });

  /**
   * A well-known name wins over a user folder of the same name. Graph's own
   * "archive" resolves to the folder shown as Archive, so this is both cheaper
   * and what someone asking for "archive" almost always means.
   */
  test('a well-known name takes precedence over a same-named user folder', async () => {
    const { find, of } = await call(
      'list-emails',
      { folder: 'Archive' },
      ...folderTreeResponders,
      on('COLLECT', 'mailFolders/archive/messages', { items: [], truncated: false }),
    );
    expect(find('mailFolders/archive/messages')).toBeDefined();
    expect(of('COLLECT').some((c) => c.path === 'me/mailFolders')).toBe(false);
  });

  test('finds a nested folder the top level would miss', async () => {
    const { find } = await call(
      'list-emails',
      { folder: 'Receipts' },
      ...folderTreeResponders,
      on('COLLECT', 'receipts-id/messages', { items: [], truncated: false }),
    );
    expect(find('mailFolders/receipts-id/messages')).toBeDefined();
  });

  test('resolves a nested folder by path', async () => {
    const { find } = await call(
      'list-emails',
      { folder: 'Inbox/Receipts' },
      ...folderTreeResponders,
      on('COLLECT', 'receipts-id/messages', { items: [], truncated: false }),
    );
    expect(find('mailFolders/receipts-id/messages')).toBeDefined();
  });

  test('refuses an unknown folder without listing anything', async () => {
    const { text, of } = await call(
      'list-emails',
      { folder: 'Nonexistent' },
      ...folderTreeResponders,
    );
    expect(text).toContain('No folder matching');
    expect(of('COLLECT').some((c) => c.path.includes('messages'))).toBe(false);
  });

  test('admits truncation', async () => {
    const { text } = await call(
      'list-emails',
      { count: 1 },
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: true }),
    );
    expect(text).toContain('More messages exist');
  });

  test('says so when there are none', async () => {
    const { text } = await call(
      'list-emails',
      {},
      on('COLLECT', 'me/messages', { items: [], truncated: false }),
    );
    expect(text).toContain('No messages');
  });
});

describe('search-emails', () => {
  test('warns that a text search is relevance-ordered', async () => {
    const { text, of } = await call(
      'search-emails',
      { query: 'invoice' },
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: false }),
    );
    expect(of('COLLECT')[0]?.query?.['$search']).toBe('"invoice"');
    expect(of('COLLECT')[0]?.query?.['$orderby']).toBeUndefined();
    expect(text).toContain('by relevance');
    expect(text).toContain('Note: Ordered by relevance');
  });

  test('a criteria-only search is filtered and sorted', async () => {
    const { of, text } = await call(
      'search-emails',
      { from: 'alice@example.com' },
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: false }),
    );
    expect(of('COLLECT')[0]?.query?.['$orderby']).toBe('receivedDateTime desc');
    expect(String(of('COLLECT')[0]?.query?.['$filter'])).toContain('alice@example.com');
    expect(text).toContain('newest first');
  });

  test('reports a criterion that could not be applied', async () => {
    const { text } = await call(
      'search-emails',
      { query: 'x', unreadOnly: true },
      on('COLLECT', 'me/messages', { items: [MESSAGE], truncated: false }),
    );
    expect(text).toContain('unread-only filter cannot be combined');
  });

  /**
   * The not-applied note must survive an empty result — that is exactly when
   * "no unread matches" would otherwise be read into a search that never
   * filtered on unread at all.
   */
  test('an empty result still reports a criterion that was not applied', async () => {
    const { text } = await call(
      'search-emails',
      { query: 'x', unreadOnly: true },
      on('COLLECT', 'me/messages', { items: [], truncated: false }),
    );
    expect(text).toContain('No messages');
    expect(text).toContain('unread-only filter cannot be combined');
  });

  /**
   * `since`/`until` end up interpolated into an OData `$filter`, so the input
   * schema — which the MCP SDK enforces before the handler runs — must reject
   * anything that is not an ISO 8601 date or datetime. A value smuggling in a
   * filter fragment never reaches Graph.
   */
  test('a malformed since is rejected by input validation, before any Graph call', () => {
    const schema = z.object(tool('search-emails').input as z.ZodRawShape);
    const parsed = schema.safeParse({
      since: "2026-08-01T00:00:00Z and from/emailAddress/address eq 'x'",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain('ISO 8601');
    }
  });

  test('well-formed since and until values pass input validation', () => {
    const schema = z.object(tool('search-emails').input as z.ZodRawShape);
    for (const value of ['2026-08-01', '2026-08-01T09:30', '2026-08-01T09:30:00Z', '2026-08-01T09:30:00.123+02:00']) {
      expect(schema.safeParse({ since: value, until: value }).success, value).toBe(true);
    }
  });

  test('a non-date criterion still yields a filter starting with receivedDateTime', async () => {
    const { of } = await call(
      'search-emails',
      { unreadOnly: true },
      on('COLLECT', 'me/messages', { items: [], truncated: false }),
    );
    expect(String(of('COLLECT')[0]?.query?.['$filter'])).toMatch(/^receivedDateTime ge /);
  });
});

describe('read-email', () => {
  test('converts an HTML body to Markdown, keeping link destinations', async () => {
    const { text, result } = await call(
      'read-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', {
        ...MESSAGE,
        body: {
          contentType: 'html',
          content: '<h2>Report</h2><p>See <a href="https://example.test/r">the report</a>.</p>',
        },
      }),
    );

    expect(text).toContain('## Report');
    expect(text).toContain('[the report](https://example.test/r)');
    expect((result.structuredContent as { body: string }).body).toContain('## Report');
  });

  test('records inline images with their cid', async () => {
    const { result } = await call(
      'read-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', {
        ...MESSAGE,
        body: { contentType: 'html', content: '<img src="cid:logo@x" alt="logo">' },
      }),
    );
    expect((result.structuredContent as { images: unknown[] }).images)
      .toEqual([{ src: 'cid:logo@x', alt: 'logo' }]);
  });

  test('passes a plain-text body through', async () => {
    const { text } = await call(
      'read-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', {
        ...MESSAGE,
        body: { contentType: 'text', content: 'plain words' },
      }),
    );
    expect(text).toContain('plain words');
  });

  test('shows headers and points at list-attachments', async () => {
    const { text } = await call(
      'read-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', { ...MESSAGE, body: { contentType: 'text', content: 'x' } }),
    );
    expect(text).toContain('From: Alice <alice@example.com>');
    expect(text).toContain('Subject: Q3 numbers');
    expect(text).toContain('use list-attachments');
  });
});

describe('mark-as-read and delete-email', () => {
  test('mark-as-read patches isRead', async () => {
    const { of, text } = await call(
      'mark-as-read',
      { id: 'msg1' },
      on('PATCH', 'me/messages/msg1', { subject: 'Q3 numbers' }),
    );
    expect(of('PATCH')[0]?.body).toEqual({ isRead: true });
    expect(text).toContain('marked as read');
  });

  test('mark-as-read can mark unread', async () => {
    const { of } = await call(
      'mark-as-read',
      { id: 'msg1', isRead: false },
      on('PATCH', 'me/messages/msg1', {}),
    );
    expect(of('PATCH')[0]?.body).toEqual({ isRead: false });
  });

  test('delete-email moves to Deleted Items by default', async () => {
    const { of, text } = await call(
      'delete-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', { id: 'msg1', subject: 'Q3 numbers' }),
    );
    expect(of('POST')[0]?.path).toBe('me/messages/msg1/move');
    expect(of('POST')[0]?.body).toEqual({ destinationId: 'deleteditems' });
    expect(of('DELETE')).toHaveLength(0);
    expect(text).toContain('moved to Deleted Items');
  });

  /**
   * A soft delete is a move, and a move changes the message id — the response
   * must hand back the id that is still valid, and say the old one is not.
   */
  test('delete-email returns the post-move id and warns the id changed', async () => {
    const { text, result } = await call(
      'delete-email',
      { id: 'msg1' },
      on('GET', 'me/messages/msg1', { id: 'msg1', subject: 'Q3 numbers' }),
      on('POST', '/move', { id: 'msg1-in-trash' }),
    );
    const data = result.structuredContent as { id: string; newId?: string };
    expect(data.newId).toBe('msg1-in-trash');
    expect(data.newId).not.toBe(data.id);
    expect(text).toContain('changes its id');
    expect(text).toContain('msg1-in-trash');
  });

  test('delete-email removes outright when asked', async () => {
    const { of, text } = await call(
      'delete-email',
      { id: 'msg1', permanent: true },
      on('GET', 'me/messages/msg1', { id: 'msg1', subject: 'Q3 numbers' }),
    );
    expect(of('DELETE')).toHaveLength(1);
    expect(of('POST')).toHaveLength(0);
    expect(text).toContain('permanently deleted');
  });
});

describe('draft-email', () => {
  test('creates a draft and says nothing was sent', async () => {
    const { of, text } = await call(
      'draft-email',
      { to: 'a@example.com, b@example.com', subject: 'Hello', body: 'text' },
      on('POST', 'me/messages', { id: 'draft1', subject: 'Hello' }),
    );

    const body = of('POST')[0]?.body as { toRecipients: unknown[]; body: { contentType: string } };
    expect(body.toRecipients).toHaveLength(2);
    expect(body.body.contentType).toBe('Text');
    expect(text).toContain('Nothing has been sent');
    expect(text).toContain('Draft ID: draft1');
  });

  test('detects HTML in the body', async () => {
    const { of } = await call(
      'draft-email',
      { subject: 'x', body: '<p>hello</p>' },
      on('POST', 'me/messages', { id: 'd', subject: 'x' }),
    );
    expect((of('POST')[0]?.body as { body: { contentType: string } }).body.contentType).toBe('HTML');
  });

  test('splits addresses on commas and semicolons', async () => {
    const { of } = await call(
      'draft-email',
      { to: 'a@x.com; b@x.com , c@x.com', subject: 's' },
      on('POST', 'me/messages', { id: 'd' }),
    );
    expect((of('POST')[0]?.body as { toRecipients: unknown[] }).toRecipients).toHaveLength(3);
  });

  /**
   * "Name <address>" as a literal address is rejected by Graph at send time —
   * the address goes in the address field, the name in the name field.
   */
  test('parses "Name <address>" into address plus display name', async () => {
    const { of } = await call(
      'draft-email',
      { to: 'Bob Smith <bob@x.com>, alice@x.com', subject: 's' },
      on('POST', 'me/messages', { id: 'd' }),
    );
    expect((of('POST')[0]?.body as { toRecipients: unknown[] }).toRecipients).toEqual([
      { emailAddress: { address: 'bob@x.com', name: 'Bob Smith' } },
      { emailAddress: { address: 'alice@x.com' } },
    ]);
  });

  test('a comma inside a quoted display name does not split the entry', async () => {
    const { of } = await call(
      'draft-email',
      { to: '"Smith, Bob" <bob@x.com>, alice@x.com', subject: 's' },
      on('POST', 'me/messages', { id: 'd' }),
    );
    expect((of('POST')[0]?.body as { toRecipients: unknown[] }).toRecipients).toEqual([
      { emailAddress: { address: 'bob@x.com', name: 'Smith, Bob' } },
      { emailAddress: { address: 'alice@x.com' } },
    ]);
  });
});

describe('send-draft', () => {
  const draft = {
    id: 'draft1',
    subject: 'Quarterly numbers',
    isDraft: true,
    toRecipients: [{ emailAddress: { address: 'boss@example.com' } }],
    bccRecipients: [{ emailAddress: { address: 'quiet@example.com' } }],
  };

  test('sends and names every recipient, including BCC', async () => {
    const { of, text } = await call(
      'send-draft',
      { messageId: 'draft1' },
      on('GET', 'me/messages/draft1', draft),
    );
    expect(of('POST')[0]?.path).toBe('me/messages/draft1/send');
    expect(text).toContain('To: boss@example.com');
    expect(text).toContain('BCC: quiet@example.com');
  });

  test('refuses an already-sent message without re-sending', async () => {
    const { of, text } = await call(
      'send-draft',
      { messageId: 'sent1' },
      on('GET', 'me/messages/sent1', { ...draft, isDraft: false }),
    );
    expect(text).toContain('already been sent');
    expect(of('POST')).toHaveLength(0);
  });

  test('refuses a draft with no recipients', async () => {
    const { of, text } = await call(
      'send-draft',
      { messageId: 'draft1' },
      on('GET', 'me/messages/draft1', { ...draft, toRecipients: [], bccRecipients: [] }),
    );
    expect(text).toContain('no recipients');
    expect(of('POST')).toHaveLength(0);
  });
});

describe('send-email', () => {
  test('sends via sendMail and reports the recipients', async () => {
    const { of, text } = await call('send-email', {
      to: 'a@example.com',
      subject: 'Hi',
      body: 'text',
    });
    expect(of('POST')[0]?.path).toBe('me/sendMail');
    expect((of('POST')[0]?.body as { saveToSentItems: boolean }).saveToSentItems).toBe(true);
    expect(text).toContain('Sent "Hi"');
  });

  test('honours saveToSentItems false and says so', async () => {
    const { of, text } = await call('send-email', {
      to: 'a@example.com',
      subject: 'Hi',
      body: 'x',
      saveToSentItems: false,
    });
    expect((of('POST')[0]?.body as { saveToSentItems: boolean }).saveToSentItems).toBe(false);
    expect(text).toContain('Not saved to Sent Items');
  });

  test('refuses an empty recipient list', async () => {
    const { of, text } = await call('send-email', { to: '  ', subject: 'x', body: 'y' });
    expect(text).toContain('At least one recipient');
    expect(of('POST')).toHaveLength(0);
  });
});

describe('the tool set', () => {
  test('sending tools declare Mail.Send and are marked destructive', () => {
    for (const name of ['send-email', 'send-draft']) {
      expect(tool(name).scopes).toContain('Mail.Send');
      expect(tool(name).annotations?.destructiveHint).toBe(true);
    }
  });

  test('draft-email needs no send scope, because it sends nothing', () => {
    expect(tool('draft-email').scopes).not.toContain('Mail.Send');
  });

  test('send-draft declares the read scope its pre-send GET needs', () => {
    // The handler reads the draft before sending, and Mail.Send does not
    // imply Mail.Read.
    expect(tool('send-draft').scopes).toContain('Mail.Read');
  });

  test('read-only tools are annotated', () => {
    for (const name of ['list-emails', 'search-emails', 'read-email']) {
      expect(tool(name).annotations?.readOnlyHint).toBe(true);
    }
  });
});
