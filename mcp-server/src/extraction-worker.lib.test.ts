import { describe, expect, it } from "vitest";
import {
  clampConfidence,
  fakeExtractEntities,
  normalizeAliases,
  normalizeKind,
  normalizeName,
  safeParse,
} from "./extraction-worker.lib.js";

describe("extraction-worker.lib", () => {
  it("safeParse returns normalized entities from valid JSON", () => {
    const out = safeParse(
      JSON.stringify({
        entities: [
          {
            name: "  Acme Corp  ",
            kind: "Company",
            aliases: [" ACME ", "Acme", ""],
            confidence: 1.5,
          },
          { name: "", kind: "topic", confidence: -1 },
        ],
      }),
    );

    expect(out.entities).toHaveLength(1);
    expect(out.entities[0]).toEqual({
      name: "Acme Corp",
      kind: "company",
      aliases: ["ACME", "Acme"],
      confidence: 1,
    });
  });

  it("safeParse handles missing entities key", () => {
    expect(safeParse(JSON.stringify({ nope: true })).entities).toEqual([]);
    expect(safeParse(JSON.stringify({ nope: true })).relations).toEqual([]);
  });

  it("safeParse extracts and normalizes relations", () => {
    const out = safeParse(
      JSON.stringify({
        entities: [
          { name: "Mara Quinn", kind: "person", confidence: 0.9 },
          { name: "Northwind Coffee", kind: "organization", confidence: 0.9 },
        ],
        relations: [
          { subject: "Mara Quinn", predicate: "Manages", object: "Northwind Coffee", confidence: 0.95 },
          { subject: "X", predicate: "knows", object: "X", confidence: 1 }, // self-loop dropped
          { subject: "A", predicate: "", object: "B", confidence: 1 }, // empty predicate dropped
          { subject: "A", object: "B", confidence: 1 }, // missing predicate dropped
        ],
      }),
    );
    expect(out.relations).toHaveLength(1);
    expect(out.relations[0]).toEqual({
      subject: "Mara Quinn",
      predicate: "manages", // lowercased
      object: "Northwind Coffee",
      confidence: 0.95,
    });
  });

  it("fakeExtractEntities extracts capped title-case tokens", () => {
    const out = fakeExtractEntities(
      "Alice reviewed Myco Brain with Bob and Charlie at OpenAI HQ before Friday Meeting",
    );
    expect(out.entities.length).toBeGreaterThan(0);
    expect(out.entities.length).toBeLessThanOrEqual(8);
    expect(out.entities.every((e) => e.kind === "concept")).toBe(true);
    expect(out.entities.every((e) => e.confidence === 0.55)).toBe(true);
  });

  it("fakeExtractEntities marks Orgz-prefixed tokens as confident organizations", () => {
    const out = fakeExtractEntities("OrgzAcme partnered with Bob.");
    const org = out.entities.find((e) => e.name === "OrgzAcme");
    expect(org).toEqual({
      name: "OrgzAcme",
      kind: "organization",
      aliases: [],
      confidence: 0.9,
    });
    const bob = out.entities.find((e) => e.name === "Bob");
    expect(bob?.kind).toBe("concept");
  });

  it("normalizers handle edge values", () => {
    expect(normalizeName("   ")).toBeNull();
    expect(normalizeKind("")).toBe("concept");
    expect(normalizeAliases([" x ", "x", 3, ""]).sort()).toEqual(["x"]);
    expect(clampConfidence("nan")).toBe(0.5);
    expect(clampConfidence(-3)).toBe(0);
    expect(clampConfidence(0.7)).toBe(0.7);
    expect(clampConfidence(2)).toBe(1);
  });
});
