import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools, type AnyToolDefinition } from '../../src/server/registry.js';
import { defineTool, type ToolContext } from '../../src/server/tool.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

const config = loadConfig({ M365_CLIENT_ID: 'cid', M365_CLIENT_SECRET: 'sec' });

function context(): ToolContext {
  return { graph: {} as never, config, logger: createLogger('error', () => {}), resolved: new Map() };
}

type ToolCallback = (args: Record<string, unknown>) => Promise<unknown>;

/** Records registrations without standing up a real transport. */
function fakeServer() {
  const tools: Array<{ name: string; config: Record<string, unknown>; cb: ToolCallback }> = [];
  const server = {
    registerTool(name: string, cfg: Record<string, unknown>, cb: ToolCallback) {
      tools.push({ name, config: cfg, cb });
      return {} as never;
    },
  };
  return { server: server as unknown as McpServer, tools };
}

const mailTool = defineTool({
  name: 'read-mail',
  description: 'Reads mail',
  scopes: ['Mail.Read'],
  input: { id: z.string() },
  output: { subject: z.string() },
  annotations: { readOnlyHint: true },
  handler: async () => ({ subject: 'hi' }),
  render: (d) => d.subject,
});

const rulesTool = defineTool({
  name: 'list-rules',
  description: 'Lists inbox rules',
  scopes: ['MailboxSettings.ReadWrite'],
  input: {},
  output: { count: z.number() },
  handler: async () => ({ count: 0 }),
  render: (d) => String(d.count),
});

const definitions: AnyToolDefinition[] = [mailTool, rulesTool];
const logger = createLogger('error', () => {});

describe('registration', () => {
  test('registers every tool when the grant covers them', () => {
    const { server, tools } = fakeServer();
    const report = registerTools(server, definitions, context(), {
      granted: ['Mail.ReadWrite', 'MailboxSettings.ReadWrite'],
      hideUngranted: false,
      logger,
    });

    expect(report.registered).toEqual(['read-mail', 'list-rules']);
    expect(report.hidden).toEqual([]);
    expect(tools).toHaveLength(2);
  });

  test('passes description, schemas and annotations through', () => {
    const { server, tools } = fakeServer();
    registerTools(server, [mailTool], context(), { hideUngranted: false, logger });

    const registered = tools[0];
    expect(registered?.name).toBe('read-mail');
    expect(registered?.config['description']).toBe('Reads mail');
    expect(registered?.config['inputSchema']).toBe(mailTool.input);
    expect(registered?.config['outputSchema']).toBe(mailTool.output);
    expect(registered?.config['annotations']).toEqual({ readOnlyHint: true });
  });

  test('omits title and annotations when a tool declares neither', () => {
    const { server, tools } = fakeServer();
    registerTools(server, [rulesTool], context(), { hideUngranted: false, logger });

    expect(tools[0]?.config).not.toHaveProperty('title');
    expect(tools[0]?.config).not.toHaveProperty('annotations');
  });
});

describe('ungranted scopes', () => {
  /**
   * The default: the capability stays visible so a model can say why it is
   * unavailable, and calling it explains rather than reaching Graph to be refused.
   */
  test('registers an ungranted tool by default, and it refuses when called', async () => {
    const { server, tools } = fakeServer();
    const report = registerTools(server, definitions, context(), {
      granted: ['Mail.ReadWrite'],
      hideUngranted: false,
      logger,
    });

    expect(report.registered).toEqual(['read-mail', 'list-rules']);

    const rules = tools.find((t) => t.name === 'list-rules');
    const result = (await rules?.cb({})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('MailboxSettings.ReadWrite');
    expect(result.content[0]?.text).toContain('Nothing was sent');
  });

  test('hides it when asked, and reports what was hidden and why', () => {
    const { server, tools } = fakeServer();
    const report = registerTools(server, definitions, context(), {
      granted: ['Mail.ReadWrite'],
      hideUngranted: true,
      logger,
    });

    expect(report.registered).toEqual(['read-mail']);
    expect(report.hidden).toEqual([
      { name: 'list-rules', missing: ['MailboxSettings.ReadWrite'] },
    ]);
    expect(tools.map((t) => t.name)).toEqual(['read-mail']);
  });

  test('registers everything when the grant is unknown, whatever the hide setting', () => {
    const { server } = fakeServer();
    const report = registerTools(server, definitions, context(), {
      hideUngranted: true,
      logger,
    });

    expect(report.registered).toEqual(['read-mail', 'list-rules']);
    expect(report.hidden).toEqual([]);
  });
});

describe('the registered callback', () => {
  test('runs the tool and returns structured content', async () => {
    const { server, tools } = fakeServer();
    registerTools(server, [mailTool], context(), {
      granted: ['Mail.Read'],
      hideUngranted: false,
      logger,
    });

    const result = (await tools[0]?.cb({ id: 'x' })) as {
      structuredContent: unknown;
      content: Array<{ text: string }>;
    };

    expect(result.structuredContent).toEqual({ subject: 'hi' });
    expect(result.content[0]?.text).toBe('hi');
  });
});
