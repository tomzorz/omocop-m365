/**
 * Shared machinery for the mail tools.
 *
 * The interesting part is folder resolution. Asking Graph for `/me/mailFolders`
 * returns the top level only, so a lookup that stops there cannot find anything
 * nested — which is why "move it to Receipts" fails when Receipts lives inside
 * Inbox. The tree is walked to a bounded depth and flattened, and the decision
 * about what a name means is made by the pure resolver in `domain/`.
 */
import { z } from 'zod';
import type { GraphClient } from '../graph/client.js';
import { gpath } from '../graph/path.js';
import {
  flattenFolders,
  hasUnfetchedChildren,
  resolveFolder,
  wellKnownFolder,
  type FlatFolder,
  type FolderNode,
} from '../domain/folders.js';
import type { ToolContext, ToolPolicy } from '../server/tool.js';

/** How deep the folder tree is walked before giving up. */
const MAX_FOLDER_DEPTH = 4;

const FOLDER_SELECT = 'id,displayName,childFolderCount,totalItemCount,unreadItemCount';

export const FOLDER_ARG = z
  .string()
  .describe(
    'Folder name, path ("Inbox/Receipts"), or id. Well-known names work: inbox, drafts, ' +
      'sent, archive, junk, trash. Omit for the whole mailbox.',
  );

/**
 * Fetches the folder tree, descending into folders that report children.
 *
 * `$expand=childFolders` only reaches one level, so this recurses — bounded,
 * because a pathological mailbox should slow a tool down rather than hang it.
 */
export async function fetchFolderTree(
  graph: GraphClient,
  depth = MAX_FOLDER_DEPTH,
): Promise<FolderNode[]> {
  const load = async (path: string, remaining: number): Promise<FolderNode[]> => {
    const { items } = await graph.collect<FolderNode>(path, { $select: FOLDER_SELECT });
    if (remaining <= 0) return items;

    return Promise.all(
      items.map(async (node) => {
        if (!hasUnfetchedChildren(node)) return node;
        const children = await load(gpath`me/mailFolders/${node.id}/childFolders`, remaining - 1);
        return { ...node, childFolders: children };
      }),
    );
  };

  return load('me/mailFolders', depth);
}

/** Flattened folders, cached for the life of one tool call. */
export async function fetchFlatFolders(graph: GraphClient): Promise<FlatFolder[]> {
  return flattenFolders(await fetchFolderTree(graph));
}

/** Message collection path, scoped to a folder when one is given. */
export const messagesPath = (folderId: string | null): string =>
  folderId ? gpath`me/mailFolders/${folderId}/messages` : 'me/messages';

/** A single message. */
export const messagePath = (messageId: string): string => gpath`me/messages/${messageId}`;

const FOLDER_KEY = Symbol('email.folder');

/** What {@link requireFolder} resolved: null means the whole mailbox. */
export interface ResolvedFolder {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export function resolvedFolder(ctx: ToolContext): ResolvedFolder | null {
  return (ctx.resolved.get(FOLDER_KEY) as ResolvedFolder | null | undefined) ?? null;
}

/**
 * Resolves a folder argument before the handler runs.
 *
 * A well-known name is used directly — Graph accepts `me/mailFolders/inbox` — so
 * the common case costs no extra calls. Anything else walks the tree.
 *
 * @param argName which argument holds the reference
 * @param required refuse when the argument is absent
 */
export function requireFolder(
  argName: string,
  options: { required: boolean } = { required: false },
): ToolPolicy<Record<string, unknown>> {
  return async (args, ctx) => {
    const ref = args[argName];

    if (ref === undefined || ref === null || String(ref).trim() === '') {
      if (options.required) {
        return { refuse: `A ${argName} is required. Use list-folders to see the options.` };
      }
      return { proceed: true, key: FOLDER_KEY, value: null };
    }

    const reference = String(ref).trim();

    const wellKnown = wellKnownFolder(reference);
    if (wellKnown) {
      return {
        proceed: true,
        key: FOLDER_KEY,
        value: { id: wellKnown, name: reference, path: reference },
      };
    }

    const resolution = resolveFolder(await fetchFlatFolders(ctx.graph), reference);
    if (resolution.kind !== 'matched') return { refuse: resolution.message };

    return {
      proceed: true,
      key: FOLDER_KEY,
      value: {
        id: resolution.item.id,
        name: resolution.item.name,
        path: resolution.item.path,
      },
    };
  };
}

/* -------------------------------------------------------------------------- */

/** Graph's recipient shape. */
export interface Recipient {
  readonly emailAddress: { readonly address: string; readonly name?: string };
}

/** Splits a comma or semicolon separated address list. */
export function toRecipients(value: string | readonly string[] | undefined): Recipient[] {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return parts
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

/** Addresses from a Graph recipient list, for display. */
export const addressesOf = (
  list: ReadonlyArray<{ emailAddress?: { address?: string } }> | undefined,
): string[] =>
  (list ?? []).map((r) => r.emailAddress?.address).filter((a): a is string => Boolean(a));

/** A sender as "Name <address>", or just the address. */
export function describeSender(
  from: { emailAddress?: { name?: string; address?: string } } | undefined,
): string {
  const address = from?.emailAddress?.address;
  const name = from?.emailAddress?.name;
  if (!address) return 'unknown sender';
  return name && name !== address ? `${name} <${address}>` : address;
}

/** Decides the Graph content type for an outgoing body. */
export function bodyFor(content: string, isHtml: boolean | undefined): {
  contentType: 'HTML' | 'Text';
  content: string;
} {
  const html = isHtml ?? /<html|<body|<p[\s>]|<div[\s>]/i.test(content);
  return { contentType: html ? 'HTML' : 'Text', content };
}
