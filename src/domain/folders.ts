/**
 * Mail folders.
 *
 * Folders form a tree, and asking Graph for `/me/mailFolders` returns only the
 * top level. A lookup that stops there cannot find anything nested, which is why
 * "move it to Receipts" fails when Receipts lives under Inbox.
 *
 * So resolution works over a flattened tree, and understands three ways of
 * naming a folder: a well-known name, a path, or a plain name.
 */
import { resolveByName, type Resolution } from './resolve.js';

/** Graph's well-known folder names, and the aliases people actually type. */
const WELL_KNOWN_ALIASES: Readonly<Record<string, string>> = {
  inbox: 'inbox',
  drafts: 'drafts',
  draft: 'drafts',
  sent: 'sentitems',
  'sent items': 'sentitems',
  sentitems: 'sentitems',
  deleted: 'deleteditems',
  'deleted items': 'deleteditems',
  deleteditems: 'deleteditems',
  trash: 'deleteditems',
  bin: 'deleteditems',
  archive: 'archive',
  junk: 'junkemail',
  'junk email': 'junkemail',
  junkemail: 'junkemail',
  spam: 'junkemail',
  outbox: 'outbox',
  scheduled: 'scheduled',
};

/**
 * Maps a reference onto a Graph well-known folder name.
 *
 * These can be used in a path directly — `me/mailFolders/inbox` — so recognising
 * one saves enumerating the tree at all.
 */
export function wellKnownFolder(ref: string): string | undefined {
  return WELL_KNOWN_ALIASES[ref.trim().toLowerCase()];
}

/** A folder as Graph returns it. */
export interface FolderNode {
  readonly id: string;
  readonly displayName: string;
  readonly childFolderCount?: number | undefined;
  readonly childFolders?: readonly FolderNode[] | undefined;
}

/** A folder with its position in the tree. */
export interface FlatFolder {
  readonly id: string;
  readonly name: string;
  /** Slash-separated path from the root, e.g. "Inbox/Receipts/2026". */
  readonly path: string;
  readonly depth: number;
}

/** Flattens a folder tree, recording each folder's full path. */
export function flattenFolders(
  nodes: readonly FolderNode[],
  parentPath = '',
): FlatFolder[] {
  const flat: FlatFolder[] = [];

  for (const node of nodes) {
    const path = parentPath ? `${parentPath}/${node.displayName}` : node.displayName;
    flat.push({
      id: node.id,
      name: node.displayName,
      path,
      depth: path.split('/').length - 1,
    });
    if (node.childFolders?.length) {
      flat.push(...flattenFolders(node.childFolders, path));
    }
  }

  return flat;
}

/** True when a folder still has children that were never fetched. */
export const hasUnfetchedChildren = (node: FolderNode): boolean =>
  (node.childFolderCount ?? 0) > 0 && !node.childFolders;

/**
 * Resolves a folder reference against a flattened tree.
 *
 * Tried in order: an exact path (case-insensitive), then id / exact name /
 * unambiguous partial via the shared resolver. A path is checked first because
 * it is the only form that can disambiguate two folders sharing a name.
 */
export function resolveFolder(folders: readonly FlatFolder[], ref: string): Resolution<FlatFolder> {
  const needle = ref.trim().toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

  if (needle.includes('/')) {
    const byPath = folders.filter((folder) => folder.path.toLowerCase() === needle);
    if (byPath.length === 1) return { kind: 'matched', item: byPath[0] as FlatFolder };
    if (byPath.length === 0) {
      return {
        kind: 'none',
        message:
          `No folder at path "${ref}". Available paths: ` +
          `${folders.map((f) => `"${f.path}"`).join(', ')}.`,
      };
    }
  }

  return resolveByName(folders, ref, {
    id: (folder) => folder.id,
    name: (folder) => folder.name,
    label: 'folder',
    // Two folders can share a name at different depths, so describe by path.
    describe: (folder) => `"${folder.path}"`,
  });
}
