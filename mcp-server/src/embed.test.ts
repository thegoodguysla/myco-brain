import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEmbeddingProvider,
  activeEmbeddingTable,
  activeEmbeddingDimension,
} from "./embed.js";

// Env keys the provider selector reads. We snapshot + clear them before each
// test so cases are isolated, then restore after.
const KEYS = [
  "BRAIN_EMBED_PROVIDER",
  "BRAIN_OPENAI_API_KEY",
  "BRAIN_OLLAMA_BASE_URL",
  "BRAIN_OLLAMA_EMBED_MODEL",
];

describe("getEmbeddingProvider", () => {
  let saved: Record<string, string | undefined>;

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

  it("returns null when nothing is configured (full-text fallback)", () => {
    expect(getEmbeddingProvider()).toBeNull();
    expect(activeEmbeddingDimension()).toBeNull();
    // Table defaults to the OpenAI table even when unused.
    expect(activeEmbeddingTable()).toBe("chunks_openai3small");
  });

  it("auto-selects OpenAI when a key is present", () => {
    process.env.BRAIN_OPENAI_API_KEY = "sk-test";
    const p = getEmbeddingProvider();
    expect(p?.name).toBe("openai");
    expect(p?.dimension).toBe(1536);
    expect(p?.table).toBe("chunks_openai3small");
    expect(activeEmbeddingTable()).toBe("chunks_openai3small");
  });

  it("auto-selects keyless Ollama when a base URL is set and no key", () => {
    process.env.BRAIN_OLLAMA_BASE_URL = "http://localhost:11434";
    const p = getEmbeddingProvider();
    expect(p?.name).toBe("ollama");
    expect(p?.dimension).toBe(768);
    expect(p?.table).toBe("chunks_ollama_nomic");
    expect(activeEmbeddingTable()).toBe("chunks_ollama_nomic");
  });

  it("prefers OpenAI over Ollama in auto mode when both are available", () => {
    process.env.BRAIN_OPENAI_API_KEY = "sk-test";
    process.env.BRAIN_OLLAMA_BASE_URL = "http://localhost:11434";
    expect(getEmbeddingProvider()?.name).toBe("openai");
  });

  it("forces Ollama via BRAIN_EMBED_PROVIDER even when an OpenAI key exists", () => {
    process.env.BRAIN_EMBED_PROVIDER = "ollama";
    process.env.BRAIN_OPENAI_API_KEY = "sk-test";
    const p = getEmbeddingProvider();
    expect(p?.name).toBe("ollama");
    expect(p?.table).toBe("chunks_ollama_nomic");
  });

  it("forces Ollama with no base URL by defaulting to localhost:11434", () => {
    process.env.BRAIN_EMBED_PROVIDER = "ollama";
    expect(getEmbeddingProvider()?.name).toBe("ollama");
  });

  it("returns null when openai is forced but no key is set", () => {
    process.env.BRAIN_EMBED_PROVIDER = "openai";
    expect(getEmbeddingProvider()).toBeNull();
  });
});
