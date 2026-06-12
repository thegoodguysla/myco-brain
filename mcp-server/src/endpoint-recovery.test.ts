import { describe, it, expect } from "vitest";
import {
  missingRelationEndpoints,
  mergeRecoveredEntities,
  type ExtractionOutput,
} from "./extraction-worker.lib.js";
import {
  ENDPOINT_CLASSIFY_SYSTEM,
  endpointClassifyInput,
} from "./extraction.js";

const entity = (name: string, aliases: string[] = []) => ({
  name,
  kind: "organization",
  aliases,
  confidence: 0.9,
});

const rel = (subject: string, object: string) => ({
  subject,
  predicate: "acquired",
  object,
  confidence: 0.9,
});

describe("missingRelationEndpoints", () => {
  it("finds endpoints absent from entities", () => {
    const out: ExtractionOutput = {
      entities: [entity("Halcyon Labs")],
      relations: [rel("Halcyon Labs", "Driftwood Analytics")],
    };
    expect(missingRelationEndpoints(out)).toEqual(["Driftwood Analytics"]);
  });

  it("is case-insensitive and counts aliases", () => {
    const out: ExtractionOutput = {
      entities: [entity("Halcyon Labs", ["Halcyon"])],
      relations: [rel("halcyon", "HALCYON LABS")],
    };
    expect(missingRelationEndpoints(out)).toEqual([]);
  });

  it("dedupes repeated missing names and skips junk", () => {
    const out: ExtractionOutput = {
      entities: [],
      relations: [rel("Acme", "Beta"), rel("Acme", "Beta"), rel("X", "Beta")],
    };
    expect(missingRelationEndpoints(out)).toEqual(["Acme", "Beta"]);
  });

  it("returns empty when there are no relations", () => {
    expect(
      missingRelationEndpoints({ entities: [entity("Acme")], relations: [] })
    ).toEqual([]);
  });
});

describe("mergeRecoveredEntities", () => {
  const base: ExtractionOutput = {
    entities: [entity("Halcyon Labs")],
    relations: [rel("Halcyon Labs", "Driftwood Analytics")],
  };

  it("adds requested recovered entities", () => {
    const merged = mergeRecoveredEntities(
      base,
      [entity("Driftwood Analytics")],
      ["Driftwood Analytics"]
    );
    expect(merged.entities.map((e) => e.name)).toEqual([
      "Halcyon Labs",
      "Driftwood Analytics",
    ]);
    expect(merged.relations).toEqual(base.relations);
  });

  it("rejects entities the model invented (not requested)", () => {
    const merged = mergeRecoveredEntities(
      base,
      [entity("Driftwood Analytics"), entity("Hallucinated Corp")],
      ["Driftwood Analytics"]
    );
    expect(merged.entities.map((e) => e.name)).toEqual([
      "Halcyon Labs",
      "Driftwood Analytics",
    ]);
  });

  it("never duplicates an existing entity (case-insensitive)", () => {
    const merged = mergeRecoveredEntities(
      base,
      [entity("HALCYON LABS")],
      ["HALCYON LABS"]
    );
    expect(merged.entities).toHaveLength(1);
  });
});

describe("endpoint classify prompt", () => {
  it("system prompt is example-anchored and forbids inventing names", () => {
    expect(ENDPOINT_CLASSIFY_SYSTEM).toContain("EXACTLY as given");
    expect(ENDPOINT_CLASSIFY_SYSTEM).toContain("Do not add names");
    expect(ENDPOINT_CLASSIFY_SYSTEM).toContain('"Jane Doe"');
  });

  it("user input lists the names before the text", () => {
    const input = endpointClassifyInput(
      ["Driftwood Analytics", "Mara Quinn"],
      "Some text."
    );
    expect(input).toContain('"Driftwood Analytics", "Mara Quinn"');
    expect(input.endsWith("Some text.")).toBe(true);
    expect(input.indexOf("Names to classify")).toBe(0);
  });
});
