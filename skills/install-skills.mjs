#!/usr/bin/env node
/**
 * Installs the skill templates into a Claude skills directory, substituting
 * the {{TOKEN}} placeholders from a local, gitignored configuration.
 *
 * The templates in this directory are the source of truth: installed copies
 * are generated artifacts, and any hand edit to an installed SKILL.md is
 * destroyed by the next run. Edit the template, then re-run this.
 *
 * Refuses to overwrite an existing installed skill unless --force is passed,
 * so an accidental run cannot silently clobber a divergent live copy.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/** Expands a leading `~` so the example config can stay path-agnostic. */
const expandHome = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path);

/** Maps template tokens to their config keys. Every key is required. */
const TOKENS = {
  USER_NAME: 'userName',
  PERSONAL_CALENDAR: 'personalCalendar',
  MANAGED_CALENDAR: 'managedCalendar',
  AGENT_MAILBOX: 'agentMailbox',
  DOWNLOAD_DIR: 'downloadDir',
  MCP_SERVER_NAME: 'mcpServerName',
};

function fail(message) {
  console.error(`install-skills: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { force: false, config: join(root, 'skills.config.local.json') };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--config') {
      i += 1;
      if (!argv[i]) fail('--config needs a path');
      options.config = argv[i];
    } else fail(`unknown argument: ${arg} (expected --force and/or --config <path>)`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (!existsSync(options.config)) {
  fail(
    `no configuration at ${options.config}.\n` +
      `Copy skills.config.example.json to skills.config.local.json (it is ` +
      `gitignored) and fill in your values.`,
  );
}

let config;
try {
  config = JSON.parse(readFileSync(options.config, 'utf8'));
} catch (error) {
  fail(`${options.config} is not valid JSON: ${error instanceof Error ? error.message : error}`);
}

const missing = ['targetDir', ...Object.values(TOKENS)].filter(
  (key) => typeof config[key] !== 'string' || config[key].trim() === '',
);
if (missing.length > 0) fail(`configuration is missing: ${missing.join(', ')}`);

const skillDirs = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
  .map((entry) => entry.name);
if (skillDirs.length === 0) fail('no skill templates found next to this script');

// Refusals are collected across all skills so one run reports every conflict,
// rather than failing on the first and hiding the rest.
const refused = [];
const installed = [];

for (const name of skillDirs) {
  let content = readFileSync(join(root, name, 'SKILL.md'), 'utf8');
  for (const [token, key] of Object.entries(TOKENS)) {
    content = content.replaceAll(`{{${token}}}`, config[key]);
  }

  // A leftover token means the template and this script disagree about the
  // token set — installing it would ship literal {{...}} into a live skill.
  const leftover = content.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (leftover) fail(`${name}/SKILL.md still contains ${[...new Set(leftover)].join(', ')}`);

  const destDir = join(expandHome(config.targetDir), name);
  const dest = join(destDir, 'SKILL.md');
  if (existsSync(dest) && !options.force) {
    refused.push(dest);
    continue;
  }

  mkdirSync(destDir, { recursive: true });
  writeFileSync(dest, content, 'utf8');
  installed.push(dest);
}

for (const path of installed) console.log(`installed ${path}`);
if (refused.length > 0) {
  console.error(
    `install-skills: refused to overwrite existing files (re-run with --force):\n` +
      refused.map((path) => `  ${path}`).join('\n'),
  );
  process.exit(1);
}
