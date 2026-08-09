/**
 * Help text. Asking for help is a success: it goes to stdout and exits 0.
 */
import type { AnyToolDefinition } from '../server/registry.js';
import type { ToolGroup } from '../tools/all.js';
import { flagSpecs, OUTPUT_FORMATS, type FlagSpec } from './flags.js';

export const BIN = 'omocop-m365';

/**
 * Tools that exist to instruct an MCP model and have no place in a shell.
 * `authenticate` returns sign-in instructions a model relays; in a shell,
 * `omocop-m365 auth` starts the sign-in server directly.
 */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['authenticate']);

const AUTH_SUMMARY = 'Starts the local sign-in server; open the printed URL to sign in.';

const FORMAT_LINE = `  --format <${OUTPUT_FORMATS.join('|')}>       Output format. Default json.`;

/** The first sentence of a description — the summary a subcommand list shows. */
export const firstSentence = (description: string): string => {
  const match = /^[^.]*\./.exec(description);
  return (match ? match[0] : description).trim();
};

const entry = (name: string, summary: string): string => `  ${name.padEnd(22)}${summary}`;

export function globalHelp(groups: readonly ToolGroup[]): string {
  const lines: string[] = [
    `${BIN} — Microsoft 365 from the shell, through the same pipeline as the MCP server.`,
    '',
    'Usage:',
    `  ${BIN} <subcommand> [flags]`,
    `  ${BIN} <subcommand> --help`,
    '',
    'Global flags:',
    FORMAT_LINE,
  ];

  for (const group of groups) {
    lines.push('', `${group.area}:`);
    if (group.area === 'Authentication') lines.push(entry('auth', AUTH_SUMMARY));
    for (const tool of group.tools) {
      if (HIDDEN_TOOLS.has(tool.name)) continue;
      lines.push(entry(tool.name, firstSentence(tool.description)));
    }
  }

  return `${lines.join('\n')}\n`;
}

export function toolHelp(tool: AnyToolDefinition): string {
  const specs = flagSpecs(tool.input);
  const lines: string[] = [
    `${BIN} ${tool.name} — ${firstSentence(tool.description)}`,
    '',
    'Usage:',
    `  ${BIN} ${tool.name}${specs.length ? ' [flags]' : ''}`,
  ];

  if (specs.length) {
    lines.push('', 'Flags:');
    for (const spec of specs) lines.push(flagLine(spec));
  }

  lines.push('', 'Global flags:', FORMAT_LINE);
  return `${lines.join('\n')}\n`;
}

export function authHelp(): string {
  return [
    `${BIN} auth — ${AUTH_SUMMARY}`,
    '',
    'Reads configuration from the environment and from .env in the working directory',
    '(a real environment variable wins), then listens on',
    'http://localhost:<M365_AUTH_PORT>/ (default 3333) until stopped.',
  ].join('\n') + '\n';
}

function flagLine(spec: FlagSpec): string {
  const value =
    spec.kind === 'boolean'
      ? ''
      : spec.choices
        ? ` <${spec.choices.join('|')}>`
        : ` <${spec.kind === 'array' ? spec.element : spec.kind}>`;

  const marks: string[] = [];
  if (spec.required) marks.push('required');
  if (spec.kind === 'array') marks.push('repeatable');
  if (spec.kind === 'boolean') marks.push('bare means true; =false means false');
  const suffix = marks.length ? ` (${marks.join('; ')})` : '';

  const head = `  --${spec.flag}${value}`;
  const description = spec.description ?? '';
  const tail = `${description}${suffix}`.trim();
  return tail ? `${head.padEnd(32)}${tail}` : head;
}
