/**
 * Turning a name a person typed into the thing they meant.
 *
 * Calendars, mail folders and attachments all have the same problem: the caller
 * has a human name and the API wants an opaque id. Solved three times it drifts
 * three ways — one accepts partial names, another does not, a third silently
 * picks the first of several matches.
 *
 * The rule, once:
 *
 *   1. An exact id wins outright.
 *   2. Otherwise an exact name, case-insensitively.
 *   3. Otherwise a partial name, but only if exactly one thing matches.
 *
 * Ambiguity is never resolved by guessing. Picking the first of several matches
 * is the behaviour that deletes the wrong folder.
 */

export type Resolution<T> =
  | { readonly kind: 'matched'; readonly item: T }
  | { readonly kind: 'none'; readonly message: string }
  | { readonly kind: 'ambiguous'; readonly matches: readonly T[]; readonly message: string };

export interface ResolveOptions<T> {
  /** Opaque identifier, compared exactly. */
  readonly id: (item: T) => string;
  /** Human name, compared case-insensitively. */
  readonly name: (item: T) => string;
  /** Singular noun for messages, e.g. "calendar". */
  readonly label: string;
  /** Overrides how a match is described; defaults to its quoted name. */
  readonly describe?: (item: T) => string;
}

/** Resolves a reference against a list, refusing rather than guessing. */
export function resolveByName<T>(
  items: readonly T[],
  ref: string,
  options: ResolveOptions<T>,
): Resolution<T> {
  const { id, name, label } = options;
  const describe = options.describe ?? ((item: T) => `"${name(item)}"`);
  const available = items.map(describe).join(', ');

  if (items.length === 0) {
    return { kind: 'none', message: `There are no ${label}s to match against.` };
  }

  const byId = items.find((item) => id(item) === ref);
  if (byId) return { kind: 'matched', item: byId };

  const needle = ref.trim().toLowerCase();
  if (!needle) {
    return { kind: 'none', message: `No ${label} name was given. Available: ${available}.` };
  }

  const exact = items.filter((item) => name(item).toLowerCase() === needle);
  if (exact.length === 1) return { kind: 'matched', item: exact[0] as T };
  if (exact.length > 1) {
    // Where a description tells them apart — a folder's path, say — offer that.
    // Graph ids are hundred-character base64 and are the last resort, not the
    // first thing to put in front of someone.
    const described = exact.map(describe);
    const distinguishable = new Set(described).size === described.length;

    return {
      kind: 'ambiguous',
      matches: exact,
      message: distinguishable
        ? `Several ${label}s are named "${ref}" — ${described.join(', ')}. ` +
          `Name the one you mean more fully, or use its id.`
        : `Several ${label}s are named "${ref}" and cannot be told apart by name. ` +
          `Use the ${label} id: ${exact.map(id).join(', ')}.`,
    };
  }

  const partial = items.filter((item) => name(item).toLowerCase().includes(needle));
  if (partial.length === 1) return { kind: 'matched', item: partial[0] as T };
  if (partial.length > 1) {
    return {
      kind: 'ambiguous',
      matches: partial,
      message:
        `"${ref}" is ambiguous — it matches ${partial.map(describe).join(', ')}. ` +
        `Use the full name or the ${label} id.`,
    };
  }

  return { kind: 'none', message: `No ${label} matching "${ref}". Available: ${available}.` };
}
