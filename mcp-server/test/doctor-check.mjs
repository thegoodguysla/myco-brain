#!/usr/bin/env node
/**
 * doctor live-probe check — PURE helpers only (no network). Pins the model-match
 * logic (Ollama lists name:tag; a tagless want matches any tag), the Ollama base
 * resolution, and the extraction-provider precedence that decides graph on/off.
 */
const d = await import("../dist/doctor-live.js");

let failed = 0;
const ok = (m) => console.log(`ok    ${m}`);
const fail = (m) => { failed++; console.error(`FAIL  ${m}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : fail(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));

// ── resolveOllamaBase ─────────────────────────────────────────────────────────
eq(d.resolveOllamaBase({}), "http://localhost:11434", "default Ollama base");
eq(d.resolveOllamaBase({ BRAIN_OLLAMA_BASE_URL: "http://host.docker.internal:11434/" }), "http://host.docker.internal:11434", "env base, trailing slash stripped");

// ── hasModel ─────────────────────────────────────────────────────────────────
const pulled = ["llama3.2:3b", "nomic-embed-text:latest", "qwen2.5:7b"];
eq(d.hasModel(pulled, "nomic-embed-text"), true, "tagless want matches any tag (nomic-embed-text -> :latest)");
eq(d.hasModel(pulled, "llama3.2:3b"), true, "exact tagged want matches");
eq(d.hasModel(pulled, "llama3.2:1b"), false, "wrong tag does NOT match");
eq(d.hasModel(pulled, "mistral"), false, "absent model -> false");
eq(d.hasModel([], "nomic-embed-text"), false, "empty list -> false");
eq(d.hasModel(pulled, ""), false, "empty want -> false");

// ── resolveExtraction (the graph on/off decision) ────────────────────────────
eq(d.resolveExtraction({}).provider, "none", "no config -> none (graph off)");
eq(d.resolveExtraction({ BRAIN_ANTHROPIC_API_KEY: "sk-x" }).provider, "anthropic", "anthropic key -> anthropic");
const oll = d.resolveExtraction({ BRAIN_OLLAMA_BASE_URL: "http://localhost:11434" });
eq(oll.provider, "ollama", "ollama base -> ollama");
eq(oll.model, "llama3.2:3b", "default extraction model");
eq(d.resolveExtraction({ BRAIN_OLLAMA_BASE_URL: "http://x", BRAIN_OLLAMA_MODEL: "qwen2.5:7b" }).model, "qwen2.5:7b", "BRAIN_OLLAMA_MODEL overrides");
// explicit override wins over key precedence
eq(d.resolveExtraction({ BRAIN_EXTRACTION_PROVIDER: "ollama", BRAIN_ANTHROPIC_API_KEY: "sk-x", BRAIN_OLLAMA_BASE_URL: "http://x" }).provider, "ollama", "explicit provider override wins");

console.log(failed === 0 ? "\n=== PASS (doctor) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
