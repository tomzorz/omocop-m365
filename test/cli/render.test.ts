import { describe, expect, test } from 'vitest';
import type { ToolResult } from '../../src/server/tool.js';
import { renderJson, renderMarkdown, renderedText } from '../../src/cli/render.js';

const result = (structured: Record<string, unknown>, text = 'rendered'): ToolResult => ({
  content: [{ type: 'text', text }],
  structuredContent: structured,
});

describe('renderJson', () => {
  test('prints exactly the structured result as JSON, newline-terminated', () => {
    const data = { folders: [{ id: 'f1', path: 'Inbox' }] };
    expect(renderJson(result(data))).toBe(`${JSON.stringify(data, null, 2)}\n`);
  });
});

describe('renderedText', () => {
  test('joins the text blocks in order', () => {
    const blocks: ToolResult = {
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    };
    expect(renderedText(blocks)).toBe('one\ntwo');
  });
});

describe('renderMarkdown', () => {
  test('list-emails becomes a table with a pipe-escaped subject and the id', () => {
    const md = renderMarkdown(
      'list-emails',
      result({
        messages: [
          {
            id: 'm1',
            subject: 'Invoice | July',
            from: 'Acme, Inc. <billing@acme.test>',
            received: '2026-08-01T09:30:00Z',
            preview: '',
            unread: true,
            hasAttachments: false,
          },
          {
            id: 'm2',
            subject: 'Hello',
            from: 'bob@example.test',
            received: '2026-08-02T10:00:00Z',
            preview: '',
            unread: false,
            hasAttachments: true,
          },
        ],
        truncated: false,
      }),
    );

    expect(md).toContain('| Subject | From | Received | Unread | Attachments | ID |');
    expect(md).toContain('| --- |');
    expect(md).toContain('Invoice \\| July');
    expect(md).toContain('| Acme, Inc. <billing@acme.test> | 2026-08-01 09:30 | yes |  | m1 |');
    expect(md).toContain('| m2 |');
  });

  test('list-calendars becomes a table with writability spelled out', () => {
    const md = renderMarkdown(
      'list-calendars',
      result({
        calendars: [
          { id: 'c1', name: 'Calendar', writable: true, isDefault: true },
          { id: 'c2', name: 'Shared', writable: false, isDefault: false, owner: 'ann@example.test' },
        ],
      }),
    );

    expect(md).toContain('| Name | Writable | Default | Owner | ID |');
    expect(md).toContain('| Calendar | yes | yes |  | c1 |');
    expect(md).toContain('| Shared | no |  | ann@example.test | c2 |');
  });

  test('an empty listing still renders the table header', () => {
    const md = renderMarkdown('list-folders', result({ folders: [] }));
    expect(md).toBe('| Path | ID |\n| --- | --- |\n');
  });

  test('notes and truncation survive the tabular format', () => {
    const md = renderMarkdown(
      'search-emails',
      result({
        messages: [],
        notes: ['the unread filter was not applied'],
        relevanceOrdered: true,
        truncated: true,
      }),
    );
    expect(md).toContain('Note: the unread filter was not applied');
    expect(md).toContain('Note: more results exist');
  });

  test('a non-listing tool falls back to the rendered text', () => {
    const md = renderMarkdown('read-email', result({ id: 'm1' }, 'From: someone\n\nBody.'));
    expect(md).toBe('From: someone\n\nBody.\n');
  });
});
