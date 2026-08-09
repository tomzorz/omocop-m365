/**
 * Output renderers for the three formats.
 *
 * json prints the structured result and nothing else on stdout; text prints the
 * rendered text the tool's own `render` derived; md prints a table for exactly
 * the six listing tools and falls back to the rendered text everywhere else,
 * because the rendered text is markdown-safe.
 */
import { formatSize } from '../domain/attachments.js';
import type { ToolResult } from '../server/tool.js';

/** The rendered text of a result: its text blocks, in order. */
export function renderedText(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[image ${block.mimeType}]`))
    .join('\n');
}

export function renderJson(result: ToolResult): string {
  return `${JSON.stringify(result.structuredContent ?? {}, null, 2)}\n`;
}

type Row = Record<string, unknown>;

interface Column {
  readonly header: string;
  readonly cell: (row: Row) => string;
}

interface TableSpec {
  /** Key in the structured result holding the array the table renders. */
  readonly items: string;
  readonly columns: readonly Column[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const yes = (value: unknown): string => (value === true ? 'yes' : '');
const instant = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') : '';
const size = (value: unknown): string => formatSize(typeof value === 'number' ? value : 0);

const MESSAGE_COLUMNS: readonly Column[] = [
  { header: 'Subject', cell: (row) => text(row['subject']) },
  { header: 'From', cell: (row) => text(row['from']) },
  { header: 'Received', cell: (row) => instant(row['received']) },
  { header: 'Unread', cell: (row) => yes(row['unread']) },
  { header: 'Attachments', cell: (row) => yes(row['hasAttachments']) },
  { header: 'ID', cell: (row) => text(row['id']) },
];

/**
 * Exactly the six listing tools. Ids stay in every table — they are what a
 * follow-up command is addressed by.
 */
const TABLES: Readonly<Record<string, TableSpec>> = {
  'list-events': {
    items: 'events',
    columns: [
      { header: 'Subject', cell: (row) => text(row['subject']) },
      { header: 'Start', cell: (row) => text(row['start']) },
      { header: 'End', cell: (row) => text(row['end']) },
      { header: 'Location', cell: (row) => text(row['location']) },
      { header: 'Calendar', cell: (row) => text(row['calendar']) },
      { header: 'ID', cell: (row) => text(row['id']) },
    ],
  },
  'list-emails': { items: 'messages', columns: MESSAGE_COLUMNS },
  'search-emails': { items: 'messages', columns: MESSAGE_COLUMNS },
  'list-attachments': {
    items: 'attachments',
    columns: [
      { header: 'Name', cell: (row) => text(row['name']) },
      { header: 'Size', cell: (row) => size(row['size']) },
      { header: 'Type', cell: (row) => text(row['contentType']) },
      { header: 'Inline', cell: (row) => yes(row['isInline']) },
      { header: 'ID', cell: (row) => text(row['id']) },
    ],
  },
  'list-folders': {
    items: 'folders',
    columns: [
      { header: 'Path', cell: (row) => text(row['path']) },
      { header: 'ID', cell: (row) => text(row['id']) },
    ],
  },
  'list-calendars': {
    items: 'calendars',
    columns: [
      { header: 'Name', cell: (row) => text(row['name']) },
      { header: 'Writable', cell: (row) => (row['writable'] === true ? 'yes' : 'no') },
      { header: 'Default', cell: (row) => yes(row['isDefault']) },
      { header: 'Owner', cell: (row) => text(row['owner']) },
      { header: 'ID', cell: (row) => text(row['id']) },
    ],
  },
};

/** A cell must not break its row: pipes are escaped and newlines flattened. */
const escapeCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function markdownTable(spec: TableSpec, data: Record<string, unknown>): string {
  const raw = data[spec.items];
  const rows: readonly Row[] = Array.isArray(raw)
    ? raw.filter((item): item is Row => typeof item === 'object' && item !== null)
    : [];

  const lines = [
    `| ${spec.columns.map((column) => column.header).join(' | ')} |`,
    `| ${spec.columns.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (row) => `| ${spec.columns.map((column) => escapeCell(column.cell(row))).join(' | ')} |`,
    ),
  ];

  // Whatever the tool had to report alongside the rows — a dropped filter, a
  // capped result — survives the tabular format; dropping it would hide exactly
  // what the tool went out of its way to say.
  const notes: string[] = [];
  const declared = data['notes'];
  if (Array.isArray(declared)) {
    for (const note of declared) if (typeof note === 'string') notes.push(`Note: ${note}`);
  }
  if (data['truncated'] === true) notes.push('Note: more results exist — raise count.');

  return `${lines.join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n`;
}

export function renderMarkdown(toolName: string, result: ToolResult): string {
  const spec = TABLES[toolName];
  if (!spec || !result.structuredContent) return `${renderedText(result)}\n`;
  return markdownTable(spec, result.structuredContent);
}
