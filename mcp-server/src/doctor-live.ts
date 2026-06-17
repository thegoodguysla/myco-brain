/**
 * Live probes for mycobrain-doctor. The original doctor checked CONFIG (is an
 * env var set?); these actually talk to Ollama, confirm the model is pulled, and
 * run a real embed/generate, so doctor reports what WORKS, not what is merely
 * configured. The pure helpers (resolveOllamaBase, hasModel, resolveExtraction)
 * are unit-tested; the network probes use short timeouts and never throw.
 */
import { spawnSync } from "node:child_process";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export function resolveOllamaBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BRAIN_OLLAMA_BASE_URL ?? "").replace(/\/$/, "") || DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Does the pulled-model list satisfy a wanted model? Ollama lists "name:tag"
 * (e.g. "nomic-embed-text:latest"). A want without a tag ("nomic-embed-text")
 * matches any tag of that name; a want WITH a tag ("llama3.2:3b") must match it.
 */
export function hasModel(models: string[], want: string): boolean {
  const w = (want ?? "").trim();
  if (!w) return false;
  if (w.includes(":")) return models.includes(w);
  return models.some((m) => m === w || m.split(":")[0] === w);
}

export type ExtractionResolution =
  | { provider: "anthropic" }
  | { provider: "ollama"; ollamaBase: string; model: string }
  | { provider: "none" };

/** Mirror the extraction worker's provider precedence from env (no network). */
export function resolveExtraction(env: NodeJS.ProcessEnv = process.env): ExtractionResolution {
  const forced = (env.BRAIN_EXTRACTION_PROVIDER ?? "").trim().toLowerCase();
  const hasAnthropic = !!env.BRAIN_ANTHROPIC_API_KEY;
  const ollamaBase = (env.BRAIN_OLLAMA_BASE_URL ?? "").replace(/\/$/, "");
  const model = env.BRAIN_OLLAMA_MODEL ?? "llama3.2:3b";
  if (forced === "anthropic" || (!forced && hasAnthropic)) return { provider: "anthropic" };
  if (forced === "ollama" || (!forced && ollamaBase)) {
    return { provider: "ollama", ollamaBase: ollamaBase || DEFAULT_OLLAMA_BASE_URL, model };
  }
  return { provider: "none" };
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export interface OllamaProbe {
  reachable: boolean;
  models: string[];
  error?: string;
}

/** GET /api/tags — is the server up, and what is pulled? Never throws. */
export async function probeOllama(baseUrl: string, timeoutMs = 2500): Promise<OllamaProbe> {
  try {
    const res = await fetchWithTimeout(`${baseUrl}/api/tags`, {}, timeoutMs);
    if (!res.ok) return { reachable: false, models: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return { reachable: true, models: (json.models ?? []).map((m) => m.name) };
  } catch (err) {
    return { reachable: false, models: [], error: (err as Error).message };
  }
}

/** Run a real one-token embedding. Proves the embed path works end-to-end. */
export async function liveEmbedOk(baseUrl: string, model: string, timeoutMs = 8000): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/embeddings`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt: "ping" }) },
      timeoutMs
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { embedding?: number[] };
    return !!json.embedding && json.embedding.length > 0;
  } catch {
    return false;
  }
}

/** Run a tiny generation. Proves the extraction model loads and responds. */
export async function liveGenerateOk(baseUrl: string, model: string, timeoutMs = 25000): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${baseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: "Reply with the single word: ok", stream: false }),
      },
      timeoutMs
    );
    if (!res.ok) return false;
    const json = (await res.json()) as { response?: string };
    return typeof json.response === "string" && json.response.trim().length > 0;
  } catch {
    return false;
  }
}

export function ollamaCliPresent(): boolean {
  const r = spawnSync("ollama", ["--version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

/** `ollama pull <model>` with inherited stdio (shows the progress bar). */
export function pullModel(model: string): boolean {
  const r = spawnSync("ollama", ["pull", model], { stdio: "inherit" });
  return !r.error && r.status === 0;
}
