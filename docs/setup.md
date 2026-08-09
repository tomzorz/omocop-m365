# Setup

This walks from nothing to a working server: the agent account, the Azure app registration, sign-in, client registration, and the skills. The order matters. In particular, decide *whose identity* the server runs as before touching Azure; that decision is the whole point of this project ([rationale.md](rationale.md)).

## 1. Create the agent account

Create a new, dedicated Microsoft account (an outlook.com account works) for the agent. Not your account. It should own nothing you care about; the test is that you would be willing to revoke it on ten minutes' notice.

Then open the doors you actually want, and no more. The layout the shipped skills assume:

- Share your real calendar to the agent account, read-only.
- Create a second calendar (the "managed calendar") in your real account and grant the agent account write access to it.
- Mail: no sharing in either direction. The agent's mailbox is its own.

## 2. Register an app in Azure

In the [Azure Portal](https://portal.azure.com) → Microsoft Entra ID → App registrations → New registration:

- **Supported account types**: include personal Microsoft accounts if the agent account is an outlook.com account (the "personal Microsoft accounts" or "any org + personal" option).
- **Redirect URI**: platform **Mobile and desktop applications**, custom URI `http://localhost:3333/auth/callback` (adjust the port if you change `M365_AUTH_PORT`).

Then, under the new registration:

- **Authentication** → Advanced settings → **Allow public client flows** → Yes. This makes it a public client registration: there is no client secret. The PKCE exchange carries the flow, which is how OAuth intends anything running on your own machine to work, and it leaves you nothing to store or rotate.
- **API permissions** → Microsoft Graph → *Delegated* permissions: add the scopes below. Personal accounts consent at sign-in; there is no admin consent step.

<details>
<summary>Alternative: confidential client (with a secret)</summary>

If you prefer a *Web* platform registration with a client secret, that works too: use a Web redirect URI instead, create a secret under Certificates & secrets, and set `M365_CLIENT_SECRET` wherever this guide sets `M365_CLIENT_ID`. Copy the secret **Value**, not the Secret ID; the ID is also a GUID, and pasting it produces `AADSTS7000215`, which reads like a wrong password and wastes an afternoon. There is no advantage to this for a local server. It exists for setups that already have such a registration.

</details>

### Scopes to grant

| Scope | Why |
|---|---|
| `openid`, `profile`, `email`, `offline_access` | Sign-in and refresh tokens. Without `offline_access` there is no refresh token and authentication "keeps breaking" daily. |
| `User.Read` | Basic profile of the signed-in agent account. |
| `Mail.ReadWrite` | Read, draft, file, and delete mail in the agent mailbox. |
| `Mail.Send` | Send as the agent account. |
| `Calendars.ReadWrite` | The agent's calendars, plus calendars shared to it (your read-only one, the writable managed one; sharing permissions still apply on top). |

### Scopes to withhold

Withholding is a feature. The server ships no tools that need these, and the tool surface staying honest depends on them staying ungranted:

| Scope | Why not |
|---|---|
| `MailboxSettings.ReadWrite` | Inbox rules, forwarding, auto-replies: standing machinery that outlives any one conversation. |
| `Flows.Read.All` / Power Automate | A Flow runs with its *builder's* connections, not the caller's. Granting this walks straight past the account separation. |
| `Files.*`, `Sites.*` | OneDrive and SharePoint are out of scope here. Grant nothing a shipped tool does not use. |

If you grant a narrower set than the default (see `M365_SCOPES` in `.env.example`), the affected tools refuse with an explanation, without calling Graph, or disappear from the tool list entirely with `M365_HIDE_UNGRANTED_TOOLS=1`.

## 3. Sign in

```
cp .env.example .env      # fill in M365_CLIENT_ID
npm ci && npm run build
npm run auth
```

`npm run auth` starts a loopback-only server and prints a `http://localhost:3333/` URL. Open it and sign in as the agent account. If the browser is already signed into your real account, use a private window. Tokens land in `~/.omocop-m365-tokens.json` (override with `M365_TOKEN_STORE`) and refresh themselves from then on.

## 4. Register the server with your MCP client

The single most common setup failure: an MCP server is launched by its client, not by a shell. It does not inherit your environment and does not read `.env`; that file feeds `npm run auth` and the CLI, never the server. Credentials for the server must go in the client configuration's `env` block.

For **Claude Code**, either `claude mcp add omocop-m365 --env ... -- node <path>/dist/index.js`, or add to the `mcpServers` object of your configuration:

```json
"omocop-m365": {
  "command": "node",
  "args": ["/absolute/path/to/omocop-m365/dist/index.js"],
  "env": {
    "M365_CLIENT_ID": "your-client-id",
    "M365_TIMEZONE": "W. Europe Standard Time"
  }
}
```

For **Claude Desktop**, the same block goes into `claude_desktop_config.json` (Settings → Developer → Edit Config).

Restart the client after editing; verify with the `check-auth-status` tool, which actively refreshes rather than reporting staleness.

Two notes:

- `M365_TIMEZONE` is a Windows timezone name (`"W. Europe Standard Time"`), not an IANA one (`Europe/Budapest` will not work). It governs what naive timestamps like `2026-08-15T14:00:00` mean.
- The registration key (`omocop-m365` above) namespaces the tool names: `mcp__omocop-m365__list-events`. Anything that references tool names by string, such as permission allowlists or a skill's `allowed-tools` frontmatter, silently stops matching if you register under a different key. This is why the shipped skills deliberately omit `allowed-tools`.

## 5. Install the skills

```
cp skills/skills.config.example.json skills/skills.config.local.json
# edit skills.config.local.json with your names
skills/install-skills.ps1        # or: sh skills/install-skills.sh
```

The installer substitutes your values into the two skill templates and writes them to `targetDir` (your Claude skills directory). It refuses to overwrite existing skills unless given `-Force`/`--force`. Installed copies are generated: edit the template, re-run the installer.

If you would rather substitute by hand, the tokens are:

| Token | Meaning |
|---|---|
| `{{USER_NAME}}` | What the skills call you |
| `{{PERSONAL_CALENDAR}}` | Name of your real calendar, shared read-only |
| `{{MANAGED_CALENDAR}}` | Name of the writable managed calendar |
| `{{AGENT_MAILBOX}}` | The agent account's address |
| `{{DOWNLOAD_DIR}}` | Where attachment downloads default to |
| `{{MCP_SERVER_NAME}}` | The registration key from step 4 |

## 6. Optional: the CLI

The package also installs an `omocop-m365` binary: every tool as a subcommand, every input field as a kebab-case flag, `--help` throughout. It reads `.env` (your shell environment wins), outputs JSON by default with `--format text` and `--format md` alternatives, and runs the exact same scope gating and policies as the server. `omocop-m365 auth` is equivalent to `npm run auth`. See the README for examples.

## Troubleshooting

**`invalid_client` complaining about a missing client secret or assertion** — the app registration is not set up as a public client. Check that the redirect URI lives under the **Mobile and desktop applications** platform (not Web) and that **Allow public client flows** is Yes.

**`AADSTS7000215: Invalid client secret provided`** — only applies to the optional confidential-client setup: you pasted the client secret's *ID* instead of its *Value*. Both are shown at creation; only the Value works, and it is only shown once.

**Sign-in succeeds but tools say authentication is required** — the server process and `npm run auth` must agree on the token path. If you set `M365_TOKEN_STORE`, set it in both places (client `env` block and `.env`).

**"Authentication keeps breaking" every day or so** — the sign-in had no `offline_access` scope, so there is no refresh token. Check `M365_SCOPES` if you overrode it (the server appends `offline_access` itself, but an old token file predating the override may need one fresh `npm run auth`).

**Tools refuse with "scope was not granted"** — the token's scopes are a subset of what the tool needs. Add the scope in the Azure app's API permissions AND to `M365_SCOPES` (if overridden), run `npm run auth` again, then restart the MCP client; the granted set is read at server startup.

**The server works in a terminal but not in the client** — you are reading `.env` in the terminal; the client is not. Step 4.

**`redirect_uri_mismatch` during sign-in** — the redirect URI in Azure must be exactly `http://localhost:<M365_AUTH_PORT>/auth/callback`, under the Mobile and desktop applications platform.

**Port already in use on `npm run auth`** — change `M365_AUTH_PORT` in `.env` and update the Azure redirect URI to match.

**Nothing appears in Claude's tool list** — run `npx @modelcontextprotocol/inspector node dist/index.js` (or `npm run inspect`) to check the server independently of the client, then check the client's MCP logs for a spawn or path error.
