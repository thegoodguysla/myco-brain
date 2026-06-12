/**
 * Entity + relationship extraction — provider calls and the shared prompt,
 * factored out of extraction-worker.ts so they can be imported without starting
 * the worker's polling loop (the worker module runs main() on import).
 *
 * Relationships are DIRECTED: small local models frequently get subject→object
 * direction wrong, so the prompt makes direction explicit with worked examples.
 * The gold-fixture direction check (test/extraction-direction-check.mjs) measures
 * how often a given model gets it right.
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  safeParse,
  fakeExtractEntities,
  missingRelationEndpoints,
  mergeRecoveredEntities,
  type ExtractionOutput,
} from "./extraction-worker.lib.js";

export const EXTRACTION_SYSTEM =
  "Extract named entities AND the directed relationships between them from text. " +
  "Return only JSON with shape " +
  '{"entities":[{"name":string,"kind":string,"aliases":string[],"confidence":number}],' +
  '"relations":[{"subject":string,"predicate":string,"object":string,"confidence":number}]}. ' +
  '"kind" is usually one of: organization, person, project, location. ' +
  'If none of those fits, use a short lowercase noun for what the entity is ' +
  '(e.g. "product", "event", "tool") instead of forcing a wrong kind. ' +
  "Relations are DIRECTED. The \"subject\" is the entity that performs the action " +
  "or holds the role; the \"object\" is the entity it acts on or is directed at. " +
  '"predicate" is a short active-voice verb phrase (e.g. "acquired", "founded", ' +
  '"works for", "reports to", "manages", "owns", "hired", "located in"). ' +
  "Get the direction right — do not swap subject and object:\n" +
  '- "Acme acquired Beta" → {"subject":"Acme","predicate":"acquired","object":"Beta"} (never the reverse).\n' +
  '- "Priya reports to Dan" → {"subject":"Priya","predicate":"reports to","object":"Dan"}.\n' +
  '- "Northwind hired Lumen" → {"subject":"Northwind","predicate":"hired","object":"Lumen"}.\n' +
  "Both subject and object MUST be names that also appear in entities. " +
  "Only include a relation the text clearly states; if unsure of the direction, omit it. " +
  '"confidence" is 0-1; use >=0.7 when sure. No extra keys, no prose.';

export interface ExtractConfig {
  provider: "anthropic" | "ollama" | "fake";
  /** Anthropic client (required when provider === "anthropic"). */
  anthropic?: Anthropic | null;
  anthropicModel?: string;
  /** Ollama base URL, no trailing slash (required when provider === "ollama"). */
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** System prompt; defaults to EXTRACTION_SYSTEM. */
  system?: string;
}

/**
 * The follow-up prompt for endpoint recovery: classify ONLY the named
 * entities (which the model itself referenced in relations) against the same
 * text. Example-anchored — small models ignore abstract instructions but
 * follow the worked example. The names also go into the user content (see
 * endpointClassifyInput); anything the model adds beyond the requested names
 * is discarded by mergeRecoveredEntities. Exported for tests.
 */
export const ENDPOINT_CLASSIFY_SYSTEM =
  "You classify already-identified entity names against a text. You are given " +
  "a list of names; the text follows. For EVERY name in the list, output " +
  'exactly one entity object whose "name" is the name EXACTLY as given. ' +
  "Do not add names that are not in the list. Do not skip any listed name. " +
  "Return only JSON: " +
  '{"entities":[{"name":string,"kind":string,"aliases":string[],"confidence":number}]}. ' +
  '"kind" is usually one of: organization, person, project, location; if none ' +
  'fits, a short lowercase noun. "confidence" is 0-1 for how clearly the text ' +
  'supports the entity. Example: names "Acme Corp", "Jane Doe" -> ' +
  '{"entities":[{"name":"Acme Corp","kind":"organization","aliases":[],"confidence":0.9},' +
  '{"name":"Jane Doe","kind":"person","aliases":[],"confidence":0.9}]}. No prose.';

/** User content for the recovery pass: the names, then the original text. */
export function endpointClassifyInput(names: string[], text: string): string {
  return `Names to classify: ${names.map((n) => JSON.stringify(n)).join(", ")}\n\n${text}`;
}

/** One provider call with the given system prompt. */
async function extractOnce(
  text: string,
  config: ExtractConfig,
  system: string
): Promise<ExtractionOutput> {
  if (config.provider === "ollama" && config.ollamaBaseUrl) {
    return extractWithOllama(
      config.ollamaBaseUrl,
      config.ollamaModel ?? "llama3.2:3b",
      system,
      text
    );
  }
  if (config.provider === "anthropic" && config.anthropic) {
    return extractWithAnthropic(
      config.anthropic,
      config.anthropicModel ?? "claude-sonnet-4-20250514",
      system,
      text
    );
  }
  return fakeExtractEntities(text);
}

/**
 * Dispatch extraction to the configured provider, then recover relation
 * endpoints the model referenced but forgot to list as entities (one extra
 * classification call, best-effort). Small local models do this constantly;
 * without recovery the worker's never-create-from-relations guard silently
 * drops the edge, which is why fresh installs saw graphs with entities but
 * few relations.
 */
export async function extract(
  text: string,
  config: ExtractConfig
): Promise<ExtractionOutput> {
  const primary = await extractOnce(text, config, config.system ?? EXTRACTION_SYSTEM);
  if (config.provider === "fake") return primary;

  const missing = missingRelationEndpoints(primary);
  if (missing.length === 0) return primary;
  try {
    const recovered = await extractOnce(
      endpointClassifyInput(missing, text),
      config,
      ENDPOINT_CLASSIFY_SYSTEM
    );
    return mergeRecoveredEntities(primary, recovered.entities, missing);
  } catch {
    // Recovery is best-effort — never fail the primary extraction over it.
    return primary;
  }
}

export async function extractWithAnthropic(
  client: Anthropic,
  model: string,
  system: string,
  input: string
): Promise<ExtractionOutput> {
  const response = await client.messages.create({
    model,
    max_tokens: 800,
    temperature: 0,
    system,
    messages: [{ role: "user", content: `Text:\n\n${input}` }],
  });
  const textBlock = response.content.find((p) => p.type === "text");
  if (!textBlock || textBlock.type !== "text")
    return { entities: [], relations: [] };
  return safeParse(textBlock.text);
}

export async function extractWithOllama(
  baseUrl: string,
  model: string,
  system: string,
  input: string
): Promise<ExtractionOutput> {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json", // forces valid JSON output
      options: { temperature: 0 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Text:\n\n${input}` },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama extraction error ${res.status}: ${err}`);
  }
  const json = (await res.json()) as { message?: { content?: string } };
  return safeParse(json.message?.content ?? "");
}
