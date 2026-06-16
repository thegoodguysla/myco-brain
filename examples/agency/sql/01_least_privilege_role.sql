-- Least-privilege application role for multi-tenant (agency) deployments.
--
-- WHY THIS EXISTS: workspace isolation in Myco Brain is enforced by Postgres
-- row-level security (the `workspace_isolation` policy on every table). RLS is
-- ignored by superusers and by roles with BYPASSRLS. The default quickstart
-- connects as `brain`, which IS a superuser — fine for a single-tenant install,
-- but it means RLS does not bind, so multiple client workspaces would NOT be
-- isolated from each other. An agency putting Client A and Client B in separate
-- workspaces MUST have the MCP server connect as a role that RLS binds.
--
-- This creates that role. The MCP server + extraction worker connect as
-- `brain_app`; migrations and admin tasks keep using the superuser.
--
-- Run as the superuser (e.g. `brain`). Pass the RAW password (no quotes):
--   psql "$ADMIN_DATABASE_URL" -v app_password=choose-a-strong-password \
--        -f 01_least_privilege_role.sql
-- Then point the server at:  postgresql://brain_app:<password>@host:5432/brain

\set ON_ERROR_STOP on

-- Create the role if missing (conditional DDL via \gexec).
SELECT format('CREATE ROLE brain_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_app')
\gexec

-- Otherwise refresh its password and (re)assert the safe attributes.
SELECT format('ALTER ROLE brain_app WITH LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_password')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = 'brain_app')
\gexec

-- Privileges on everything that exists today…
GRANT USAGE ON SCHEMA public TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO brain_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO brain_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO brain_app;

-- …and on everything future migrations create, so you never have to re-grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO brain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO brain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO brain_app;

-- brain_app is intentionally NOT the table owner and is NOBYPASSRLS, so every
-- workspace_isolation policy binds it. Verify after running:
--   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='brain_app';
--   -- both must be 'f'
