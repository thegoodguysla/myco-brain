/**
 * Query logger — writes every MCP tool call to brain_queries.
 * Called after each tool executes so latency_ms can be captured.
 */
import type pg from "pg";
import { getPool } from "./db.js";

export interface QueryLogEntry {
  workspaceId: string;
  agentId?: string;
  toolName: string;
  input: Record<string, unknown>;
  outputHash?: string;
  latencyMs?: number;
}

/**
 * Strip credentials from tool inputs before they are persisted. brain_queries
 * is a workspace-readable audit table — an API key written there would leak
 * to every agent with stats access.
 */
const SENSITIVE_INPUT_KEYS = /^(api_key|apikey|.*_secret|.*_token|password)$/i;

export function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = SENSITIVE_INPUT_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

export async function logQuery(entry: QueryLogEntry): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO brain_queries
         (workspace_id, agent_id, tool_name, input, output_hash, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.workspaceId,
        entry.agentId ?? null,
        entry.toolName,
        JSON.stringify(redactInput(entry.input)),
        entry.outputHash ?? null,
        entry.latencyMs ?? null,
      ]
    );
  } catch (err) {
    // Non-fatal — log to stderr but don't surface to caller
    console.error("[brain-logger] Failed to write brain_queries:", err);
  }
}

/**
 * Wrap an async tool handler with automatic timing + query logging.
 */
export function withLogging<TInput extends Record<string, unknown>, TOutput>(
  toolName: string,
  workspaceId: string,
  agentId: string | undefined,
  input: TInput,
  fn: () => Promise<TOutput>
): Promise<TOutput> {
  const start = Date.now();
  return fn().then(
    async (result) => {
      await logQuery({
        workspaceId,
        agentId,
        toolName,
        input,
        latencyMs: Date.now() - start,
      });
      return result;
    },
    async (err: unknown) => {
      await logQuery({
        workspaceId,
        agentId,
        toolName,
        input,
        latencyMs: Date.now() - start,
      });
      throw err;
    }
  );
}
