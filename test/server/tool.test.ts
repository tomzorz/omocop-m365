import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineTool, runTool, type ToolContext, type ToolPolicy } from '../../src/server/tool.js';
import { GraphError } from '../../src/graph/errors.js';
import { AuthenticationRequiredError } from '../../src/auth/token-store.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const config = loadConfig({ M365_CLIENT_ID: 'cid', M365_CLIENT_SECRET: 'sec' });

/** Covers what `echo` declares, so the gate is satisfied and out of the way. */
const GRANTED = ['Mail.ReadWrite'];

function context(lines: string[] = []): ToolContext {
  return {
    graph: {} as never,
    config,
    logger: createLogger('debug', (c) => void lines.push(c)),
    resolved: new Map(),
  };
}

/** A minimal well-formed tool: echoes its input into its output. */
const echo = defineTool({
  name: 'echo',
  description: 'Echoes a value',
  scopes: ['Mail.Read'],
  input: { value: z.string() },
  output: { echoed: z.string(), length: z.number() },
  handler: async (args) => ({ echoed: args.value, length: args.value.length }),
  render: (data) => `Echoed "${data.echoed}" (${data.length} chars).`,
});

describe('happy path', () => {
  test('returns rendered text and structured content derived from one value', async () => {
    const result = await runTool(echo, { value: 'hello' }, context(), ['Mail.ReadWrite']);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('Echoed "hello" (5 chars).');
    expect(result.structuredContent).toEqual({ echoed: 'hello', length: 5 });
  });

  /**
   * The point of deriving one from the other: they are the same object, so no
   * amount of editing can make the prose disagree with the data.
   */
  test('the rendered text is a function of the structured content', async () => {
    const result = await runTool(echo, { value: 'abc' }, context(), GRANTED);
    const data = result.structuredContent as { echoed: string; length: number };
    expect(result.content[0]?.text).toContain(data.echoed);
    expect(result.content[0]?.text).toContain(String(data.length));
  });
});

describe('scope gating', () => {
  test('refuses without calling the handler when a scope is missing', async () => {
    const handler = vi.fn();
    const tool = defineTool({ ...echo, handler: handler as never });

    const result = await runTool(tool, { value: 'x' }, context(), ['Calendars.Read']);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Mail.Read');
    expect(result.content[0]?.text).toContain('Nothing was sent');
    expect(handler).not.toHaveBeenCalled();
  });

  test('proceeds when a wider scope covers the requirement', async () => {
    const result = await runTool(echo, { value: 'x' }, context(), ['Mail.ReadWrite']);
    expect(result.isError).toBeUndefined();
  });

  test('skips the gate entirely when the grant is unknown', async () => {
    const result = await runTool(echo, { value: 'x' }, context(), undefined);
    expect(result.isError).toBeUndefined();
  });
});

describe('policies', () => {
  test('a refusing policy stops the handler and returns its message', async () => {
    const handler = vi.fn();
    const stop: ToolPolicy = () => ({ refuse: 'you must say which one you mean' });
    const tool = defineTool({ ...echo, policies: [stop], handler: handler as never });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('you must say which one you mean');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a proceeding policy contributes a value the handler can read', async () => {
    const KEY = Symbol('resolved-target');
    const resolve: ToolPolicy = () => ({ proceed: true, key: KEY, value: 'master-1' });

    const tool = defineTool({
      ...echo,
      policies: [resolve],
      handler: async (_args, ctx) => {
        const target = ctx.resolved.get(KEY) as string;
        return { echoed: target, length: target.length };
      },
    });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);
    expect(result.structuredContent).toEqual({ echoed: 'master-1', length: 8 });
  });

  test('policies run in order and the first refusal wins', async () => {
    const order: string[] = [];
    const first: ToolPolicy = () => {
      order.push('first');
      return { refuse: 'first said no' };
    };
    const second: ToolPolicy = () => {
      order.push('second');
      return { proceed: true };
    };

    const result = await runTool(
      defineTool({ ...echo, policies: [first, second] }),
      { value: 'x' },
      context(),
      GRANTED,
    );

    expect(order).toEqual(['first']);
    expect(result.content[0]?.text).toBe('first said no');
  });

  test('a policy sees the parsed arguments', async () => {
    let seen: unknown;
    const spy: ToolPolicy<{ value: string }> = (args) => {
      seen = args;
      return { proceed: true };
    };

    await runTool(defineTool({ ...echo, policies: [spy] }), { value: 'peek' }, context(), GRANTED);
    expect(seen).toEqual({ value: 'peek' });
  });

  test('an async policy is awaited', async () => {
    const slow: ToolPolicy = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { refuse: 'eventually no' };
    };
    const result = await runTool(defineTool({ ...echo, policies: [slow] }), { value: 'x' }, context(), GRANTED);
    expect(result.content[0]?.text).toBe('eventually no');
  });
});

describe('error translation', () => {
  test('a GraphError becomes its message plus guidance', async () => {
    const tool = defineTool({
      ...echo,
      handler: async () => {
        throw new GraphError(403, 'ErrorAccessDenied', 'Access is denied.', 'req-9', 'PATCH', 'me/events/1');
      },
    });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Access is denied.');
    expect(result.content[0]?.text).toContain('organiser');
    expect(result.content[0]?.text).toContain('req-9');
  });

  test('an authentication failure returns the actionable message', async () => {
    const tool = defineTool({
      ...echo,
      handler: async () => {
        throw new AuthenticationRequiredError();
      },
    });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);
    expect(result.content[0]?.text).toContain('npm run auth');
  });

  test('an unexpected error is reported, not swallowed', async () => {
    const tool = defineTool({
      ...echo,
      handler: async () => {
        throw new Error('something specific went wrong');
      },
    });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('something specific went wrong');
  });

  test('every failure path sets isError', async () => {
    const throwing = defineTool({
      ...echo,
      handler: async () => {
        throw new Error('x');
      },
    });
    for (const result of [
      await runTool(throwing, { value: 'x' }, context(), []),
      await runTool(echo, { value: 'x' }, context(), ['Nothing.Granted']),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
  });
});

describe('output validation', () => {
  test('a handler returning the wrong shape is a server bug, reported as one', async () => {
    const lines: string[] = [];
    const tool = defineTool({
      ...echo,
      handler: async () => ({ echoed: 'x', length: 'not a number' }) as never,
    });

    const result = await runTool(tool, { value: 'x' }, context(lines), GRANTED);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('bug in the server');
    expect(lines.join()).toContain('does not match its output schema');
  });

  test('extra keys are stripped rather than leaking into structured content', async () => {
    const tool = defineTool({
      ...echo,
      handler: async () => ({ echoed: 'x', length: 1, secret: 'should not appear' }) as never,
    });

    const result = await runTool(tool, { value: 'x' }, context(), GRANTED);
    expect(result.structuredContent).toEqual({ echoed: 'x', length: 1 });
  });
});
