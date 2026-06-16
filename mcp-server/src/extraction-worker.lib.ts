export interface ExtractedEntity {
  name: string;
  kind: string;
  aliases?: string[];
  confidence: number;
}

export interface ExtractedRelation {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface ExtractionOutput {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

export function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function normalizeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeKind(kind: unknown): string {
  if (typeof kind !== "string" || kind.trim().length === 0) return "concept";
  return kind.trim().toLowerCase();
}

/**
 * Canonicalize a predicate. Small local models decorate predicates with
 * temporal adverbs ("now works for", "currently located in") — without
 * stripping them, the edge lands beside the canonical one instead of
 * matching it, and functional-predicate supersession never fires.
 */
const PREDICATE_ADVERBS =
  /^(now|currently|still|recently|previously|formerly|today)\s+/;

export function normalizePredicate(predicate: string): string {
  let p = predicate.toLowerCase().trim();
  for (let prev = ""; prev !== p; ) {
    prev = p;
    p = p.replace(PREDICATE_ADVERBS, "");
  }
  return p;
}

export function normalizeAliases(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) return [];
  const seen = new Set<string>();
  for (const item of aliases) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    seen.add(v);
    // Looping models hallucinate endless alias variants; nothing legitimate
    // needs more than a handful.
    if (seen.size >= 5) break;
  }
  return [...seen];
}

/**
 * Repair JSON cut off mid-generation (num_predict cap hit during a model
 * repetition loop): rewind to the last complete array element, then close
 * every bracket still open. The complete leading elements — the actual
 * extraction — survive; only the truncated tail is dropped.
 */
export function repairTruncatedJson(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastComplete = -1; // index AFTER the last cleanly-closed value at depth ≥1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      lastComplete = i + 1;
    }
  }
  if (lastComplete === -1) return text;
  // Re-scan the kept prefix to know which brackets remain open.
  const kept = text.slice(0, lastComplete);
  const open: string[] = [];
  inString = false;
  escaped = false;
  for (const ch of kept) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") open.push(ch);
    else if (ch === "}" || ch === "]") open.pop();
  }
  return kept + open.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
}

export function safeParse(jsonText: string): ExtractionOutput {
  let parsed: { entities?: unknown; relations?: unknown };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    parsed = JSON.parse(repairTruncatedJson(jsonText)) as typeof parsed;
  }
  const rawEntities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const entities: ExtractedEntity[] = [];

  for (const item of rawEntities) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = normalizeName(obj.name);
    if (!name) continue;
    entities.push({
      name,
      kind: normalizeKind(obj.kind),
      aliases: normalizeAliases(obj.aliases),
      confidence: clampConfidence(obj.confidence),
    });
  }

  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
  // Looping models re-emit the same triple dozens of times — dedupe on
  // (subject, predicate, object), keeping the highest confidence seen.
  const relationByKey = new Map<string, ExtractedRelation>();
  for (const item of rawRelations) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const subject = normalizeName(obj.subject);
    const object = normalizeName(obj.object);
    const predicate = normalizeName(obj.predicate);
    // A relation is only useful if both endpoints and a predicate are present
    // and the two endpoints differ.
    if (!subject || !object || !predicate) continue;
    if (subject.toLowerCase() === object.toLowerCase()) continue;
    const rel: ExtractedRelation = {
      subject,
      object,
      predicate: normalizePredicate(predicate),
      confidence: clampConfidence(obj.confidence),
    };
    const key = `${rel.subject.toLowerCase()}|${rel.predicate}|${rel.object.toLowerCase()}`;
    const prev = relationByKey.get(key);
    if (!prev || rel.confidence > prev.confidence) relationByKey.set(key, rel);
  }

  return { entities, relations: [...relationByKey.values()] };
}

export function fakeExtractEntities(text: string): ExtractionOutput {
  const names = Array.from(
    new Set((text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) ?? []).slice(0, 8)),
  );
  return {
    // Tokens prefixed "Orgz" simulate a high-confidence catalog-kind entity,
    // so gated checks can exercise the auto-promotion path (and strict
    // curation mode's blocking of it) without an LLM. Everything else stays a
    // low-confidence novel "concept" (exercises the dynamic-schema path).
    entities: names.map((name) =>
      name.startsWith("Orgz")
        ? { name, kind: "organization", aliases: [], confidence: 0.9 }
        : { name, kind: "concept", aliases: [], confidence: 0.55 },
    ),
    relations: [],
  };
}

/**
 * Names referenced as relation endpoints that are absent from the entities
 * list (case-insensitive; aliases count). Small local models frequently emit
 * a correct relation while forgetting to list one of its endpoints as an
 * entity — without recovery, the worker's anti-hallucination guard then drops
 * the edge entirely. Capped at 8 names; junk (single chars) skipped.
 */
export function missingRelationEndpoints(output: ExtractionOutput): string[] {
  const known = new Set<string>();
  for (const e of output.entities) {
    known.add(e.name.toLowerCase());
    for (const a of e.aliases ?? []) known.add(a.toLowerCase());
  }
  const missing = new Map<string, string>();
  for (const r of output.relations ?? []) {
    for (const name of [r.subject, r.object]) {
      const key = name.trim().toLowerCase();
      if (key.length >= 2 && !known.has(key) && !missing.has(key)) {
        missing.set(key, name.trim());
      }
    }
  }
  return [...missing.values()].slice(0, 8);
}

/**
 * Merge entities recovered by the endpoint-classification pass into the
 * primary output. Only names that were actually requested are accepted (the
 * model must not introduce new entities here), and existing names win.
 */
export function mergeRecoveredEntities(
  output: ExtractionOutput,
  recovered: ExtractionOutput["entities"],
  requested: string[],
): ExtractionOutput {
  const want = new Set(requested.map((n) => n.toLowerCase()));
  const have = new Set(output.entities.map((e) => e.name.toLowerCase()));
  const additions = recovered.filter((e) => {
    const key = e.name.toLowerCase();
    if (!want.has(key) || have.has(key)) return false;
    have.add(key);
    return true;
  });
  return {
    entities: [...output.entities, ...additions],
    relations: output.relations,
  };
}
