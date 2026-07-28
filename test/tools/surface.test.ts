import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { AnyToolDefinition } from '../../src/server/registry.js';
import { calendarTools } from '../../src/tools/calendar.js';
import { emailTools } from '../../src/tools/email.js';
import { attachmentTools } from '../../src/tools/attachments.js';
import { folderTools } from '../../src/tools/folders.js';
import { authTools } from '../../src/tools/auth.js';
import { DEFAULT_SCOPES } from '../../src/config.js';
import { expandGranted } from '../../src/server/scopes.js';

const tools: AnyToolDefinition[] = [
  ...authTools({} as never),
  ...calendarTools,
  ...emailTools,
  ...attachmentTools,
  ...folderTools,
];

describe('the whole tool surface', () => {
  test('every tool has a unique name', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('names are lower-kebab-case, as MCP clients expect', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  test('every tool declares an output schema, so results are machine-readable', () => {
    for (const tool of tools) {
      expect(Object.keys(tool.output).length).toBeGreaterThan(0);
    }
  });

  test('every input and output schema is a zod raw shape', () => {
    for (const tool of tools) {
      for (const shape of [tool.input, tool.output]) {
        for (const [key, value] of Object.entries(shape)) {
          expect(value, `${tool.name}.${key}`).toBeInstanceOf(z.ZodType);
        }
      }
    }
  });

  test('descriptions are substantial enough to choose between tools', () => {
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
  });

  /**
   * A tool asking for something the default sign-in never requests would be
   * permanently unusable out of the box.
   */
  test('every declared scope is covered by the default grant', () => {
    const covered = expandGranted([...DEFAULT_SCOPES]);
    for (const tool of tools) {
      for (const scope of tool.scopes) {
        expect(covered.has(scope.toLowerCase()), `${tool.name} needs ${scope}`).toBe(true);
      }
    }
  });

  test('the auth tools need no scope, so they work before sign-in', () => {
    for (const name of ['check-auth-status', 'authenticate']) {
      expect(tools.find((t) => t.name === name)?.scopes).toEqual([]);
    }
  });

  test('anything that sends or deletes is annotated destructive', () => {
    const destructive = ['send-email', 'send-draft', 'delete-email', 'delete-event', 'cancel-event'];
    for (const name of destructive) {
      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  test('nothing read-only is also marked destructive', () => {
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint) {
        expect(tool.annotations.destructiveHint, tool.name).not.toBe(true);
      }
    }
  });

  test('only the send tools hold Mail.Send', () => {
    const senders = tools.filter((t) => t.scopes.includes('Mail.Send')).map((t) => t.name);
    expect(senders.sort()).toEqual(['send-draft', 'send-email']);
  });

  test('the expected 24 tools are present', () => {
    expect(tools).toHaveLength(24);
  });
});
