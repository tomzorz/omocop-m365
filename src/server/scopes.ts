/**
 * Deciding whether what was granted covers what a tool needs.
 *
 * Asking for a scope is not being given it — a user can decline individual
 * consents, and an administrator can restrict them. So the question "can this
 * tool work?" has a static answer that is knowable at registration time, and
 * answering it there beats discovering it as a 403 in the middle of a task.
 */

/** Graph reports scopes both bare and fully qualified; normalise to bare. */
export function normaliseScope(scope: string): string {
  return scope
    .trim()
    .replace(/^https:\/\/graph\.microsoft\.com\//i, '')
    .toLowerCase();
}

/**
 * Scopes implied by holding another, following Graph's containment chain:
 * `X.ReadWrite.All` ⊇ `X.Read.All`, `X.ReadWrite`, `X.Read`;
 * `X.Read.All` ⊇ `X.Read`; `X.ReadWrite` ⊇ `X.Read`.
 *
 * The suffixes are mutually exclusive — a scope ends in exactly one of them —
 * so each branch returns and nothing can be expanded twice.
 */
function impliedBy(granted: string): readonly string[] {
  if (granted.endsWith('.readwrite.all')) {
    const stem = granted.slice(0, -'.readwrite.all'.length);
    return [granted, `${stem}.read.all`, `${stem}.readwrite`, `${stem}.read`];
  }
  if (granted.endsWith('.read.all')) {
    return [granted, granted.slice(0, -'.all'.length)];
  }
  if (granted.endsWith('.readwrite')) {
    return [granted, `${granted.slice(0, -'.readwrite'.length)}.read`];
  }
  return [granted];
}

/** Expands a granted set to everything it covers. */
export function expandGranted(granted: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const scope of granted) {
    for (const implied of impliedBy(normaliseScope(scope))) set.add(implied);
  }
  return set;
}

/**
 * Scopes a tool needs that were not granted.
 *
 * @returns the missing scopes in their declared form, empty when satisfied
 */
export function missingScopes(
  required: readonly string[],
  granted: readonly string[],
): readonly string[] {
  const covered = expandGranted(granted);
  return required.filter((scope) => !covered.has(normaliseScope(scope)));
}

/** The message a tool returns when it cannot work with the current grant. */
export function ungrantedMessage(toolName: string, missing: readonly string[]): string {
  const list = missing.map((s) => `"${s}"`).join(', ');
  return (
    `${toolName} needs ${missing.length === 1 ? 'a scope' : 'scopes'} that this ` +
    `sign-in did not grant: ${list}.\n\n` +
    `Nothing was sent to Microsoft Graph. To grant it, add the scope to M365_SCOPES and ` +
    `sign in again — docs/rationale.md covers which scopes this server requests by default ` +
    `and why.`
  );
}
