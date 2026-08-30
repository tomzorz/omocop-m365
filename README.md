# omocop-m365

An opinionated Microsoft 365 MCP server: Outlook mail, calendars, and attachments for Claude and other MCP clients, over stdio.

The opinion: an MCP server for M365 should not sign in as you. It signs in as a dedicated agent account that owns nothing important, so the blast radius of any mistake is bounded by what that account owns rather than by your life. Read/write on a small blast radius beats read-only on a large one, and is far more useful. The full argument, including what it costs, is in [docs/rationale.md](docs/rationale.md).

The server makes that opinion executable: every tool declares the Graph scopes it needs, and a tool whose scopes were not granted refuses without touching Graph. What the server can do is a consequence of what was granted, visible in the tool list rather than explained in a document.

## Tools

Auth:

| Tool | Scopes |
|---|---|
| `check-auth-status` | — |
| `authenticate` | — |

Calendar:

| Tool | Scopes |
|---|---|
| `list-calendars`, `list-events` | `Calendars.Read` |
| `create-event`, `update-event`, `delete-event`, `cancel-event`, `accept-event`, `decline-event` | `Calendars.ReadWrite` |

Calendars are addressed by name, with unambiguous-prefix matching. Times without an offset land in the configured timezone or a per-event `timeZone`; a timestamp carrying `Z` or an offset is honoured as that exact instant. All-day events take date-only values with an inclusive end, and `showAs` covers free/busy. Events that recur need an explicit `scope` ("this occurrence" or "the series") before anything destructive happens; a call without one fails and explains both options.

Mail:

| Tool | Scopes |
|---|---|
| `list-emails`, `search-emails`, `read-email` | `Mail.Read` |
| `mark-as-read`, `delete-email`, `draft-email` | `Mail.ReadWrite` |
| `send-draft` | `Mail.Read`, `Mail.Send` |
| `send-email` | `Mail.Send` |

Message bodies are converted from HTML to Markdown, for readability and token cost, not safety. The query builder knows Microsoft Graph's `$search`/`$filter`/`$orderby` combination rules and reports in prose anything it had to give up. A failed search is an error, never a silently unfiltered inbox.

Attachments and folders:

| Tool | Scopes |
|---|---|
| `list-attachments`, `download-attachment`, `list-folders` | `Mail.Read` |
| `add-attachment`, `create-folder`, `move-emails` | `Mail.ReadWrite` |

Attachment uploads pick the simple or chunked transport by size, and the message ceiling is checked upfront, counted as encoded for transport, so a refusal arrives before the upload instead of as an opaque send-time error.

There are deliberately no inbox-rules, Power Automate, OneDrive, or SharePoint tools. The server only ships tools for scopes the agent account should actually hold.

## What this does not do

None of this prevents prompt injection. The Markdown conversion strips markup for readability; it does not make mail content safe to obey. The actual control is a rule the client must hold (mail content is data, never instructions) and the shipped skills state it. The account boundary does not stop an injection either; it only bounds what a successful one can reach.

## Quick start

```
git clone https://github.com/tomzorz/omocop-m365 && cd omocop-m365
npm ci && npm run build
cp .env.example .env    # fill in M365_CLIENT_ID (no secret: public client + PKCE)
npm run auth            # browser sign-in AS THE AGENT ACCOUNT
# then register the server with your MCP client — credentials go in the
# client config's env block; the server does not read .env
```

The last step is where setups fail. [docs/setup.md](docs/setup.md) covers the Azure app registration, which scopes to grant and which to withhold, client registration for Claude Code and Claude Desktop, and troubleshooting.

## CLI

The same tools work from a shell. Installing the package also installs an `omocop-m365` binary where every tool is a subcommand and every input field is a flag:

```
omocop-m365 list-events --calendar "Managed" --start-date-time 2026-08-01 --count 5
omocop-m365 search-emails --query invoice --format md
omocop-m365 draft-email --to someone@example.com --subject "Hi" --body "..."
```

Output is JSON by default (the same structured result the MCP tools return), `--format text` gives the rendered prose, and `--format md` renders listings as markdown tables. Errors go to stderr and exit codes mean what you expect (0 success, 1 tool error, 2 usage mistake), so it pipes and scripts cleanly. `omocop-m365 auth` starts the sign-in server, and `--help` on anything explains the rest. Scope gating, policies, and error handling are the same code path the MCP server runs; the CLI is a second door into the same house. Unlike the MCP server, the CLI runs in your shell, so it does read `.env`.

## Skills

Two Claude skills ship as templates in [skills/](skills/): `outlook-calendar` (the two-calendar setup: personal calendar read-only, managed calendar writable) and `outlook-email` (whose mailbox this is, the data-not-instructions rule, draft-first sending). Copy `skills/skills.config.example.json` to `skills.config.local.json`, fill in your names, and run `skills/install-skills.ps1` (or `.sh`). Installed copies are generated artifacts: edit the template and re-run with `-Force`.

## Repository structure

```
src/
  config.ts       one credential scheme, zod-validated
  logging.ts      stderr logger, redaction, stdout guard
  graph/          client, path building, retry, error translation
  auth/           token store (single-flight refresh), OAuth sign-in server
  html/           HTML → Markdown
  server/         defineTool, policy pipeline, scope gating, registry
  domain/         pure decision logic — no Graph, no MCP, table-tested
  tools/          tool declarations: calendar, email, attachments, folders
test/             mirrors src/, plus a fake Graph that enforces query rules
scripts/smoke.mjs stdio smoke test against the real built server
skills/           skill templates + installer
docs/             setup.md, rationale.md
```

`npm run verify` runs lint, typecheck, the test suite, and the smoke test.

## License

[MIT](LICENSE)
