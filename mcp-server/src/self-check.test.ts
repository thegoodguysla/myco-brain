import { describe, it, expect } from "vitest";
import {
  classifyWrite,
  shouldGate,
  buildProposedWrite,
  buildContradictionResolution,
  renderProposedWrite,
  renderContradiction,
} from "./self-check.js";
import type { SurfacingMode } from "./surfacing.js";

const MODES: SurfacingMode[] = ["silent", "ambient", "audit"];

describe("self-check gating policy", () => {
  it("non-durable writes (memory, annotation) never gate, in any mode", () => {
    for (const mode of MODES) {
      expect(shouldGate(mode, classifyWrite("memory"))).toBe(false);
      expect(shouldGate(mode, classifyWrite("annotation"))).toBe(false);
      // even if (nonsensically) flagged superseding/high-risk, non-durable stays ungated
      expect(
        shouldGate(mode, classifyWrite("memory", { superseding: true, highRisk: true }))
      ).toBe(false);
    }
  });

  it("audit gates every durable write, including low-risk first-time", () => {
    expect(shouldGate("audit", classifyWrite("fact"))).toBe(true);
    expect(shouldGate("audit", classifyWrite("ingest"))).toBe(true);
  });

  it("silent/ambient auto-approve low-risk first-time durable writes", () => {
    expect(shouldGate("silent", classifyWrite("fact"))).toBe(false);
    expect(shouldGate("ambient", classifyWrite("ingest"))).toBe(false);
  });

  it("silent/ambient gate durable supersessions", () => {
    expect(shouldGate("silent", classifyWrite("ingest", { superseding: true }))).toBe(true);
    expect(shouldGate("ambient", classifyWrite("fact", { superseding: true }))).toBe(true);
  });

  it("silent/ambient gate contested high-risk writes", () => {
    expect(shouldGate("silent", classifyWrite("ingest", { highRisk: true }))).toBe(true);
    expect(shouldGate("ambient", classifyWrite("fact", { highRisk: true }))).toBe(true);
  });

  it("classifyWrite marks durability + superseding correctly", () => {
    expect(classifyWrite("memory").durable).toBe(false);
    expect(classifyWrite("annotation").durable).toBe(false);
    expect(classifyWrite("fact").durable).toBe(true);
    expect(classifyWrite("ingest").durable).toBe(true);
    // superseding only sticks on durable kinds
    expect(classifyWrite("memory", { superseding: true }).superseding).toBe(false);
    expect(classifyWrite("ingest", { superseding: true }).superseding).toBe(true);
  });
});

describe("self-check structured objects", () => {
  it("buildProposedWrite carries the verbatim fact + source + band + choices", () => {
    const p = buildProposedWrite({
      summary: "Acme renewal moved to Q3.",
      source: "this chat",
      confidenceBand: "medium",
    });
    expect(p.summary).toBe("Acme renewal moved to Q3.");
    expect(p.source).toBe("this chat");
    expect(p.confidence_band).toBe("medium");
    expect(p.choices).toEqual(["Save", "Skip", "Always save this kind"]);
    expect(renderProposedWrite(p)).toContain('Myco wants to save: "Acme renewal moved to Q3."');
    expect(renderProposedWrite(p)).toContain("Save / Skip / Always save this kind");
  });

  it("buildContradictionResolution picks the winner + retires the loser", () => {
    const c = buildContradictionResolution({
      oldClaim: "Acme renews in Q2",
      newClaim: "Acme renews in Q3",
      keep: "new",
      reason: "you told me Q2, but the renewal doc says Q3",
    });
    expect(c.old_claim).toBe("Acme renews in Q2");
    expect(c.new_claim).toBe("Acme renews in Q3");
    expect(c.resolution).toBe('Trust "Acme renews in Q3" and retire "Acme renews in Q2".');
    expect(c.choices).toEqual(["Keep new", "Keep old", "Show both"]);
    expect(renderContradiction(c)).toContain("Heads up: you told me Q2");
  });

  it("buildContradictionResolution can keep the old claim", () => {
    const c = buildContradictionResolution({
      oldClaim: "old",
      newClaim: "new",
      keep: "old",
      reason: "old is user-confirmed and higher-provenance",
    });
    expect(c.resolution).toBe('Trust "old" and retire "new".');
  });
});
