import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  eligibleForPromotion,
  schemaPromotionOptions,
} from "./schema-promotion.js";

const ENV_KEYS = [
  "BRAIN_SCHEMA_AUTO_PROMOTE",
  "BRAIN_REQUIRE_HUMAN_REVIEW",
  "BRAIN_SCHEMA_PROMOTE_MIN_SEEN",
  "BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE",
];

describe("schemaPromotionOptions", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is OFF by default with conservative thresholds", () => {
    const o = schemaPromotionOptions();
    expect(o.enabled).toBe(false);
    expect(o.strictMode).toBe(false);
    expect(o.minSeen).toBe(3);
    expect(o.minConfidence).toBe(0.8);
  });

  it("reads env overrides and ignores junk", () => {
    process.env.BRAIN_SCHEMA_AUTO_PROMOTE = "1";
    process.env.BRAIN_SCHEMA_PROMOTE_MIN_SEEN = "2";
    process.env.BRAIN_SCHEMA_PROMOTE_MIN_CONFIDENCE = "junk";
    const o = schemaPromotionOptions();
    expect(o.enabled).toBe(true);
    expect(o.minSeen).toBe(2);
    expect(o.minConfidence).toBe(0.8); // junk → default
  });
});

describe("eligibleForPromotion", () => {
  const base = { seen_count: 3, confidence: 0.85, state: "pending" };
  const on = { enabled: true, strictMode: false, minSeen: 3, minConfidence: 0.8 };

  it("promotes a corroborated, confident, pending proposal when enabled", () => {
    expect(eligibleForPromotion(base, on)).toBe(true);
  });

  it("never promotes when disabled (the default)", () => {
    expect(eligibleForPromotion(base, { ...on, enabled: false })).toBe(false);
  });

  it("strict curation mode always wins", () => {
    expect(eligibleForPromotion(base, { ...on, strictMode: true })).toBe(false);
  });

  it("one chatty document never promotes (seen_count below bar)", () => {
    expect(eligibleForPromotion({ ...base, seen_count: 2 }, on)).toBe(false);
  });

  it("low confidence never promotes", () => {
    expect(eligibleForPromotion({ ...base, confidence: 0.79 }, on)).toBe(false);
  });

  it("non-pending proposals are never re-promoted", () => {
    expect(eligibleForPromotion({ ...base, state: "auto_promoted" }, on)).toBe(false);
    expect(eligibleForPromotion({ ...base, state: "rejected" }, on)).toBe(false);
  });
});
