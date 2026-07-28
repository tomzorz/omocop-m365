/**
 * Authentication tools.
 *
 * These need no Graph scope, because they answer questions about the local token
 * store rather than about the mailbox — which is also why they still work when
 * nothing else does, and are the right first call when something is wrong.
 *
 * `check-auth-status` actively refreshes rather than reporting staleness. A
 * status tool that says "expired" while a perfectly good refresh token sits next
 * to it has answered the wrong question.
 */
import { z } from 'zod';
import { defineTool } from '../server/tool.js';
import type { AnyToolDefinition } from '../server/registry.js';
import type { TokenStore } from '../auth/token-store.js';

/** Built with the store, since these tools talk to it rather than to Graph. */
export function authTools(store: TokenStore): AnyToolDefinition[] {
  const checkAuthStatus = defineTool({
    name: 'check-auth-status',
    title: 'Check authentication',
    description:
      'Reports whether this server is signed in, as which account, and which scopes were ' +
      'granted. Refreshes the access token if it has expired, so a stale token is fixed ' +
      'rather than reported.',
    scopes: [],
    annotations: { readOnlyHint: true },
    input: {},
    output: {
      authenticated: z.boolean(),
      account: z.string().optional(),
      scopes: z.array(z.string()),
      detail: z.string().optional(),
    },
    handler: async (_args, ctx) => {
      if (!(await store.isAuthenticated())) {
        return {
          authenticated: false,
          scopes: [],
          detail: 'No token store was found. Run the auth server and sign in.',
        };
      }

      try {
        await store.getAccessToken();
      } catch (error) {
        return {
          authenticated: false,
          scopes: [],
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      const scopes = (await store.grantedScopes()) ?? [];
      const account = await store.account();
      ctx.logger.debug(`Authenticated with ${scopes.length} scopes`);

      return {
        authenticated: true,
        ...(account ? { account } : {}),
        scopes: [...scopes],
      };
    },
    render: (data) =>
      data.authenticated
        ? `Signed in${data.account ? ` as ${data.account}` : ''}.\n` +
          `Scopes granted (${data.scopes.length}): ${data.scopes.join(', ')}`
        : `Not signed in.${data.detail ? `\n\n${data.detail}` : ''}`,
  });

  const authenticate = defineTool({
    name: 'authenticate',
    title: 'Start sign-in',
    description:
      'Explains how to sign in. The sign-in flow needs a browser, so this returns the ' +
      'address to open rather than completing it.',
    scopes: [],
    annotations: { readOnlyHint: true },
    input: {},
    output: { url: z.string(), alreadyAuthenticated: z.boolean() },
    handler: async (_args, ctx) => ({
      url: `http://localhost:${ctx.config.authPort}/`,
      alreadyAuthenticated: await store.isAuthenticated(),
    }),
    render: (data) =>
      (data.alreadyAuthenticated
        ? 'Already signed in. To sign in as a different account, or to widen the granted ' +
          'scopes, start again:\n\n'
        : 'Not signed in yet.\n\n') +
      `1. Run the sign-in server:  npm run auth\n` +
      `2. Open:  ${data.url}\n` +
      `3. Complete the Microsoft sign-in, then retry the original request.`,
  });

  return [checkAuthStatus, authenticate];
}
