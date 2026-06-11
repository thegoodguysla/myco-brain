/**
 * Database connection pool and per-request session context.
 *
 * Every MCP tool call wraps its queries in a transaction and uses
 * set_config() to establish the RLS context vars required for isolation:
 *   app.workspace_id   — workspace isolation
 *   app.tenant_id      — tenant isolation
 *   app.principal_role — 'human' | 'agent' | 'llm' | 'service'
 *   app.actor_id       — agent_id or user id string
 */
import pg from "pg";

const { Pool } = pg;
type PgError = Error & { code?: string };
type SslMode = "auto" | "forced" | "disabled";

export interface SessionContext {
  workspaceId: string;
  tenantId?: string;
  principalRole: "human" | "agent" | "llm" | "service";
  actorId: string;
  actorKind?: "human" | "program" | "llm" | "agent";
  reason?: string;
}

export class WorkspaceDisabledError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} is disabled`);
    this.name = "WorkspaceDisabledError";
  }
}

let pool: pg.Pool | null = null;
let sslMode: SslMode =
  process.env.DATABASE_SSL === "false"
    ? "disabled"
    : process.env.DATABASE_SSL === "true"
      ? "forced"
      : "auto";

function sslConfigForMode(mode: SslMode): false | { rejectUnauthorized: false } | undefined {
  if (mode === "disabled") return false;
  if (mode === "forced") return { rejectUnauthorized: false };
  return undefined;
}

function makePool(connectionString: string, mode: SslMode): pg.Pool {
  const next = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: sslConfigForMode(mode),
  });
  next.on("error", (err) => {
    console.error("[brain-db] Unexpected pool error:", err.message);
  });
  return next;
}

function isSslUnsupportedError(err: unknown): boolean {
  const msg = (err as Error | undefined)?.message ?? "";
  return /does not support ssl connections/i.test(msg);
}

export function toNonSslConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    parsed.searchParams.delete("ssl");
    parsed.searchParams.delete("sslcert");
    parsed.searchParams.delete("sslkey");
    parsed.searchParams.delete("sslrootcert");
    return parsed.toString();
  } catch {
    return connectionString
      .replace(/([?&])sslmode=[^&]*/gi, "$1")
      .replace(/([?&])ssl=[^&]*/gi, "$1")
      .replace(/([?&])sslcert=[^&]*/gi, "$1")
      .replace(/([?&])sslkey=[^&]*/gi, "$1")
      .replace(/([?&])sslrootcert=[^&]*/gi, "$1")
      .replace(/[?&]$/, "");
  }
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString =
      process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL or SUPABASE_DB_URL environment variable is required"
      );
    }
    pool = makePool(connectionString, sslMode);
  }
  return pool;
}

export async function queryWithSslFallback(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult> {
  try {
    return params === undefined
      ? await getPool().query(text)
      : await getPool().query(text, params);
  } catch (err) {
    if (
      sslMode !== "disabled" &&
      process.env.DATABASE_SSL !== "true" &&
      isSslUnsupportedError(err)
    ) {
      console.warn(
        "[brain-db] SSL query rejected by server, retrying with ssl disabled"
      );
      const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
      if (!connectionString) throw err;
      if (pool) {
        await pool.end().catch(() => undefined);
      }
      sslMode = "disabled";
      pool = makePool(toNonSslConnectionString(connectionString), sslMode);
      return params === undefined
        ? await pool.query(text)
        : await pool.query(text, params);
    }
    throw err;
  }
}

async function acquireClientWithSslFallback(): Promise<pg.PoolClient> {
  try {
    return await getPool().connect();
  } catch (err) {
    if (
      sslMode !== "disabled" &&
      process.env.DATABASE_SSL !== "true" &&
      isSslUnsupportedError(err)
    ) {
      console.warn(
        "[brain-db] SSL connection rejected by server, retrying with ssl disabled"
      );
      const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
      if (!connectionString) throw err;
      if (pool) {
        await pool.end().catch(() => undefined);
      }
      sslMode = "disabled";
      pool = makePool(toNonSslConnectionString(connectionString), sslMode);
      return pool.connect();
    }
    throw err;
  }
}

/**
 * Run a callback inside a transaction with RLS context applied via
 * parameterized set_config() calls. The context is set with is_local=true
 * so it only lives inside this transaction.
 */
export async function withSession<T>(
  ctx: SessionContext,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await acquireClientWithSslFallback();
  try {
    // Check tenant status before entering the transaction
    const status = await client.query(
      `SELECT COALESCE(settings->>'tenant_status', 'active') AS tenant_status
       FROM workspaces
       WHERE workspace_id = $1`,
      [ctx.workspaceId]
    );
    if (status.rowCount === 0) {
      throw new Error(`Workspace ${ctx.workspaceId} not found`);
    }
    if (status.rows[0]?.tenant_status === "disabled") {
      throw new WorkspaceDisabledError(ctx.workspaceId);
    }

    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [
      ctx.workspaceId,
    ]);

    // Resolve tenant_id: use explicit ctx.tenantId, or look it up from workspace
    let tenantId = ctx.tenantId;
    if (!tenantId) {
      await client.query("SAVEPOINT tenant_lookup");
      try {
        const res = await client.query(
          `SELECT tenant_id FROM workspaces WHERE workspace_id = $1`,
          [ctx.workspaceId]
        );
        if (res.rowCount && res.rowCount > 0) {
          tenantId = res.rows[0].tenant_id;
        }
        await client.query("RELEASE SAVEPOINT tenant_lookup");
      } catch (err) {
        const pgErr = err as PgError;
        // Backward compatibility: some deployed DBs do not yet have tenant isolation columns.
        if (pgErr.code !== "42703" && pgErr.code !== "42P01") {
          throw err;
        }
        await client.query("ROLLBACK TO SAVEPOINT tenant_lookup");
        await client.query("RELEASE SAVEPOINT tenant_lookup");
      }
    }
    if (tenantId) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
    }

    await client.query(`SELECT set_config('app.principal_role', $1, true)`, [
      ctx.principalRole,
    ]);
    await client.query(`SELECT set_config('app.actor_id', $1, true)`, [
      ctx.actorId,
    ]);
    if (ctx.actorKind) {
      await client.query(`SELECT set_config('app.actor_kind', $1, true)`, [
        ctx.actorKind,
      ]);
    }
    if (ctx.reason) {
      await client.query(`SELECT set_config('app.reason', $1, true)`, [
        ctx.reason,
      ]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
