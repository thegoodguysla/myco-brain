import { describe, expect, it } from "vitest";
import { BudgetGovernor, compactChunksToTokenBudget } from "./tools/context-budget.js";

describe("context budget compaction (THE-629)", () => {
  const chunks = [
    { chunk_id: "a", text: "A".repeat(40), token_count: 10 },
    { chunk_id: "b", text: "B".repeat(40), token_count: 10 },
    { chunk_id: "c", text: "C".repeat(40), token_count: 10 },
  ];

  it("keeps full result when no budget requested", () => {
    const out = compactChunksToTokenBudget(chunks, undefined);
    expect(out.chunks).toHaveLength(3);
    expect(out.stats.budget_applied).toBe(false);
    expect(out.stats.returned_tokens).toBe(30);
  });

  it("drops tail chunks to enforce budget", () => {
    const out = compactChunksToTokenBudget(chunks, 20);
    expect(out.chunks.map((c) => c.chunk_id)).toEqual(["a", "b"]);
    expect(out.stats.budget_applied).toBe(true);
    expect(out.stats.returned_tokens).toBe(20);
    expect(out.stats.dropped_chunks).toBe(1);
    expect(out.stats.truncated_chunks).toBe(0);
  });

  it("truncates top chunk when first chunk exceeds budget", () => {
    const out = compactChunksToTokenBudget(chunks, 6);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].chunk_id).toBe("a");
    expect(out.chunks[0].text.endsWith("…")).toBe(true);
    expect(out.stats.returned_tokens).toBe(6);
    expect(out.stats.truncated_chunks).toBe(1);
    expect(out.stats.dropped_chunks).toBe(2);
  });

  it("exposes same compaction behavior via BudgetGovernor class", () => {
    const governor = new BudgetGovernor();
    const out = governor.compact(chunks, 20);
    expect(out.chunks.map((c) => c.chunk_id)).toEqual(["a", "b"]);
    expect(out.stats.returned_tokens).toBe(20);
    expect(out.stats.dropped_chunks).toBe(1);
  });

  it("treats invalid budgets as no-budget mode", () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = compactChunksToTokenBudget(chunks, budget);
      expect(out.chunks).toHaveLength(3);
      expect(out.stats.budget_applied).toBe(false);
      expect(out.stats.returned_tokens).toBe(30);
    }
  });

  it("falls back to text-length estimation when token_count is missing", () => {
    const estimatedChunks = [
      { chunk_id: "x", text: "x".repeat(20) },
      { chunk_id: "y", text: "y".repeat(20) },
    ];
    const out = compactChunksToTokenBudget(estimatedChunks, 3);
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0].chunk_id).toBe("x");
    expect(out.chunks[0].text.endsWith("…")).toBe(true);
    expect(out.stats.returned_tokens).toBe(3);
    expect(out.stats.truncated_chunks).toBe(1);
    expect(out.stats.dropped_chunks).toBe(1);
  });
});
