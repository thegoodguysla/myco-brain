import { describe, it, expect } from "vitest";
import type { ExtractedRelation } from "./extraction-worker.lib.js";
import {
  GOLD_RELATIONS,
  entityMatches,
  predicateMatches,
  scoreDirection,
  summarize,
  type GoldRelation,
} from "./extraction-direction.js";

const rel = (subject: string, predicate: string, object: string): ExtractedRelation => ({
  subject,
  predicate,
  object,
  confidence: 0.9,
});

const gold: GoldRelation = {
  text: "Devin Osei reports to Mara Quinn.",
  subject: "Devin Osei",
  object: "Mara Quinn",
  predicates: ["report"],
};

describe("entityMatches", () => {
  it("matches on a shared distinctive token (full vs partial name)", () => {
    expect(entityMatches("Mara Quinn", "Mara")).toBe(true);
    expect(entityMatches("Northwind Coffee", "Northwind")).toBe(true);
    expect(entityMatches("northwind coffee", "Northwind Coffee Inc.")).toBe(true);
  });
  it("does not match unrelated entities", () => {
    expect(entityMatches("Lumen", "Mara Quinn")).toBe(false);
    expect(entityMatches("Devin Osei", "Priya Raman")).toBe(false);
  });
  it("ignores stop tokens like 'the'/'account'", () => {
    // Only "the"/"account" overlap → not a match.
    expect(entityMatches("the account", "the account manager")).toBe(false);
  });
});

describe("scoreDirection", () => {
  it("returns correct when direction matches (partial names allowed)", () => {
    expect(scoreDirection(gold, [rel("Devin", "reports to", "Mara Quinn")])).toBe("correct");
  });
  it("returns reversed when the endpoints are swapped", () => {
    expect(scoreDirection(gold, [rel("Mara Quinn", "manages", "Devin Osei")])).toBe("reversed");
  });
  it("returns missing when the relation isn't present", () => {
    expect(scoreDirection(gold, [rel("Lumen", "serves", "Northwind")])).toBe("missing");
    expect(scoreDirection(gold, [])).toBe("missing");
  });
  it("prefers correct over reversed when both directions appear", () => {
    expect(
      scoreDirection(gold, [
        rel("Mara", "manages", "Devin"),
        rel("Devin Osei", "reports to", "Mara Quinn"),
      ])
    ).toBe("correct");
  });
});

describe("predicateMatches", () => {
  it("matches a predicate stem", () => {
    expect(predicateMatches("reports to", gold)).toBe(true);
    expect(predicateMatches("works for", gold)).toBe(false);
  });
});

describe("summarize", () => {
  it("computes accuracy, error rate, and directional precision", () => {
    const s = summarize(["correct", "correct", "reversed", "missing"]);
    expect(s.total).toBe(4);
    expect(s.correct).toBe(2);
    expect(s.reversed).toBe(1);
    expect(s.missing).toBe(1);
    expect(s.directedAccuracy).toBeCloseTo(0.5);
    expect(s.errorRate).toBeCloseTo(0.5);
    // 2 correct of 3 found.
    expect(s.directionalPrecision).toBeCloseTo(2 / 3);
  });
});

describe("GOLD_RELATIONS fixture", () => {
  it("is non-trivial and well-formed (distinct, directed endpoints)", () => {
    expect(GOLD_RELATIONS.length).toBeGreaterThanOrEqual(8);
    for (const g of GOLD_RELATIONS) {
      expect(g.subject).not.toBe(g.object);
      expect(entityMatches(g.subject, g.object)).toBe(false);
      expect(g.text.toLowerCase()).toContain(g.subject.split(" ")[0].toLowerCase());
      expect(g.predicates.length).toBeGreaterThan(0);
    }
  });
});
