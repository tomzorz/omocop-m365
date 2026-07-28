/**
 * Turning tool definitions into MCP registrations.
 *
 * The interesting decision here is what to do about a tool whose scopes were not
 * granted. Two behaviours, both defensible:
 *
 *   - **Register it** (default). It appears in the tool list and, if called,
 *     explains what is missing without sending anything to Graph. A model can see
 *     the capability exists and say why it is unavailable.
 *   - **Hide it** (`M365_HIDE_UNGRANTED_TOOLS`). The tool list reflects exactly
 *     what this sign-in can do. Cleaner, but a model cannot report on what it
 *     cannot see.
 *
 * Either way the tool surface is a consequence of the grant rather than a claim
 * made independently of it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { Logger } from '../logging.js';
import { missingScopes } from './scopes.js';
import { runTool, type ToolContext, type ToolDefinition } from './tool.js';

/** A definition with its generics erased, for holding heterogeneous tools in one list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export interface RegisterOptions {
  readonly granted?: readonly string[];
  readonly hideUngranted: boolean;
  readonly logger: Logger;
}

export interface RegistrationReport {
  readonly registered: readonly string[];
  readonly hidden: ReadonlyArray<{ readonly name: string; readonly missing: readonly string[] }>;
}

export function registerTools(
  server: McpServer,
  definitions: readonly AnyToolDefinition[],
  ctx: ToolContext,
  options: RegisterOptions,
): RegistrationReport {
  const registered: string[] = [];
  const hidden: Array<{ name: string; missing: readonly string[] }> = [];

  for (const definition of definitions) {
    const missing = options.granted
      ? missingScopes(definition.scopes, options.granted)
      : [];

    if (missing.length > 0 && options.hideUngranted) {
      hidden.push({ name: definition.name, missing });
      continue;
    }

    server.registerTool(
      definition.name,
      {
        ...(definition.title ? { title: definition.title } : {}),
        description: definition.description,
        inputSchema: definition.input as ZodRawShape,
        outputSchema: definition.output as ZodRawShape,
        ...(definition.annotations ? { annotations: definition.annotations } : {}),
      },
      // A fresh `resolved` map per call: policies write into it, and the server
      // handles calls concurrently, so a shared map would let one tool call read
      // what another one resolved.
      //
      // The SDK validates against inputSchema before calling this, so args are
      // already the parsed shape. Its generic plumbing does not carry that
      // through to a heterogeneous list, hence the one cast.
      (async (args: unknown) =>
        runTool(
          definition,
          args as never,
          { ...ctx, resolved: new Map() },
          options.granted,
        )) as never,
    );

    registered.push(definition.name);
  }

  if (hidden.length > 0) {
    options.logger.info(
      `${hidden.length} tool(s) hidden for want of scopes: ` +
        hidden.map((h) => `${h.name} (${h.missing.join(', ')})`).join('; '),
    );
  }

  return { registered, hidden };
}
