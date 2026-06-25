import { describe, it, expect, afterEach } from "vitest";
import {
  resolveMode,
  confidenceBand,
  buildSurfacingEnvelope,
  renderHeartbeat,
  DEFAULT_MODE,
} from "./surfacing.js";

afterEach(() => {
  delete process.env.BRAIN_MODE;
});

describe("surfacing envelope", () => {
  it("defaults to silent", () => {
    delete process.env.BRAIN_MODE;
    expect(resolveMode()).toBe("silent");
    expect(DEFAULT_MODE).toBe("silent");
  });

  it("resolveMode precedence: override > env > default", () => {
    process.env.BRAIN_MODE = "ambient";
    expect(resolveMode()).toBe("ambient"); // env
    expect(resolveMode("audit")).toBe("audit"); // override wins over env
    expect(resolveMode("nonsense")).toBe("ambient"); // bad override falls through to env
    delete process.env.BRAIN_MODE;
    expect(resolveMode("nonsense")).toBe("silent"); // bad override + no env -> default
    expect(resolveMode("AUDIT")).toBe("audit"); // case-insensitive
  });

  it("confidenceBand thresholds", () => {
    expect(confidenceBand(null)).toBeNull();
    expect(confidenceBand(undefined)).toBeNull();
    expect(confidenceBand(Number.NaN)).toBeNull();
    expect(confidenceBand(0.95)).toBe("high");
    expect(confidenceBand(0.8)).toBe("high");
    expect(confidenceBand(0.6)).toBe("medium");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.2)).toBe("low");
  });

  it("silent mode never emits a heartbeat (token contract: ~0 tokens)", () => {
    const env = buildSurfacingEnvelope({
      mode: "silent",
      factCount: 4,
      confidenceMean: 0.9,
      sourceTypes: { 1: 2, 3: 1 },
    });
    expect(env.heartbeat).toBeNull();
    expect(env.mode).toBe("silent");
    expect(env.fact_count).toBe(4);
    expect(env.confidence_band).toBe("high");
    expect(env.source_type_count).toBe(2);
    expect(env.source_types).toEqual({ 1: 2, 3: 1 });
  });

  it("ambient mode emits one compact heartbeat when facts were used", () => {
    const env = buildSurfacingEnvelope({
      mode: "ambient",
      factCount: 4,
      confidenceMean: 0.7,
      sourceTypes: { 1: 4 },
    });
    expect(env.heartbeat).toBe('Myco: 4 facts used. Ask "why" to see sources.');
    expect(env.confidence_band).toBe("medium");
  });

  it("singular noun for exactly one fact", () => {
    const env = buildSurfacingEnvelope({
      mode: "audit",
      factCount: 1,
      confidenceMean: 0.9,
      sourceTypes: {},
    });
    expect(env.heartbeat).toBe('Myco: 1 fact used. Ask "why" to see sources.');
  });

  it("no heartbeat when zero facts, even in ambient/audit", () => {
    const env = buildSurfacingEnvelope({
      mode: "ambient",
      factCount: 0,
      confidenceMean: null,
      sourceTypes: {},
    });
    expect(env.heartbeat).toBeNull();
    expect(env.confidence_band).toBeNull();
    expect(env.source_type_count).toBe(0);
  });

  it("heartbeat stays within the ~15-token budget (word-count proxy)", () => {
    const env = buildSurfacingEnvelope({
      mode: "ambient",
      factCount: 12,
      confidenceMean: 0.9,
      sourceTypes: {},
    });
    expect(env.heartbeat).not.toBeNull();
    expect(env.heartbeat!.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("renderHeartbeat is consistent with buildSurfacingEnvelope", () => {
    expect(renderHeartbeat({ mode: "silent", fact_count: 3 })).toBeNull();
    expect(renderHeartbeat({ mode: "ambient", fact_count: 0 })).toBeNull();
    expect(renderHeartbeat({ mode: "audit", fact_count: 2 })).toBe(
      'Myco: 2 facts used. Ask "why" to see sources.'
    );
  });
});
