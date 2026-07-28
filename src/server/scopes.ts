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
 * Scopes implied by holding another. `X.ReadWrite` covers `X.Read`, so a tool
 * declaring the narrower form is satisfied by the wider grant.
 */
function impliedBy(granted: string): readonly string[] {
  const implied = [granted];
  if (granted.endsWith('.readwrite')) {
    implied.push(granted.replace(/\.readwrite$/, '.read'));
  }
  if (granted.endsWith('.readwrite.all')) {
    implied.push(
      granted.replace(/\.readwrite\.all$/, '.read.all'),
      granted.replace(/\.readwrite\.all$/, '.readwrite'),
      granted.replace(/\.readwrite\.all$/, '.read'),
    );
  }
  return implied;
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
