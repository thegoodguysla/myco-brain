import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveAuth, AuthError } from "./auth.js";

// Save/restore only the BRAIN_* env keys this suite manipulates, so it never
// clobbers unrelated process env.
const KEYS = [
  "BRAIN_API_KEY",
  "BRAIN_SERVICE_ROLE_KEY",
  "BRAIN_WORKSPACE_ID",
  "BRAIN_AGENT_ID",
];
let saved: Record<string, string | undefined> = {};

const WS = "11111111-1111-1111-1111-111111111111";
const AG = "22222222-2222-2222-2222-222222222222";
const OTHER_WS = "99999999-9999-9999-9999-999999999999";

describe("resolveAuth", () => {
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("brain_ key: identity comes ONLY from the key; caller overrides are ignored", () => {
    const r = resolveAuth({ apiKey: `brain_${WS}_${AG}_secret`, workspaceId: OTHER_WS, agentId: "other" });
    expect(r.ctx.workspaceId).toBe(WS);
    expect(r.ctx.actorId).toBe(AG);
    expect(r.ctx.principalRole).toBe("agent");
  });

  it("rejects a caller-supplied 'eyJ' key that does not equal BRAIN_SERVICE_ROLE_KEY", () => {
    process.env.BRAIN_SERVICE_ROLE_KEY = "eyJreal.service.key";
    expect(() => resolveAuth({ apiKey: "eyJforged.different", workspaceId: OTHER_WS })).toThrow(AuthError);
  });

  it("rejects any 'eyJ' key when no BRAIN_SERVICE_ROLE_KEY is configured", () => {
    expect(() => resolveAuth({ apiKey: "eyJanything", workspaceId: WS })).toThrow(
      /BRAIN_SERVICE_ROLE_KEY/
    );
  });

  it("grants service role ONLY when the JWT equals the configured BRAIN_SERVICE_ROLE_KEY", () => {
    process.env.BRAIN_SERVICE_ROLE_KEY = "eyJreal.service.key";
    const r = resolveAuth({ apiKey: "eyJreal.service.key", workspaceId: WS });
    expect(r.ctx.principalRole).toBe("service");
    expect(r.ctx.workspaceId).toBe(WS);
  });

  it("with no caller key, falls back to the env brain_ identity (stdio default)", () => {
    process.env.BRAIN_API_KEY = `brain_${WS}_${AG}_envsecret`;
    const r = resolveAuth({});
    expect(r.ctx.workspaceId).toBe(WS);
    expect(r.ctx.actorId).toBe(AG);
    expect(r.ctx.principalRole).toBe("agent");
  });
});
