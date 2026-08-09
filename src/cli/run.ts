/**
 * The CLI runner: argv in, exit code out.
 *
 * Exported as a function over argv and injected dependencies so tests drive it
 * with a fake Graph and captured sinks, without spawning a process.
 *
 * Exit codes: 0 success; 1 tool error or policy refusal; 2 usage or validation
 * error. Errors go to stderr in every format — a JSON consumer detects failure
 * by exit code, never by parsing stdout.
 */
import type { AnyToolDefinition } from '../server/registry.js';
import type { ToolResult } from '../server/tool.js';
import type { ToolGroup } from '../tools/all.js';
import { flagSpecs, parseFlags, validateInput } from './flags.js';
import { renderJson, renderMarkdown, renderedText } from './render.js';
import { BIN, HIDDEN_TOOLS, globalHelp, toolHelp } from './help.js';

export interface CliDeps {
  readonly groups: readonly ToolGroup[];
  /**
   * Runs one tool through the shared harness (`runTool`), so the CLI path and
   * the MCP path cannot diverge on scope gating, policies, handler behaviour,
   * or error translation. A throw here is an environment failure — missing
   * configuration — not a tool result.
   */
  readonly execute: (
    definition: AnyToolDefinition,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;

  if (subcommand === undefined) {
    deps.stderr(`Usage: ${BIN} <subcommand> [flags]. Run ${BIN} --help for the list.\n`);
    return 2;
  }

  if (subcommand === '--help' || subcommand === '-h') {
    deps.stdout(globalHelp(deps.groups));
    return 0;
  }

  const definition = deps.groups
    .flatMap((group) => group.tools)
    .find((tool) => tool.name === subcommand && !HIDDEN_TOOLS.has(tool.name));
  if (!definition) {
    deps.stderr(`Unknown subcommand "${subcommand}". Run ${BIN} --help for the list.\n`);
    return 2;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    deps.stdout(toolHelp(definition));
    return 0;
  }

  const parsed = parseFlags(flagSpecs(definition.input), rest);
  if (!parsed.ok) {
    for (const error of parsed.errors) deps.stderr(`${error}\n`);
    return 2;
  }

  const validated = validateInput(definition.input, parsed.input);
  if (!validated.ok) {
    for (const error of validated.errors) deps.stderr(`${error}\n`);
    return 2;
  }

  let result: ToolResult;
  try {
    result = await deps.execute(definition, validated.args);
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (result.isError) {
    deps.stderr(`${renderedText(result)}\n`);
    return 1;
  }

  switch (parsed.format) {
    case 'json':
      deps.stdout(renderJson(result));
      break;
    case 'text':
      deps.stdout(`${renderedText(result)}\n`);
      break;
    case 'md':
      deps.stdout(renderMarkdown(definition.name, result));
      break;
  }

  return 0;
}
