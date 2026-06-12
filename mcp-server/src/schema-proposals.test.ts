import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CANONICAL_PREDICATES,
  collectSchemaProposals,
  normalizeTypeName,
  schemaProposalMinConfidence,
} from "./schema-proposals.js";
import type { ExtractionOutput } from "./extraction-worker.lib.js";

const KNOWN_KINDS = new Set(["organization", "person", "project", "location"]);
const KNOWN_PREDICATES = new Set(["works for"]);

const out = (partial: Partial<ExtractionOutput>): ExtractionOutput => ({
  entities: [],
  relations: [],
  ...partial,
});

const entity = (kind: string, confidence = 0.9) => ({
  name: "Acme",
  kind,
  aliases: [],
  confidence,
});

const relation = (predicate: string, confidence = 0.9) => ({
  subject: "Acme",
  predicate,
  object: "Beta",
  confidence,
});

describe("collectSchemaProposals", () => {
  it("proposes a novel entity kind", () => {
    const got = collectSchemaProposals(
      out({ entities: [entity("product")] }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([
      { proposal_type: "entity_kind", name: "product", confidence: 0.9 },
    ]);
  });

  it("does not propose catalog kinds or known predicates", () => {
    const got = collectSchemaProposals(
      out({
        entities: [entity("person"), entity("ORGANIZATION")],
        relations: [relation("works for")],
      }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([]);
  });

  it("proposes a novel relation predicate", () => {
    const got = collectSchemaProposals(
      out({ relations: [relation("sponsors")] }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([
      { proposal_type: "relation_type", name: "sponsors", confidence: 0.9 },
    ]);
  });

  it("filters low-confidence observations", () => {
    const got = collectSchemaProposals(
      out({
        entities: [entity("product", 0.4)],
        relations: [relation("sponsors", 0.59)],
      }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([]);
  });

  it("rejects junk type names", () => {
    const got = collectSchemaProposals(
      out({
        entities: [
          entity("the company mentioned above in the text somewhere"),
          entity("   "),
          entity("x".repeat(60)),
          entity("we!rd$chars"),
        ],
      }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([]);
  });

  it("accepts multi-word predicates like 'collaborates with'", () => {
    const got = collectSchemaProposals(
      out({ relations: [relation("collaborates with")] }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got.map((g) => g.name)).toEqual(["collaborates with"]);
  });

  it("never proposes the prompt's own canonical predicates", () => {
    const got = collectSchemaProposals(
      out({ relations: [...CANONICAL_PREDICATES].map((p) => relation(p)) }),
      KNOWN_KINDS,
      new Set(), // even with an EMPTY catalog (the OSS default)
      0.6
    );
    expect(got).toEqual([]);
  });

  it("matches underscore-named catalog entries against space-separated predicates", () => {
    // Catalog conventions like ASSIGNED_TO must compare equal to the
    // extracted phrase "assigned to" — both via the catalog set (normalized
    // by the worker through normalizeTypeName) and via the candidate side.
    const got = collectSchemaProposals(
      out({ relations: [relation("assigned_to")] }),
      KNOWN_KINDS,
      new Set(["assigned to"]),
      0.6
    );
    expect(got).toEqual([]);
  });

  it("keeps observations at exactly the confidence floor (inclusive)", () => {
    const got = collectSchemaProposals(
      out({ entities: [entity("product", 0.6)] }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got.map((g) => g.name)).toEqual(["product"]);
  });

  it("dedupes repeat sightings keeping the highest confidence", () => {
    const got = collectSchemaProposals(
      out({
        entities: [entity("product", 0.7), entity("Product", 0.95)],
      }),
      KNOWN_KINDS,
      KNOWN_PREDICATES,
      0.6
    );
    expect(got).toEqual([
      { proposal_type: "entity_kind", name: "product", confidence: 0.95 },
    ]);
  });

  it("returns nothing for an empty extraction", () => {
    expect(
      collectSchemaProposals(out({}), KNOWN_KINDS, KNOWN_PREDICATES, 0.6)
    ).toEqual([]);
  });
});

describe("normalizeTypeName", () => {
  it("folds underscores/hyphens to spaces and lowercases", () => {
    expect(normalizeTypeName("ASSIGNED_TO")).toBe("assigned to");
    expect(normalizeTypeName("part-of")).toBe("part of");
    expect(normalizeTypeName("  Reports   To ")).toBe("reports to");
  });
  it("rejects junk", () => {
    expect(normalizeTypeName("")).toBeNull();
    expect(normalizeTypeName(42)).toBeNull();
    expect(normalizeTypeName("we!rd$chars")).toBeNull();
    expect(normalizeTypeName("x".repeat(60))).toBeNull();
  });
});

describe("schemaProposalMinConfidence", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE;
    delete process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE;
    else process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE = saved;
  });

  it("defaults to 0.6 and accepts a valid override", () => {
    expect(schemaProposalMinConfidence()).toBe(0.6);
    process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE = "0.5";
    expect(schemaProposalMinConfidence()).toBe(0.5);
  });

  it("ignores invalid overrides", () => {
    process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE = "nope";
    expect(schemaProposalMinConfidence()).toBe(0.6);
    process.env.BRAIN_SCHEMA_PROPOSAL_MIN_CONFIDENCE = "1.5";
    expect(schemaProposalMinConfidence()).toBe(0.6);
  });
});
