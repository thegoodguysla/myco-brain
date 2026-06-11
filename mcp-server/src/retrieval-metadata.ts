export interface RetrievalMetadataScorable {
  score: number;
  created_at: string;
  hyobject_id: string;
  hyobject_type_id: number;
}

export interface RetrievalMetadataStats {
  confidence_stats: {
    mean: number | null;
    min: number | null;
    max: number | null;
  };
  temporal_range: {
    earliest: string | null;
    latest: string | null;
  };
  source_statistics: {
    unique_sources: number;
    source_types: Record<number, number>;
    oldest_source: string | null;
    newest_source: string | null;
  };
}

export function computeRetrievalMetadataStats(
  rows: RetrievalMetadataScorable[]
): RetrievalMetadataStats {
  if (!rows.length) {
    return {
      confidence_stats: { mean: null, min: null, max: null },
      temporal_range: { earliest: null, latest: null },
      source_statistics: {
        unique_sources: 0,
        source_types: {},
        oldest_source: null,
        newest_source: null,
      },
    };
  }

  let scoreSum = 0;
  let minScore = Number.POSITIVE_INFINITY;
  let maxScore = Number.NEGATIVE_INFINITY;

  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = Number.NEGATIVE_INFINITY;
  let oldestSourceMs = Number.POSITIVE_INFINITY;
  let newestSourceMs = Number.NEGATIVE_INFINITY;

  const uniqueSources = new Set<string>();
  const sourceTypes = new Map<number, number>();

  for (const row of rows) {
    scoreSum += row.score;
    if (row.score < minScore) minScore = row.score;
    if (row.score > maxScore) maxScore = row.score;

    uniqueSources.add(row.hyobject_id);
    sourceTypes.set(
      row.hyobject_type_id,
      (sourceTypes.get(row.hyobject_type_id) ?? 0) + 1
    );

    const createdAtMs = Date.parse(row.created_at);
    if (Number.isFinite(createdAtMs)) {
      if (createdAtMs < earliestMs) earliestMs = createdAtMs;
      if (createdAtMs > latestMs) latestMs = createdAtMs;
      if (createdAtMs < oldestSourceMs) oldestSourceMs = createdAtMs;
      if (createdAtMs > newestSourceMs) newestSourceMs = createdAtMs;
    }
  }

  const typeCounts: Record<number, number> = {};
  for (const [typeId, count] of sourceTypes.entries()) {
    typeCounts[typeId] = count;
  }

  return {
    confidence_stats: {
      mean: scoreSum / rows.length,
      min: Number.isFinite(minScore) ? minScore : null,
      max: Number.isFinite(maxScore) ? maxScore : null,
    },
    temporal_range: {
      earliest: Number.isFinite(earliestMs)
        ? new Date(earliestMs).toISOString()
        : null,
      latest: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null,
    },
    source_statistics: {
      unique_sources: uniqueSources.size,
      source_types: typeCounts,
      oldest_source: Number.isFinite(oldestSourceMs)
        ? new Date(oldestSourceMs).toISOString()
        : null,
      newest_source: Number.isFinite(newestSourceMs)
        ? new Date(newestSourceMs).toISOString()
        : null,
    },
  };
}
