/**
 * BM25 hybrid re-ranker unit tests.
 *
 * Validates correctness of tokenizer, scoring, normalization and the
 * entity-dense query scenario that motivated the MemPalace extraction.
 */
import { describe, it, expect } from "vitest";
import {
  tokenize,
  bm25Scores,
  minMaxNormalize,
  hybridScore,
  CLOSET_BOOST_RANKS,
  VEC_WEIGHT,
  BM25_WEIGHT,
} from "./bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });

  it("drops single-character tokens", () => {
    expect(tokenize("a big cat")).toEqual(["big", "cat"]);
  });

  it("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles alphanumeric tokens like product names", () => {
    expect(tokenize("GPT-4o launch Q2")).toEqual(["gpt", "4o", "launch", "q2"]);
  });
});

describe("bm25Scores", () => {
  const docs = [
    { id: "a", text: "OpenAI launched GPT-4o in San Francisco this week" },
    { id: "b", text: "The weather in San Francisco is mild today" },
    { id: "c", text: "GPT-4o outperforms previous models on benchmarks" },
  ];

  it("returns map with one entry per doc", () => {
    const scores = bm25Scores(tokenize("GPT-4o San Francisco"), docs);
    expect(scores.size).toBe(3);
  });

  it("doc with more query term hits scores higher", () => {
    const scores = bm25Scores(tokenize("GPT-4o San Francisco"), docs);
    // doc a mentions both "gpt-4o" (→ gpt, 4o) and "san francisco"
    // doc b only mentions "san francisco"
    // doc c only mentions "gpt-4o"
    expect(scores.get("a")!).toBeGreaterThan(scores.get("b")!);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("c")!);
  });

  it("doc with no query term overlap scores zero", () => {
    const scores = bm25Scores(tokenize("quantum computing"), docs);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
    expect(scores.get("c")).toBe(0);
  });

  it("returns empty map for empty corpus", () => {
    const scores = bm25Scores(tokenize("test"), []);
    expect(scores.size).toBe(0);
  });

  it("returns empty map for empty query", () => {
    const scores = bm25Scores([], docs);
    expect(scores.size).toBe(0);
  });
});

describe("minMaxNormalize", () => {
  it("normalizes to [0, 1]", () => {
    const raw = new Map([
      ["a", 4.0],
      ["b", 2.0],
      ["c", 0.0],
    ]);
    const norm = minMaxNormalize(raw);
    expect(norm.get("a")).toBeCloseTo(1.0);
    expect(norm.get("c")).toBeCloseTo(0.0);
    expect(norm.get("b")).toBeCloseTo(0.5);
  });

  it("maps all-equal scores to 0", () => {
    const raw = new Map([
      ["a", 3.0],
      ["b", 3.0],
    ]);
    const norm = minMaxNormalize(raw);
    expect(norm.get("a")).toBe(0);
    expect(norm.get("b")).toBe(0);
  });

  it("handles empty map", () => {
    expect(minMaxNormalize(new Map()).size).toBe(0);
  });
});

describe("hybridScore", () => {
  it("blends at correct weights", () => {
    expect(hybridScore(1.0, 1.0)).toBeCloseTo(VEC_WEIGHT + BM25_WEIGHT);
    expect(hybridScore(1.0, 0.0)).toBeCloseTo(VEC_WEIGHT);
    expect(hybridScore(0.0, 1.0)).toBeCloseTo(BM25_WEIGHT);
  });
});

describe("CLOSET_BOOST_RANKS", () => {
  it("has 5 entries summing to <= 1.0", () => {
    expect(CLOSET_BOOST_RANKS.length).toBe(5);
    const total = CLOSET_BOOST_RANKS.reduce((s, v) => s + v, 0);
    expect(total).toBeLessThanOrEqual(1.0);
  });

  it("is strictly decreasing", () => {
    for (let i = 1; i < CLOSET_BOOST_RANKS.length; i++) {
      expect(CLOSET_BOOST_RANKS[i]).toBeLessThan(CLOSET_BOOST_RANKS[i - 1]);
    }
  });
});

describe("entity-dense query simulation", () => {
  it("ranks entity-dense chunk above generic chunk", () => {
    // Simulates the LongMemEval scenario: proper nouns push R@5 from 96.6% to 99.4%
    const query = "Acme Corp acquisition deal signed in Tokyo";
    const queryTokens = tokenize(query);

    const docs = [
      {
        id: "entity-rich",
        text: "Acme Corp signed the acquisition deal in Tokyo last Thursday at Narita conference center",
      },
      {
        id: "generic",
        text: "The deal was signed and confirmed by both parties in a formal ceremony",
      },
      {
        id: "partial",
        text: "Acme Corp announced a partnership but no acquisition was finalized",
      },
    ];

    const raw = bm25Scores(queryTokens, docs);
    const norm = minMaxNormalize(raw);

    // Entity-rich doc should score highest
    expect(norm.get("entity-rich")!).toBeGreaterThan(norm.get("generic")!);
    expect(norm.get("entity-rich")!).toBeGreaterThan(norm.get("partial")!);

    // Hybrid blends (simulated vec_sim: entity-rich=0.85, partial=0.80, generic=0.60)
    const hybridEntityRich = hybridScore(0.85, norm.get("entity-rich")!);
    const hybridGeneric = hybridScore(0.6, norm.get("generic")!);
    const hybridPartial = hybridScore(0.8, norm.get("partial")!);

    expect(hybridEntityRich).toBeGreaterThan(hybridGeneric);
    expect(hybridEntityRich).toBeGreaterThan(hybridPartial);
  });
});
