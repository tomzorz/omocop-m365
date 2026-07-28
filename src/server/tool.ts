/**
 * The tool harness.
 *
 * A tool declares what it is and what it needs; everything a tool would
 * otherwise repeat happens here, once.
 *
 * The repetition being eliminated is not hypothetical. Written by hand, every
 * handler carries the same preamble — validate, authenticate, resolve, try,
 * translate, wrap — and the copies drift. One tool grows a helpful message for a
 * 403 while its neighbours emit a bare status line, and which is which is an
 * accident of when each was last touched.
 *
 * Three consequences worth naming:
 *
 *   - **Error semantics are uniform** because there is one catch block.
 *   - **Prose and structured data cannot disagree**, because the handler returns
 *     data and `render` derives the text from it. Two hand-written outputs would
 *     drift the same way the preamble did.
 *   - **Cross-cutting rules are declared, not remembered.** A policy runs before
 *     the handler, so a handler cannot be reached in a state the policy forbids.
 */
import type { z, ZodRawShape } from 'zod';
import { z as zod } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { GraphClient } from '../graph/client.js';
import { GraphError, describeGraphError } from '../graph/errors.js';
import { AuthenticationRequiredError } from '../auth/token-store.js';
import { missingScopes, ungrantedMessage } from './scopes.js';

/** Everything a handler is given. */
export interface ToolContext {
  readonly graph: GraphClient;
  readonly config: Config;
  readonly logger: Logger;
  /**
   * Values contributed by policies, keyed by the policy that produced them.
   * Policies export typed accessors rather than exposing callers to the bag.
   */
  readonly resolved: Map<symbol, unknown>;
}

/** What a policy decides. */
export type PolicyOutcome =
  /** Stop; the message is returned to the caller and the handler never runs. */
  | { readonly refuse: string }
  /** Continue, optionally contributing a value to the context. */
  | { readonly proceed: true; readonly key?: symbol; readonly value?: unknown };

/**
 * A rule applied before the handler.
 *
 * Policies exist so a rule that applies to several tools is stated once and
 * enforced by the machinery, rather than reimplemented in each handler and
 * extracted after the third copy.
 */
export type ToolPolicy<TArgs = Record<string, unknown>> = (
  args: TArgs,
  ctx: ToolContext,
) => Promise<PolicyOutcome> | PolicyOutcome;

type Infer<T extends ZodRawShape> = z.infer<z.ZodObject<T>>;

export interface ToolDefinition<In extends ZodRawShape, Out extends ZodRawShape> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Graph scopes this tool needs. Checked before anything is sent. */
  readonly scopes: readonly string[];
  readonly input: In;
  readonly output: Out;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly policies?: readonly ToolPolicy<Infer<In>>[];
  readonly handler: (args: Infer<In>, ctx: ToolContext) => Promise<Infer<Out>>;
  /**
   * Derives what the caller sees from the same data returned as structured
   * output, so the two cannot disagree. Returning blocks rather than a string
   * lets a tool hand back images alongside the text.
   */
  readonly render: (data: Infer<Out>) => string | readonly ContentBlock[];
}

/**
 * Identity function that fixes the generic parameters.
 *
 * Without it, a definition written inline widens `input`/`output` to
 * `ZodRawShape` and the handler loses its argument types.
 */
export function defineTool<In extends ZodRawShape, Out extends ZodRawShape>(
  definition: ToolDefinition<In, Out>,
): ToolDefinition<In, Out> {
  return definition;
}

/**
 * Content blocks a tool may return.
 *
 * Images are first-class rather than described in prose: a model reading an
 * image-only email should look at it, which it does better than any text
 * extraction would.
 */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** The subset of an MCP tool result this harness produces. */
export interface ToolResult {
  readonly content: readonly ContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

const ok = (rendered: string | readonly ContentBlock[], data: Record<string, unknown>): ToolResult => ({
  content: typeof rendered === 'string' ? [{ type: 'text', text: rendered }] : rendered,
  structuredContent: data,
});

const fail = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * Runs one tool call end to end.
 *
 * @param granted scopes the current sign-in holds, or undefined when not yet
 *   authenticated — in which case the scope gate is skipped and the ordinary
 *   authentication error is allowed to surface
 */
export async function runTool<In extends ZodRawShape, Out extends ZodRawShape>(
  definition: ToolDefinition<In, Out>,
  args: Infer<In>,
  ctx: ToolContext,
  granted?: readonly string[],
): Promise<ToolResult> {
  const { name, logger } = { name: definition.name, logger: ctx.logger };

  // The scope gate answers a static question statically. Reaching Graph to be
  // told "forbidden" costs a round trip and produces a worse message.
  if (granted) {
    const missing = missingScopes(definition.scopes, granted);
    if (missing.length > 0) {
      logger.debug(`${name} refused: missing scopes ${missing.join(', ')}`);
      return fail(ungrantedMessage(name, missing));
    }
  }

  try {
    for (const policy of definition.policies ?? []) {
      const outcome = await policy(args, ctx);
      if ('refuse' in outcome) {
        logger.debug(`${name} refused by policy`);
        return fail(outcome.refuse);
      }
      if (outcome.key !== undefined) ctx.resolved.set(outcome.key, outcome.value);
    }

    const data = await definition.handler(args, ctx);

    // Validating the handler's own output catches a mismatch here, naming the
    // tool, rather than as an opaque protocol error at the client.
    const parsed = zod.object(definition.output).safeParse(data);
    if (!parsed.success) {
      logger.error(`${name} returned data that does not match its output schema`, parsed.error);
      return fail(
        `${name} produced a malformed result. This is a bug in the server, not in the request.`,
      );
    }

    return ok(definition.render(data), parsed.data as Record<string, unknown>);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return fail(error.message);

    if (error instanceof GraphError) {
      logger.warn(`${name} failed: ${error.message}`);
      return fail(describeGraphError(error));
    }

    logger.error(`${name} threw`, error);
    return fail(error instanceof Error ? error.message : String(error));
  }
}
