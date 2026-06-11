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
        JSON.stringify(entry.input),
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
