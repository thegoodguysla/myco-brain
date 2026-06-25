import { describe, it, expect, afterAll } from "vitest";
import { closePool, type SessionContext } from "../db.js";
import { selfCheck } from "./check.js";

const HAS_DB = !!process.env.DATABASE_URL;
const CTX: SessionContext = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  principalRole: "service",
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "program",
};

describe.skipIf(!HAS_DB)("brain_self_check (DB)", () => {
  afterAll(async () => {
    await closePool();
  });

  it("returns a well-formed, mode-aware report", async () => {
    delete process.env.BRAIN_MODE;
    const r = await selfCheck(CTX, { pending_limit: 5 });
    expect(["silent", "ambient", "audit"]).toContain(r.mode);
    expect(typeof r.working.documents).toBe("number");
    expect(typeof r.working.chunks).toBe("number");
    expect(r.working.message).toBeTruthy();
    expect(r.pending.total).toBe(
      r.pending.entities + r.pending.relations + r.pending.types
    );
    expect(Array.isArray(r.problems)).toBe(true);
    expect(typeof r.summary).toBe("string");
    // every problem carries an actionable fix
    for (const p of r.problems) {
      expect(p.fix.length).toBeGreaterThan(0);
      expect(p.title.length).toBeGreaterThan(0);
    }
  });

  it("flags semantic-search-off with a fix when no provider is configured", async () => {
    delete process.env.BRAIN_OPENAI_API_KEY;
    delete process.env.BRAIN_OLLAMA_BASE_URL;
    delete process.env.BRAIN_EMBED_PROVIDER;
    const r = await selfCheck(CTX, { pending_limit: 5 });
    const p = r.problems.find((x) => x.id === "no_embedding_provider");
    expect(p).toBeDefined();
    expect(p!.fix).toMatch(/OLLAMA|OPENAI/);
    expect(r.working.embedded_chunks).toBeNull();
    expect(r.summary).toContain("needs attention");
  });
});
