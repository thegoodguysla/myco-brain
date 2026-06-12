import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_FUNCTIONAL_PREDICATES,
  functionalPredicates,
  contradictionPenalty,
} from "./contradiction.js";

describe("functionalPredicates", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BRAIN_FUNCTIONAL_PREDICATES;
    delete process.env.BRAIN_FUNCTIONAL_PREDICATES;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BRAIN_FUNCTIONAL_PREDICATES;
    else process.env.BRAIN_FUNCTIONAL_PREDICATES = saved;
  });

  it("ships the single-current-object predicates by default", () => {
    const set = functionalPredicates();
    expect(set.has("works for")).toBe(true);
    expect(set.has("reports to")).toBe(true);
    expect(set.has("located in")).toBe(true);
    // multi-valued predicates must NOT be functional
    expect(set.has("owns")).toBe(false);
    expect(set.has("acquired")).toBe(false);
  });

  it("extends via env with catalog-style normalization", () => {
    process.env.BRAIN_FUNCTIONAL_PREDICATES = "MARRIED_TO, ceo of,junk!!,";
    const set = functionalPredicates();
    expect(set.has("married to")).toBe(true);
    expect(set.has("ceo of")).toBe(true);
    // junk and empties are dropped; defaults remain
    expect(set.size).toBe(DEFAULT_FUNCTIONAL_PREDICATES.size + 2);
  });
});

describe("contradictionPenalty", () => {
  it("confidence falls, damped by the contradicting confidence", () => {
    // 0.9 * (1 - 0.4*1.0) = 0.54
    expect(contradictionPenalty(0.9, 1.0)).toBeCloseTo(0.54, 10);
    // 0.8 * (1 - 0.4*0.7) = 0.576
    expect(contradictionPenalty(0.8, 0.7)).toBeCloseTo(0.576, 10);
  });

  it("a weak contradiction barely moves a strong fact", () => {
    expect(contradictionPenalty(0.9, 0.1)).toBeCloseTo(0.864, 10);
  });

  it("never goes below zero and clamps junk inputs", () => {
    expect(contradictionPenalty(0, 1)).toBe(0);
    expect(contradictionPenalty(-5, 2)).toBe(0);
    expect(contradictionPenalty(0.5, Number.NaN)).toBeCloseTo(0.5, 10);
  });

  it("one contradiction roughly cancels one corroboration", () => {
    // corroboration: 0.8 -> 0.8 + 0.2*0.4*0.8 = 0.864
    // contradiction at same strength: 0.864 * (1 - 0.4*0.8) = 0.5875…
    // i.e. the pair of opposing equal-strength signals nets BELOW the start —
    // disputed facts end up less trusted than undisputed ones.
    const up = 0.8 + (1 - 0.8) * 0.4 * 0.8;
    const down = contradictionPenalty(up, 0.8);
    expect(down).toBeLessThan(0.8);
  });
});
