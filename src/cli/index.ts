#!/usr/bin/env node
/**
 * omocop-m365 — the CLI surface over the same tools the MCP server exposes.
 *
 * No stdout guard here: CLI stdout is the product, not a JSON-RPC transport.
 * Logging still goes through the shared logger, to stderr, at LOG_LEVEL.
 */
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logging.js';
import { GraphClient } from '../graph/client.js';
import { TokenStore } from '../auth/token-store.js';
import { AuthServer } from '../auth/server.js';
import { runTool, type ToolContext } from '../server/tool.js';
import { toolGroups } from '../tools/all.js';
import { authHelp } from './help.js';
import { runCli } from './run.js';

async function main(): Promise<void> {
  // dotenv only fills gaps: an existing environment variable always wins over
  // the `.env` value of the same name, which is dotenv's default behaviour.
  const { config: dotenvConfig } = await import('dotenv');
  dotenvConfig();

  const logger = createLogger();
  const argv = process.argv.slice(2);

  // `auth` starts the sign-in server exactly as `omocop-m365-auth` does, built
  // from the same exported pieces. It listens until stopped.
  if (argv[0] === 'auth') {
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(authHelp());
      return;
    }
    const config = loadConfig();
    const store = new TokenStore(config, logger);
    await new AuthServer(config, logger, store).listen();
    return;
  }

  // Help and usage output must work before any credentials exist, so a missing
  // configuration is deferred: it only surfaces when a tool actually runs. The
  // placeholder config is never used — `execute` refuses before touching it.
  let configError: ConfigError | undefined;
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configError = error;
    config = loadConfig({ M365_CLIENT_ID: 'unconfigured' });
  }

  const store = new TokenStore(config, logger);
  const graph = new GraphClient({ endpoint: config.graphEndpoint, tokens: store, logger });
  const context: ToolContext = { graph, config, logger, resolved: new Map() };

  process.exitCode = await runCli(argv, {
    groups: toolGroups(store),
    execute: async (definition, args) => {
      if (configError) throw configError;
      // The grant is read per invocation: a CLI process is short-lived, and the
      // sign-in may have happened since the last run.
      const granted = await store.grantedScopes();
      // runCli validated args against definition.input already; the erased
      // generics on AnyToolDefinition do not carry that through, hence the cast
      // — the same one the MCP registration makes.
      return runTool(definition, args as never, { ...context, resolved: new Map() }, granted);
    },
    stdout: (chunk) => void process.stdout.write(chunk),
    stderr: (chunk) => void process.stderr.write(chunk),
  });
}

main().catch((error: unknown) => {
  const logger = createLogger();
  if (error instanceof ConfigError) {
    // A configuration problem is the user's to fix, and the message already
    // says how — no stack trace, which would only bury it.
    logger.error(error.message);
  } else {
    logger.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
