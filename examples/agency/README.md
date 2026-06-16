# Run an agency on Myco Brain

Give every client their own isolated memory, share one agency-wide playbook,
and prove to clients that their data can't leak into each other's — because
the isolation is **Postgres row-level security**, not application code you'd
have to trust.

## The model

```
agency tenant
├── client-a workspace      ← Client A's agents read/write only this
├── client-b workspace      ← Client B's agents read/write only this
├── …
└── agency-playbook         ← read-only knowledge every client's agent shares
```

One workspace per client. A session scoped to Client A physically cannot
return Client B's rows — the `workspace_isolation` RLS policy on every table
filters on the session's `app.workspace_id`.

## The one thing you must get right

RLS is **ignored by superusers and BYPASSRLS roles**. The default quickstart
connects as `brain`, which is a superuser — perfect for a single-tenant
install, but it means RLS won't bind and clients would NOT be isolated. For an
agency you connect the MCP server as a **least-privilege role** instead.

### 1. Create the app role (once)

```bash
psql "$ADMIN_DATABASE_URL" \
  -v app_password="'choose-a-strong-password'" \
  -f sql/01_least_privilege_role.sql

# verify both come back 'f':
psql "$ADMIN_DATABASE_URL" -c \
  "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='brain_app'"
```

`brain_app` is not a superuser, has no BYPASSRLS, and does not own the tables —
so every workspace-isolation policy binds it.

### 2. Provision clients

```bash
cp clients.example.json clients.json   # edit: your agency + client list

ADMIN_DATABASE_URL=postgresql://brain:brain@localhost:5432/brain \
APP_DATABASE_URL=postgresql://brain_app:choose-a-strong-password@localhost:5432/brain \
  node provision.mjs ./clients.json
```

It creates the tenant, one workspace + agent per client, the shared playbook,
and prints each client's MCP config — two servers per client: `brain` (their
workspace, read/write) and `agency-playbook` (shared, read-only), both
connecting as `brain_app`.

### 3. Hand each client their config

Drop the printed `mcpServers` block into that client's Claude Code / Desktop /
Cursor config. Their agents now read and write only their own workspace, plus
the shared playbook.

## Prove the isolation (the sales demo)

```bash
cd ../../mcp-server && npm run test:agency
```

It provisions two clients, gives each a private fact, and shows — through the
least-privilege role — that Client A's session sees its own facts and **zero**
of Client B's, while demonstrating that the superuser default would bypass
that. This is the receipt you show a prospective client.

## Operating notes

- **Migrations & admin** still run as the superuser (`brain`); only the live
  MCP server + extraction worker connect as `brain_app`.
- **Adding a client later**: append to `clients.json` and re-run
  `provision.mjs` — it's idempotent (reuses existing workspaces by slug).
- **The playbook is read-only by convention** (hand clients the playbook key
  for reads only). A future release will enforce read-only at the role level.
