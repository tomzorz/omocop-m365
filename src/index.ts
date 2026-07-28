#!/usr/bin/env node
/**
 * omocop-m365 — an opinionated Microsoft 365 MCP server.
 *
 * Startup order matters here. The stdout guard goes in before anything else can
 * write, because stdio is the transport and a single stray byte on stdout breaks
 * the protocol in a way that never points at its cause.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ConfigError, loadConfig } from './config.js';
import { createLogger, installStdoutGuard } from './logging.js';
import { GraphClient } from './graph/client.js';
import { TokenStore } from './auth/token-store.js';
import { registerTools, type AnyToolDefinition } from './server/registry.js';
import type { ToolContext } from './server/tool.js';
import { authTools } from './tools/auth.js';
import { calendarTools } from './tools/calendar.js';
import { emailTools } from './tools/email.js';
import { attachmentTools } from './tools/attachments.js';
import { folderTools } from './tools/folders.js';

const SERVER_NAME = 'omocop-m365';
const SERVER_VERSION = '1.0.0';

export async function main(): Promise<void> {
  const logger = createLogger();
  installStdoutGuard(logger);

  const config = loadConfig();
  const store = new TokenStore(config, logger);

  const graph = new GraphClient({
    endpoint: config.graphEndpoint,
    tokens: store,
    logger,
  });

  const context: ToolContext = { graph, config, logger, resolved: new Map() };

  const tools: AnyToolDefinition[] = [
    ...authTools(store),
    ...calendarTools,
    ...emailTools,
    ...attachmentTools,
    ...folderTools,
  ];

  // Knowing what was granted lets a tool that cannot work say so without
  // spending a round trip to be refused. Before the first sign-in this is
  // undefined, and the gate stands down rather than hiding everything.
  const granted = await store.grantedScopes();
  if (!granted) {
    logger.info('Not signed in yet — every tool is registered; run the auth server to sign in.');
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const report = registerTools(server, tools, context, {
    ...(granted ? { granted } : {}),
    hideUngranted: config.hideUngrantedTools,
    logger,
  });

  logger.info(
    `${SERVER_NAME} ${SERVER_VERSION} ready with ${report.registered.length} tool(s)` +
      `${report.hidden.length ? `, ${report.hidden.length} hidden` : ''}`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const logger = createLogger();

  if (error instanceof ConfigError) {
    // A configuration problem is the user's to fix, and the message already says
    // how — no stack trace, which would only bury it.
    logger.error(error.message);
  } else {
    logger.error('Failed to start', error);
  }

  process.exitCode = 1;
});
