/**
 * Extraction-worker chunk lifecycle — claim, reap, fail.
 *
 * Extracted from the worker loop so the durability guarantees are gated by a
 * test (test/extraction-reliability-check.mjs) instead of living inline in a
 * long-running script:
 *
 *   - reapStaleProcessing — a worker that claims a chunk (status='processing')
 *     then crashes or is restarted before recording an outcome leaves that
 *     chunk stranded forever (claimBatch only looks at 'pending'/'failed').
 *     This reclaims chunks whose processing lease has expired: those with
 *     attempts left return to 'pending'; those that have exhausted their
 *     attempts become terminally 'failed' (never silently stuck).
 *   - claimChunkBatch — atomically lease a batch of pending/failed chunks under
 *     FOR UPDATE SKIP LOCKED so concurrent workers never double-claim.
 *   - markChunkFailed — make the terminal decision by ATTEMPTS, not by a
 *     fragile substring of the error text. A retry-exhausted chunk becomes
 *     'failed' (visible to operators and brain_stats); otherwise it returns to
 *     'pending' for another attempt.
 */
import type pg from "pg";

export interface ClaimedChunk {
  chunkId: string;
  hyobjectId: string;
  workspaceId: string;
  text: string;
}

export interface LifecycleOptions {
  maxAttempts: number;
  /**
   * How long a chunk may sit in 'processing' before a crashed/restarted worker
   * is assumed and the chunk is reclaimed. Must exceed the worst-case
   * single-chunk extraction time so an in-flight chunk is never stolen.
   */
  leaseMs: number;
}

/**
 * Recover chunks stranded in 'processing' by a worker that died mid-extraction.
 * Chunks whose lease expired return to 'pending' (more attempts left) or
 * 'failed' (attempts exhausted — terminal, not stuck). Returns rows recovered.
 */
export async function reapStaleProcessing(
  client: pg.PoolClient,
  workspaceId: string,
  opts: LifecycleOptions,
): Promise<number> {
  const res = await client.query(
    `UPDATE chunk_extraction_status
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            last_error = COALESCE(last_error,
              'reclaimed: worker did not finish before the processing lease expired'),
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('reaped_at', now())
      WHERE workspace_id = $1
        AND status = 'processing'
        AND updated_at < now() - ($3 * interval '1 millisecond')`,
    [workspaceId, opts.maxAttempts, opts.leaseMs],
  );
  return res.rowCount ?? 0;
}

/**
 * Atomically lease up to batchSize pending/failed chunks for extraction,
 * incrementing attempts (so a chunk that keeps crashing the worker still
 * exhausts its retries). Stale 'processing' chunks are recovered separately by
 * reapStaleProcessing before this runs.
 */
export async function claimChunkBatch(
  client: pg.PoolClient,
  workspaceId: string,
  opts: LifecycleOptions & { batchSize: number },
): Promise<ClaimedChunk[]> {
  const claimed = await client.query<ClaimedChunk>(
    `WITH candidate AS (
       SELECT ces.chunk_id, c.hyobject_id, c.workspace_id, c.text
       FROM chunk_extraction_status ces
       JOIN chunks c ON c.chunk_id = ces.chunk_id
       WHERE ces.workspace_id = $1
         AND ces.status IN ('pending','failed')
         AND ces.attempts < $2
       ORDER BY ces.updated_at ASC
       LIMIT $3
       FOR UPDATE OF ces SKIP LOCKED
     )
     UPDATE chunk_extraction_status ces
     SET status = 'processing',
         attempts = attempts + 1,
         last_error = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('claimed_at', now())
     FROM candidate
     WHERE ces.chunk_id = candidate.chunk_id
     RETURNING candidate.chunk_id AS "chunkId",
               candidate.hyobject_id AS "hyobjectId",
               candidate.workspace_id AS "workspaceId",
               candidate.text AS text`,
    [workspaceId, opts.maxAttempts, opts.batchSize],
  );
  return claimed.rows;
}

/**
 * Record an extraction failure. A chunk that has used all its attempts is
 * marked terminally 'failed' (so it shows as failed, not stuck 'pending');
 * otherwise it returns to 'pending' for another lease. Returns the new status.
 */
export async function markChunkFailed(
  client: pg.PoolClient,
  chunkId: string,
  error: string,
  opts: { maxAttempts: number },
): Promise<"failed" | "pending"> {
  const res = await client.query<{ status: "failed" | "pending" }>(
    `UPDATE chunk_extraction_status
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = left($2, 2000),
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('last_failed_at', now())
      WHERE chunk_id = $1
      RETURNING status`,
    [chunkId, error, opts.maxAttempts],
  );
  return res.rows[0]?.status ?? "pending";
}
