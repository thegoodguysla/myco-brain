import { describe, it, expect } from "vitest";
import {
  combineIndependentEvidence,
  dedupeBySource,
  DEFAULT_CAP,
} from "./confidence.js";

describe("combineIndependentEvidence", () => {
  it("returns 0 for no evidence", () => {
    expect(combineIndependentEvidence([])).toBe(0);
    expect(combineIndependentEvidence([0, 0])).toBe(0);
  });

  it("a single source keeps exactly the confidence extraction gave it", () => {
    // Backward compatibility: existing single-source edges must not move.
    expect(combineIndependentEvidence([0.9])).toBe(0.9);
    expect(combineIndependentEvidence([0.5])).toBe(0.5);
    expect(combineIndependentEvidence([0.97])).toBe(0.97);
  });

  it("corroboration raises confidence (closed form)", () => {
    // 1 - (1 - 0.9) * (1 - 0.4*0.8) = 1 - 0.1*0.68 = 0.932
    expect(combineIndependentEvidence([0.9, 0.8])).toBeCloseTo(0.932, 10);
    // duplicate-strength sources also compound: 1 - 0.1*(1-0.36) = 0.936
    expect(combineIndependentEvidence([0.9, 0.9])).toBeCloseTo(0.936, 10);
  });

  it("is order-independent", () => {
    expect(combineIndependentEvidence([0.8, 0.9])).toBe(
      combineIndependentEvidence([0.9, 0.8])
    );
    expect(combineIndependentEvidence([0.6, 0.7, 0.9])).toBe(
      combineIndependentEvidence([0.9, 0.6, 0.7])
    );
  });

  it("is monotonic: another source never lowers confidence", () => {
    const base = combineIndependentEvidence([0.9, 0.8]);
    expect(combineIndependentEvidence([0.9, 0.8, 0.2])).toBeGreaterThanOrEqual(base);
    expect(combineIndependentEvidence([0.9, 0.8, 0.9])).toBeGreaterThanOrEqual(base);
    // and never below the strongest single source
    expect(combineIndependentEvidence([0.9, 0.1])).toBeGreaterThanOrEqual(0.9);
  });

  it("caps corroboration short of certainty", () => {
    const many = combineIndependentEvidence([0.9, 0.9, 0.9, 0.9, 0.9, 0.9]);
    expect(many).toBeLessThanOrEqual(DEFAULT_CAP);
    expect(many).toBe(DEFAULT_CAP);
  });

  it("the cap never pulls a value below the strongest source", () => {
    // best source 0.97 > cap 0.95 — corroboration is capped at 0.97, not 0.95
    expect(combineIndependentEvidence([0.97, 0.5])).toBe(0.97);
  });

  it("clamps junk confidences", () => {
    expect(combineIndependentEvidence([1.7])).toBe(1); // clamped to 1, single source
    expect(combineIndependentEvidence([-3])).toBe(0);
    expect(combineIndependentEvidence([Number.NaN, 0.8])).toBe(0.8);
  });
});

describe("dedupeBySource", () => {
  it("keeps the max confidence per source", () => {
    const got = dedupeBySource([
      { sourceId: "a", confidence: 0.6 },
      { sourceId: "a", confidence: 0.9 },
      { sourceId: "b", confidence: 0.7 },
    ]).sort();
    expect(got).toEqual([0.7, 0.9].sort());
  });

  it("collapses all unknown-provenance rows into one bucket", () => {
    // Untraceable evidence must not compound itself.
    const got = dedupeBySource([
      { sourceId: null, confidence: 0.8 },
      { sourceId: null, confidence: 0.9 },
      { sourceId: null, confidence: 0.7 },
    ]);
    expect(got).toEqual([0.9]);
  });

  it("ten chunks of one document corroborate nothing", () => {
    const rows = Array.from({ length: 10 }, () => ({
      sourceId: "doc-1",
      confidence: 0.85,
    }));
    expect(dedupeBySource(rows)).toEqual([0.85]);
    expect(combineIndependentEvidence(dedupeBySource(rows))).toBe(0.85);
  });
});
