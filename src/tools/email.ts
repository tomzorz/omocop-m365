/**
 * Mail tools.
 *
 * Sending is the one irreversible, outward-facing thing this server does, and
 * the tool set is shaped around that: `draft-email` composes without sending,
 * `send-draft` sends something that already exists and can be looked at first,
 * and `send-email` — which does both in one unreviewable step — says so in its
 * own description.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { AnyToolDefinition } from '../server/registry.js';
import { bodyToMarkdown } from '../html/markdown.js';
import {
  buildMailQuery,
  MESSAGE_DETAIL_SELECT,
  MESSAGE_LIST_SELECT,
} from '../domain/mail-query.js';
import {
  FOLDER_ARG,
  addressesOf,
  bodyFor,
  describeSender,
  messagePath,
  messagesPath,
  requireFolder,
  resolvedFolder,
  toRecipients,
} from './email-support.js';

const READ = 'Mail.Read';
const WRITE = 'Mail.ReadWrite';
const SEND = 'Mail.Send';

/**
 * `since`/`until` are interpolated verbatim into an OData `$filter`, so their
 * shape is enforced here: only an ISO 8601 date or datetime can pass through,
 * never an arbitrary filter fragment.
 */
const ISO_INSTANT = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/,
    'Expected an ISO 8601 date or datetime: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]][Z|±HH:MM].',
  );

interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  bccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  importance?: string;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string;
}

const MessageSummary = z.object({
  id: z.string(),
  subject: z.string(),
  from: z.string(),
  received: z.string(),
  preview: z.string(),
  unread: z.boolean(),
  hasAttachments: z.boolean(),
});

const summarise = (message: GraphMessage) => ({
  id: message.id,
  subject: message.subject ?? '(no subject)',
  from: describeSender(message.from),
  received: message.receivedDateTime ?? '',
  preview: (message.bodyPreview ?? '').slice(0, 200),
  unread: message.isRead === false,
  hasAttachments: message.hasAttachments === true,
});

const renderList = (
  messages: ReadonlyArray<z.infer<typeof MessageSummary>>,
  heading: string,
  notes: readonly string[],
): string => {
  // Notes must survive an empty result: "the unread filter was not applied" is
  // most misleading exactly when nothing came back.
  const noteBlock = notes.length ? `\n\n${notes.map((n) => `Note: ${n}`).join('\n')}` : '';

  if (messages.length === 0) return `No messages ${heading}.${noteBlock}`;

  const lines = messages.map((message, index) =>
    [
      `${index + 1}. ${message.subject}${message.unread ? '  [unread]' : ''}` +
        `${message.hasAttachments ? '  [attachments]' : ''}`,
      `   From: ${message.from}`,
      `   ${message.received.slice(0, 16).replace('T', ' ')}`,
      message.preview ? `   ${message.preview.replace(/\s+/g, ' ').trim()}` : '',
      `   ID: ${message.id}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return `${messages.length} message(s) ${heading}:\n\n${lines.join('\n\n')}${noteBlock}`;
};

/* -------------------------------------------------------------------------- */

const listEmails = defineTool({
  name: 'list-emails',
  title: 'List emails',
  description: 'Lists recent messages, newest first, optionally from one folder.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {
    folder: FOLDER_ARG.optional(),
    count: z.number().int().min(1).max(50).optional().describe('Default 10'),
    unreadOnly: z.boolean().optional(),
  },
  output: {
    messages: z.array(MessageSummary),
    folder: z.string().optional(),
    truncated: z.boolean(),
  },
  policies: [requireFolder('folder')],
  handler: async (args, ctx) => {
    const folder = resolvedFolder(ctx);
    const count = args.count ?? 10;

    const { items, truncated } = await ctx.graph.collect<GraphMessage>(
      messagesPath(folder?.id ?? null),
      {
        $top: count,
        $select: MESSAGE_LIST_SELECT,
        $orderby: 'receivedDateTime desc',
        // Graph requires every $orderby property to appear in $filter before any
        // clause on another property, or the request 400s with InefficientFilter
        // — hence the always-true receivedDateTime clause in front of isRead.
        ...(args.unreadOnly
          ? { $filter: 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false' }
          : {}),
      },
      count,
    );

    return {
      messages: items.map(summarise),
      ...(folder ? { folder: folder.path } : {}),
      truncated,
    };
  },
  render: (data) =>
    renderList(
      data.messages,
      `in ${data.folder ?? 'the mailbox'}`,
      data.truncated ? ['More messages exist — raise count or narrow the folder.'] : [],
    ),
});

/* -------------------------------------------------------------------------- */

const searchEmails = defineTool({
  name: 'search-emails',
  title: 'Search emails',
  description:
    'Searches messages. Passing `query` performs a full-text search, which Graph orders by ' +
    'relevance and cannot combine with sorting or unread filtering — the response says when ' +
    'that applied. Without `query`, criteria become a filter sorted newest first.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {
    query: z.string().optional().describe('Free text; searches subject, body and participants'),
    from: z.string().optional().describe('Sender address'),
    to: z.string().optional().describe('Recipient address; needs `query` to take effect'),
    subject: z.string().optional(),
    hasAttachments: z.boolean().optional(),
    unreadOnly: z.boolean().optional(),
    since: ISO_INSTANT.optional().describe('ISO 8601 lower bound on received time'),
    until: ISO_INSTANT.optional().describe('ISO 8601 upper bound'),
    folder: FOLDER_ARG.optional(),
    count: z.number().int().min(1).max(50).optional().describe('Default 10'),
  },
  output: {
    messages: z.array(MessageSummary),
    folder: z.string().optional(),
    notes: z.array(z.string()),
    relevanceOrdered: z.boolean(),
    truncated: z.boolean(),
  },
  policies: [requireFolder('folder')],
  handler: async (args, ctx) => {
    const folder = resolvedFolder(ctx);
    const count = args.count ?? 10;
    const built = buildMailQuery(args, count);

    const { items, truncated } = await ctx.graph.collect<GraphMessage>(
      messagesPath(folder?.id ?? null),
      built.params,
      count,
    );

    return {
      messages: items.map(summarise),
      ...(folder ? { folder: folder.path } : {}),
      notes: [...built.notes],
      relevanceOrdered: built.relevanceOrdered,
      truncated,
    };
  },
  render: (data) =>
    renderList(
      data.messages,
      `matching in ${data.folder ?? 'the mailbox'}` +
        (data.relevanceOrdered ? ', by relevance' : ', newest first'),
      data.truncated ? [...data.notes, 'More matches exist — raise count.'] : data.notes,
    ),
});

/* -------------------------------------------------------------------------- */

const readEmail = defineTool({
  name: 'read-email',
  title: 'Read an email',
  description:
    'Reads a message. The body comes back as Markdown, which keeps headings, lists and — ' +
    'most usefully — where each link actually goes. Images are kept as Markdown references ' +
    'whose cid values match the inline attachments on the same message.',
  scopes: [READ],
  annotations: { readOnlyHint: true },
  input: {
    id: z.string().describe('Message id, from a list or search result'),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    received: z.string(),
    importance: z.string(),
    unread: z.boolean(),
    isDraft: z.boolean(),
    hasAttachments: z.boolean(),
    body: z.string(),
    images: z.array(z.object({ src: z.string(), alt: z.string() })),
    webLink: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const message = await ctx.graph.get<GraphMessage>(messagePath(args.id), {
      $select: MESSAGE_DETAIL_SELECT,
    });

    const converted = bodyToMarkdown(message.body?.content, message.body?.contentType);

    return {
      id: message.id,
      subject: message.subject ?? '(no subject)',
      from: describeSender(message.from),
      to: addressesOf(message.toRecipients),
      cc: addressesOf(message.ccRecipients),
      received: message.receivedDateTime ?? '',
      importance: message.importance ?? 'normal',
      unread: message.isRead === false,
      isDraft: message.isDraft === true,
      hasAttachments: message.hasAttachments === true,
      body: converted.markdown || (message.bodyPreview ?? ''),
      images: converted.images.map((image) => ({ src: image.src, alt: image.alt })),
      ...(message.webLink ? { webLink: message.webLink } : {}),
    };
  },
  render: (data) =>
    [
      `From: ${data.from}`,
      `To: ${data.to.join(', ') || '(none)'}`,
      data.cc.length ? `CC: ${data.cc.join(', ')}` : '',
      `Subject: ${data.subject}`,
      `Date: ${data.received.slice(0, 16).replace('T', ' ')}`,
      data.importance !== 'normal' ? `Importance: ${data.importance}` : '',
      data.hasAttachments ? 'Attachments: yes — use list-attachments to see them' : '',
      '',
      data.body || '(empty message)',
    ]
      .filter((line) => line !== '')
      .join('\n'),
});

/* -------------------------------------------------------------------------- */

const markAsRead = defineTool({
  name: 'mark-as-read',
  title: 'Mark an email read or unread',
  description:
    'Marks a message as read, or as unread with isRead:false. Marking read is visible ' +
    'nowhere but this mailbox, so it is safe to use freely while triaging.',
  scopes: [WRITE],
  annotations: { idempotentHint: true },
  input: {
    id: z.string(),
    isRead: z.boolean().optional().describe('Default true'),
  },
  output: { id: z.string(), subject: z.string(), isRead: z.boolean() },
  handler: async (args, ctx) => {
    const isRead = args.isRead ?? true;
    const updated = await ctx.graph.patch<GraphMessage>(messagePath(args.id), { isRead });
    return { id: args.id, subject: updated.subject ?? args.id, isRead };
  },
  render: (data) => `"${data.subject}" marked as ${data.isRead ? 'read' : 'unread'}.`,
});

/* -------------------------------------------------------------------------- */

const deleteEmail = defineTool({
  name: 'delete-email',
  title: 'Delete an email',
  description:
    'Moves a message to Deleted Items, or removes it permanently with permanent:true. ' +
    'A permanent delete cannot be undone.',
  scopes: [WRITE],
  annotations: { destructiveHint: true },
  input: {
    id: z.string(),
    permanent: z
      .boolean()
      .optional()
      .describe('Delete outright instead of moving to Deleted Items. Default false.'),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    permanent: z.boolean(),
    /** The id after a soft delete — moving a message changes its id. */
    newId: z.string().optional(),
  },
  handler: async (args, ctx) => {
    const message = await ctx.graph.get<GraphMessage>(messagePath(args.id), {
      $select: 'id,subject',
    });

    let newId: string | undefined;
    if (args.permanent) {
      await ctx.graph.delete(messagePath(args.id));
    } else {
      // The move response is the moved message, carrying the new id the old
      // one is no longer valid for.
      const movedTo = await ctx.graph.post<{ id?: string }>(`${messagePath(args.id)}/move`, {
        destinationId: 'deleteditems',
      });
      newId = movedTo.id;
    }

    return {
      id: args.id,
      subject: message.subject ?? args.id,
      permanent: args.permanent === true,
      ...(newId ? { newId } : {}),
    };
  },
  render: (data) =>
    data.permanent
      ? `"${data.subject}" has been permanently deleted.`
      : `"${data.subject}" has been moved to Deleted Items.\n` +
        `Note: moving a message changes its id${data.newId ? ` — it is now ${data.newId}` : ''}.`,
});

/* -------------------------------------------------------------------------- */

const draftEmail = defineTool({
  name: 'draft-email',
  title: 'Create a draft',
  description:
    'Creates a draft without sending it. Nothing leaves the mailbox until send-draft is ' +
    'called, so this is the safe way to compose something that should be reviewed first. ' +
    'Returns a draft id for add-attachment and send-draft.',
  scopes: [WRITE],
  input: {
    to: z.string().optional().describe('Comma-separated addresses'),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    isHtml: z.boolean().optional().describe('Auto-detected from the body when omitted'),
    importance: z.enum(['low', 'normal', 'high']).optional(),
  },
  output: {
    id: z.string(),
    subject: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
  },
  handler: async (args, ctx) => {
    const to = toRecipients(args.to);
    const cc = toRecipients(args.cc);
    const bcc = toRecipients(args.bcc);

    const draft = await ctx.graph.post<GraphMessage>('me/messages', {
      subject: args.subject ?? '',
      body: bodyFor(args.body ?? '', args.isHtml),
      ...(to.length ? { toRecipients: to } : {}),
      ...(cc.length ? { ccRecipients: cc } : {}),
      ...(bcc.length ? { bccRecipients: bcc } : {}),
      importance: args.importance ?? 'normal',
    });

    return {
      id: draft.id,
      subject: draft.subject || args.subject || '(no subject)',
      to: to.map((r) => r.emailAddress.address),
      cc: cc.map((r) => r.emailAddress.address),
      bcc: bcc.map((r) => r.emailAddress.address),
    };
  },
  render: (data) =>
    `Draft created: "${data.subject}"\n` +
    `To: ${data.to.join(', ') || '(none yet)'}` +
    (data.cc.length ? `\nCC: ${data.cc.join(', ')}` : '') +
    (data.bcc.length ? `\nBCC: ${data.bcc.join(', ')}` : '') +
    `\nDraft ID: ${data.id}\n\nNothing has been sent. Use send-draft when it is ready.`,
});

/* -------------------------------------------------------------------------- */

const sendDraft = defineTool({
  name: 'send-draft',
  title: 'Send a draft',
  description:
    'Sends an existing draft. Irreversible and visible to the recipients — the response ' +
    'names everyone it went to, including BCC, so it can be checked against what was asked ' +
    'for. Pairs with draft-email for compose, review, send.',
  // READ as well as SEND: the handler reads the draft before sending, and
  // Mail.Send does not imply Mail.Read.
  scopes: [READ, SEND],
  annotations: { destructiveHint: true },
  input: { messageId: z.string().describe('Draft id from draft-email, or from list-emails on drafts') },
  output: {
    id: z.string(),
    subject: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    hadAttachments: z.boolean(),
  },
  handler: async (args, ctx) => {
    // Read it first: sending cannot be undone, so the response has to be able to
    // say exactly what went out and to whom.
    const draft = await ctx.graph.get<GraphMessage>(messagePath(args.messageId), {
      $select: 'id,subject,isDraft,toRecipients,ccRecipients,bccRecipients,hasAttachments',
    });

    if (draft.isDraft === false) {
      throw new Error(
        `"${draft.subject ?? args.messageId}" has already been sent — a message can only be ` +
          'sent once. Nothing was done.',
      );
    }

    const to = addressesOf(draft.toRecipients);
    const cc = addressesOf(draft.ccRecipients);
    const bcc = addressesOf(draft.bccRecipients);

    if (to.length + cc.length + bcc.length === 0) {
      throw new Error(
        `"${draft.subject ?? args.messageId}" has no recipients. Add them before sending.`,
      );
    }

    await ctx.graph.post(`${messagePath(args.messageId)}/send`, {});

    return {
      id: args.messageId,
      subject: draft.subject ?? '(no subject)',
      to,
      cc,
      bcc,
      hadAttachments: draft.hasAttachments === true,
    };
  },
  render: (data) =>
    `Sent "${data.subject}".\n` +
    `To: ${data.to.join(', ') || '(none)'}` +
    (data.cc.length ? `\nCC: ${data.cc.join(', ')}` : '') +
    (data.bcc.length ? `\nBCC: ${data.bcc.join(', ')}` : '') +
    (data.hadAttachments ? '\nAttachments were included.' : ''),
});

/* -------------------------------------------------------------------------- */

const sendEmail = defineTool({
  name: 'send-email',
  title: 'Compose and send an email',
  description:
    'Composes and sends immediately. Irreversible and visible to the recipients — there is ' +
    'no recall. For anything the user should see before it goes out, use draft-email, show ' +
    'them the draft, then send-draft.',
  scopes: [SEND],
  annotations: { destructiveHint: true },
  input: {
    to: z.string().describe('Comma-separated addresses'),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    isHtml: z.boolean().optional().describe('Auto-detected from the body when omitted'),
    importance: z.enum(['low', 'normal', 'high']).optional(),
    saveToSentItems: z.boolean().optional().describe('Default true'),
  },
  output: {
    subject: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    savedToSentItems: z.boolean(),
  },
  handler: async (args, ctx) => {
    const to = toRecipients(args.to);
    if (to.length === 0) throw new Error('At least one recipient is required.');

    const cc = toRecipients(args.cc);
    const bcc = toRecipients(args.bcc);
    const saveToSentItems = args.saveToSentItems ?? true;

    await ctx.graph.post('me/sendMail', {
      message: {
        subject: args.subject,
        body: bodyFor(args.body, args.isHtml),
        toRecipients: to,
        ...(cc.length ? { ccRecipients: cc } : {}),
        ...(bcc.length ? { bccRecipients: bcc } : {}),
        importance: args.importance ?? 'normal',
      },
      saveToSentItems,
    });

    return {
      subject: args.subject,
      to: to.map((r) => r.emailAddress.address),
      cc: cc.map((r) => r.emailAddress.address),
      bcc: bcc.map((r) => r.emailAddress.address),
      savedToSentItems: saveToSentItems,
    };
  },
  render: (data) =>
    `Sent "${data.subject}".\n` +
    `To: ${data.to.join(', ')}` +
    (data.cc.length ? `\nCC: ${data.cc.join(', ')}` : '') +
    (data.bcc.length ? `\nBCC: ${data.bcc.join(', ')}` : '') +
    (data.savedToSentItems ? '' : '\nNot saved to Sent Items.'),
});

export const emailTools: AnyToolDefinition[] = [
  listEmails,
  searchEmails,
  readEmail,
  markAsRead,
  deleteEmail,
  draftEmail,
  sendDraft,
  sendEmail,
];
