import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool, closePool, type SessionContext } from "./db.js";
import { setMode } from "./tools/set-mode.js";
import {
  getWorkspaceSurfacing,
  setWorkspaceSurfacing,
  resolveEffectiveMode,
  setSessionMode,
  __resetSessionSurfacing,
} from "./surfacing-store.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_WS = "00000000-0000-0000-0000-0000000f5f5f";

describe.skipIf(!HAS_DB)("surfacing preference store (DB)", () => {
  beforeAll(async () => {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO workspaces (workspace_id, name, slug, plan, status, settings)
         VALUES ($1,'Surfacing Test','surfacing-test','free','active','{}'::jsonb)
         ON CONFLICT (workspace_id) DO UPDATE SET settings = '{}'::jsonb`,
        [TEST_WS]
      );
    } finally {
      c.release();
    }
  });

  afterAll(async () => {
    const c = await getPool().connect();
    try {
      await c.query(`DELETE FROM workspaces WHERE workspace_id = $1`, [TEST_WS]);
    } finally {
      c.release();
    }
    __resetSessionSurfacing();
    await closePool();
  });

  it("defaults to silent when nothing is set", async () => {
    __resetSessionSurfacing();
    delete process.env.BRAIN_MODE;
    const c = await getPool().connect();
    try {
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("silent");
    } finally {
      c.release();
    }
  });

  it("persists and reads back the workspace mode", async () => {
    __resetSessionSurfacing();
    delete process.env.BRAIN_MODE;
    const c = await getPool().connect();
    try {
      await setWorkspaceSurfacing(c, TEST_WS, { mode: "ambient" });
      const ws = await getWorkspaceSurfacing(c, TEST_WS);
      expect(ws.mode).toBe("ambient");
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("ambient");
    } finally {
      c.release();
    }
  });

  it("session override beats the persisted workspace mode", async () => {
    delete process.env.BRAIN_MODE;
    const c = await getPool().connect();
    try {
      await setWorkspaceSurfacing(c, TEST_WS, { mode: "ambient" });
      setSessionMode("audit");
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("audit");
      __resetSessionSurfacing();
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("ambient");
    } finally {
      c.release();
    }
  });

  it("merges into settings without clobbering other keys", async () => {
    const c = await getPool().connect();
    try {
      await c.query(
        `UPDATE workspaces SET settings = '{"keep":true}'::jsonb WHERE workspace_id = $1`,
        [TEST_WS]
      );
      await setWorkspaceSurfacing(c, TEST_WS, { mode: "audit" });
      const r = await c.query(
        `SELECT settings FROM workspaces WHERE workspace_id = $1`,
        [TEST_WS]
      );
      expect(r.rows[0].settings.keep).toBe(true);
      expect(r.rows[0].settings.surfacing.mode).toBe("audit");
    } finally {
      c.release();
    }
  });

  const TEST_CTX: SessionContext = {
    workspaceId: TEST_WS,
    principalRole: "service",
    actorId: "00000000-0000-0000-0000-0000000000a1",
    actorKind: "program",
  };

  it("setMode persists the workspace default (survives a new session)", async () => {
    __resetSessionSurfacing();
    delete process.env.BRAIN_MODE;
    const r = await setMode(TEST_CTX, { mode: "ambient", persist: true });
    expect(r.mode).toBe("ambient");
    expect(r.persisted).toBe(true);
    __resetSessionSurfacing(); // simulate a fresh session/client
    const c = await getPool().connect();
    try {
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("ambient");
    } finally {
      c.release();
    }
  });

  it("setMode persist:false is session-only (does not change the default)", async () => {
    __resetSessionSurfacing();
    delete process.env.BRAIN_MODE;
    await setMode(TEST_CTX, { mode: "ambient", persist: true }); // default = ambient
    __resetSessionSurfacing();
    const r = await setMode(TEST_CTX, { mode: "audit", persist: false }); // one-off
    expect(r.mode).toBe("audit");
    expect(r.persisted).toBe(false);
    __resetSessionSurfacing(); // new session drops the one-off override
    const c = await getPool().connect();
    try {
      expect(await resolveEffectiveMode(c, TEST_WS)).toBe("ambient");
    } finally {
      c.release();
    }
  });
});
