# @mycobrain/install

One command to connect [Myco Brain](https://mycobrain.dev) — self-hosted, source-traceable memory for AI agents — to your coding agent.

```bash
# Boot the stack once (Postgres + pgvector + MCP server, no API keys):
git clone https://github.com/thegoodguysla/myco-brain.git && cd myco-brain && docker compose up -d

# Then wire your client and onboard, in one command:
npx @mycobrain/install
```

It detects your installed MCP clients and writes the right config for each, then runs onboarding so your agent can recall this project across sessions.

```bash
npx @mycobrain/install --client cursor     # a specific client
npx @mycobrain/install --all               # every supported client
npx @mycobrain/install --print             # just print the snippet + agent instructions
```

Supported clients: Claude Code, Claude Desktop, Cursor, Codex, Windsurf (Continue, Zed, Cline via `--print`).

This is a thin launcher for the installer in [`@mycobrain/mcp-server`](https://www.npmjs.com/package/@mycobrain/mcp-server). Learn more at [github.com/thegoodguysla/myco-brain](https://github.com/thegoodguysla/myco-brain).
