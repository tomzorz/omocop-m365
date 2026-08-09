/**
 * The complete tool surface, assembled once.
 *
 * Both consumers — the MCP entry and the CLI — import from here, so a tool
 * added to one surface cannot silently miss the other.
 */
import type { TokenStore } from '../auth/token-store.js';
import type { AnyToolDefinition } from '../server/registry.js';
import { authTools } from './auth.js';
import { calendarTools } from './calendar.js';
import { emailTools } from './email.js';
import { attachmentTools } from './attachments.js';
import { folderTools } from './folders.js';

/** Tools that belong together in a human-facing listing. */
export interface ToolGroup {
  readonly area: string;
  readonly tools: readonly AnyToolDefinition[];
}

export function toolGroups(store: TokenStore): readonly ToolGroup[] {
  return [
    { area: 'Authentication', tools: authTools(store) },
    { area: 'Calendar', tools: calendarTools },
    { area: 'Email', tools: emailTools },
    { area: 'Attachments', tools: attachmentTools },
    { area: 'Folders', tools: folderTools },
  ];
}

export function allTools(store: TokenStore): AnyToolDefinition[] {
  return toolGroups(store).flatMap((group) => [...group.tools]);
}
