type RetrievalOperation = "search" | "context_pack";

interface OperationMetrics {
  successes: number;
  errors: number;
  last_duration_ms: number | null;
  avg_duration_ms: number | null;
  max_duration_ms: number | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
}

const startedAtMs = Date.now();

const metrics: Record<RetrievalOperation, OperationMetrics> = {
  search: emptyMetrics(),
  context_pack: emptyMetrics(),
};

function emptyMetrics(): OperationMetrics {
  return {
    successes: 0,
    errors: 0,
    last_duration_ms: null,
    avg_duration_ms: null,
    max_duration_ms: null,
    last_success_at: null,
    last_error_at: null,
    last_error_message: null,
  };
}

function bumpDuration(m: OperationMetrics, durationMs: number): void {
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  m.last_duration_ms = duration;
  if (m.avg_duration_ms === null) {
    m.avg_duration_ms = duration;
  } else {
    const n = m.successes + m.errors;
    m.avg_duration_ms = (m.avg_duration_ms * (n - 1) + duration) / n;
  }
  if (m.max_duration_ms === null || duration > m.max_duration_ms) {
    m.max_duration_ms = duration;
  }
}

export function recordRetrievalSuccess(
  operation: RetrievalOperation,
  durationMs: number
): void {
  const m = metrics[operation];
  m.successes += 1;
  bumpDuration(m, durationMs);
  m.last_success_at = new Date().toISOString();
}

export function recordRetrievalError(
  operation: RetrievalOperation,
  durationMs: number,
  err: unknown
): void {
  const m = metrics[operation];
  m.errors += 1;
  bumpDuration(m, durationMs);
  m.last_error_at = new Date().toISOString();
  m.last_error_message = err instanceof Error ? err.message : String(err);
}

export function getRetrievalObservabilitySnapshot() {
  const totalSuccesses = metrics.search.successes + metrics.context_pack.successes;
  const totalErrors = metrics.search.errors + metrics.context_pack.errors;
  const total = totalSuccesses + totalErrors;
  return {
    protocol_version: "2026-05-15" as const,
    uptime_seconds: Math.floor((Date.now() - startedAtMs) / 1000),
    totals: {
      successes: totalSuccesses,
      errors: totalErrors,
      error_rate: total > 0 ? totalErrors / total : 0,
    },
    operations: {
      search: { ...metrics.search },
      context_pack: { ...metrics.context_pack },
    },
  };
}
