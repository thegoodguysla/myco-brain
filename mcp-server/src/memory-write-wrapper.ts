/**
 * brain memory-write-wrapper — mandatory write contract enforcement.
 *
 * THE-409B: Every agent memory write MUST pass through this wrapper, which:
 *   1. Validates required fields (idempotency_key, trace_id)
 *   2. Deduplicates by (workspace_id, idempotency_key) using ON CONFLICT
 *   3. Persists raw payload + summary in the canonical memory_write_events table
 *   4. Propagates trace lineage (trace_id, span_id, causal_parent_id)
 *
 * Non-negotiable invariants:
 *   - idempotency_key is REQUIRED — writes without it are rejected
 *   - trace_id is REQUIRED — no untraceable writes
 *   - Replay with the same idempotency_key does not duplicate rows
 *   - raw_payload (original event) + summary (derived) are both persisted
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SessionContext } from "./db.js";

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface MemoryWriteEnvelope {
  /** Client-generated unique key for idempotency. Same key = same write. REQUIRED. */
  idempotency_key: string;
  /** End-to-end trace identifier. REQUIRED. */
  trace_id: string;
  /** Operation-level span identifier. Auto-generated if not provided. */
  span_id?: string;
  /** Parent span in the causal chain. */
  causal_parent_id?: string;
  /** The raw/original event payload (full transcript, full tool output, etc.). */
  raw_payload: Record<string, unknown>;
  /** A derived summary of the raw payload. */
  summary: string;
  /** The kind of memory write (save_memory, annotate, propose_fact, ingest). */
  kind: "save_memory" | "annotate" | "propose_fact" | "ingest";
}

export interface MemoryWriteResult {
  /** The event_id of the persisted memory_write_events row. */
  event_id: string;
  /** true if this was a new write, false if it was a duplicate (idempotent replay). */
  created: boolean;
  /** The span_id used for this write. */
  span_id: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class MemoryWriteRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryWriteRejectionError";
  }
}

function validateEnvelope(envelope: MemoryWriteEnvelope): void {
  if (!envelope.idempotency_key || envelope.idempotency_key.trim().length === 0) {
    throw new MemoryWriteRejectionError(
      "REJECTED: idempotency_key is required. Every memory write must carry a unique idempotency key."
    );
  }
  if (!envelope.trace_id || envelope.trace_id.trim().length === 0) {
    throw new MemoryWriteRejectionError(
      "REJECTED: trace_id is required. Every memory write must carry an end-to-end trace identifier."
    );
  }
  if (!envelope.raw_payload || typeof envelope.raw_payload !== "object") {
    throw new MemoryWriteRejectionError(
      "REJECTED: raw_payload is required. Every memory write must include the raw event data."
    );
  }
  if (!envelope.summary || envelope.summary.trim().length === 0) {
    throw new MemoryWriteRejectionError(
      "REJECTED: summary is required. Every memory write must include a derived summary."
    );
  }
}

// ---------------------------------------------------------------------------
// Canonical write function
// ---------------------------------------------------------------------------

/**
 * Write a memory event with mandatory idempotency and trace enforcement.
 *
 * This is the SINGLE canonical write path for all agent memory writes.
 * All write tools (save_memory, annotate, propose_fact, ingest) MUST call
 * this function to persist their events.
 *
 * Idempotency: ON CONFLICT (workspace_id, idempotency_key) DO NOTHING.
 * If the same idempotency_key is replayed, the write is silently dropped
 * and the existing event_id is returned.
 */
export async function writeMemory(
  client: pg.PoolClient,
  ctx: SessionContext,
  envelope: MemoryWriteEnvelope
): Promise<MemoryWriteResult> {
  // 1. Validate required fields — reject on missing
  validateEnvelope(envelope);

  // 2. Auto-generate span_id if not provided
  const spanId = envelope.span_id ?? randomUUID();

  // 3. Write to canonical event log with idempotency guard
  //    processing_status = 'pending' — downstream tools mark 'completed' or 'failed'
  const res = await client.query(
    `INSERT INTO memory_write_events
       (workspace_id, agent_id, idempotency_key, trace_id, span_id,
        causal_parent_id, kind, raw_payload, summary, processing_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     ON CONFLICT (workspace_id, idempotency_key)
     DO NOTHING
     RETURNING event_id`,
    [
      ctx.workspaceId,
      ctx.actorId,
      envelope.idempotency_key,
      envelope.trace_id,
      spanId,
      envelope.causal_parent_id ?? null,
      envelope.kind,
      JSON.stringify(envelope.raw_payload),
      envelope.summary,
    ]
  );

  // 4. Determine if this was a new write or an idempotent replay
  if (res.rows.length > 0) {
    // New write
    return {
      event_id: res.rows[0].event_id,
      created: true,
      span_id: spanId,
    };
  }

  // Idempotent replay — fetch the existing event_id
  const existing = await client.query(
    `SELECT event_id, span_id FROM memory_write_events
     WHERE workspace_id = $1 AND idempotency_key = $2`,
    [ctx.workspaceId, envelope.idempotency_key]
  );

  return {
    event_id: existing.rows[0]?.event_id ?? "",
    created: false,
    span_id: existing.rows[0]?.span_id ?? spanId,
  };
}

/**
 * Query the full causal chain for a given trace_id.
 *
 * Returns all memory_write_events in the same trace, ordered by created_at.
 */
export async function queryTraceChain(
  client: pg.PoolClient,
  workspaceId: string,
  traceId: string
): Promise<MemoryWriteEnvelope[]> {
  const res = await client.query(
    `SELECT idempotency_key, trace_id, span_id, causal_parent_id,
            kind, raw_payload, summary, created_at
     FROM memory_write_events
     WHERE workspace_id = $1 AND trace_id = $2
     ORDER BY created_at ASC`,
    [workspaceId, traceId]
  );

  return res.rows.map((r) => ({
    idempotency_key: r.idempotency_key,
    trace_id: r.trace_id,
    span_id: r.span_id,
    causal_parent_id: r.causal_parent_id,
    kind: r.kind,
    raw_payload: r.raw_payload as Record<string, unknown>,
    summary: r.summary,
  }));
}

// ---------------------------------------------------------------------------
// Processing lifecycle helpers (THE-414)
// ---------------------------------------------------------------------------

/**
 * Mark a memory_write_event as completed after all downstream writes succeeded.
 */
export async function markEventCompleted(
  client: pg.PoolClient,
  workspaceId: string,
  eventId: string
): Promise<void> {
  await client.query(
    `UPDATE memory_write_events
     SET processing_status = 'completed',
         processing_error = NULL,
         processed_at = now()
     WHERE event_id = $1 AND workspace_id = $2`,
    [eventId, workspaceId]
  );
}

/**
 * Mark a memory_write_event as failed with an error message.
 * Increments retry_count and records last_retry_at.
 */
export async function markEventFailed(
  client: pg.PoolClient,
  workspaceId: string,
  eventId: string,
  error: string
): Promise<void> {
  await client.query(
    `UPDATE memory_write_events
     SET processing_status = 'failed',
         processing_error = $3,
         retry_count = retry_count + 1,
         last_retry_at = now(),
         processed_at = now()
     WHERE event_id = $1 AND workspace_id = $2`,
    [eventId, workspaceId, error]
  );
}

/**
 * Mark a memory_write_event as dead-lettered after exhausting max retries.
 * Transitions from 'failed' to 'dead_lettered' with a reason.
 * Events in other states are not affected.
 */
export async function markEventDeadLettered(
  client: pg.PoolClient,
  workspaceId: string,
  eventId: string,
  reason: string
): Promise<void> {
  await client.query(
    `UPDATE memory_write_events
     SET processing_status = 'dead_lettered',
         dead_letter_reason = $3,
         processed_at = now()
     WHERE event_id = $1
       AND workspace_id = $2
       AND processing_status = 'failed'`,
    [eventId, workspaceId, reason]
  );
}
