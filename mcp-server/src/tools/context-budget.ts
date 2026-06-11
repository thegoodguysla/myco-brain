const CHARS_PER_TOKEN = 4;

export interface BudgetCompactionChunk {
  chunk_id: string;
  text: string;
  token_count?: number | null;
}

export interface BudgetCompactionStats {
  requested_budget_tokens: number | null;
  budget_applied: boolean;
  candidate_tokens: number;
  returned_tokens: number;
  dropped_chunks: number;
  truncated_chunks: number;
}

export interface BudgetCompactionResult<T extends BudgetCompactionChunk> {
  chunks: T[];
  stats: BudgetCompactionStats;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function chunkTokens(chunk: BudgetCompactionChunk): number {
  if (
    typeof chunk.token_count === "number" &&
    Number.isFinite(chunk.token_count) &&
    chunk.token_count > 0
  ) {
    return Math.floor(chunk.token_count);
  }
  return estimateTokens(chunk.text);
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || text.length === 0) return "";
  const maxChars = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, maxChars - 1)).trimEnd() + "…";
}

function normalizeBudget(tokenBudget: number | undefined): number | null {
  return typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0
    ? Math.floor(tokenBudget)
    : null;
}

export class BudgetGovernor {
  compact<T extends BudgetCompactionChunk>(
    chunks: T[],
    tokenBudget: number | undefined
  ): BudgetCompactionResult<T> {
    const requested_budget_tokens = normalizeBudget(tokenBudget);
    const candidate_tokens = chunks.reduce((sum, c) => sum + chunkTokens(c), 0);

    if (!requested_budget_tokens) {
      return {
        chunks,
        stats: {
          requested_budget_tokens,
          budget_applied: false,
          candidate_tokens,
          returned_tokens: candidate_tokens,
          dropped_chunks: 0,
          truncated_chunks: 0,
        },
      };
    }

    let remaining = requested_budget_tokens;
    let dropped_chunks = 0;
    let truncated_chunks = 0;
    const kept: T[] = [];
    let returned_tokens = 0;

    for (const chunk of chunks) {
      const tokens = chunkTokens(chunk);

      if (tokens <= remaining) {
        kept.push(chunk);
        remaining -= tokens;
        returned_tokens += tokens;
        continue;
      }

      if (kept.length === 0 && remaining > 0) {
        const truncatedText = truncateToTokens(chunk.text, remaining);
        if (truncatedText.length > 0) {
          kept.push({
            ...chunk,
            text: truncatedText,
            token_count: remaining,
          });
          returned_tokens += remaining;
          truncated_chunks += 1;
        } else {
          dropped_chunks += 1;
        }
      } else {
        dropped_chunks += 1;
      }

      break;
    }

    dropped_chunks += Math.max(0, chunks.length - kept.length - dropped_chunks);

    return {
      chunks: kept,
      stats: {
        requested_budget_tokens,
        budget_applied: true,
        candidate_tokens,
        returned_tokens,
        dropped_chunks,
        truncated_chunks,
      },
    };
  }
}

const defaultBudgetGovernor = new BudgetGovernor();

export function compactChunksToTokenBudget<T extends BudgetCompactionChunk>(
  chunks: T[],
  tokenBudget: number | undefined
): BudgetCompactionResult<T> {
  return defaultBudgetGovernor.compact(chunks, tokenBudget);
}
