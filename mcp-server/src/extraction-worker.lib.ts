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

export function normalizeAliases(aliases: unknown): string[] {
  if (!Array.isArray(aliases)) return [];
  const seen = new Set<string>();
  for (const item of aliases) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    seen.add(v);
  }
  return [...seen];
}

export function safeParse(jsonText: string): ExtractionOutput {
  const parsed = JSON.parse(jsonText) as {
    entities?: unknown;
    relations?: unknown;
  };
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
  const relations: ExtractedRelation[] = [];
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
    relations.push({
      subject,
      object,
      predicate: predicate.toLowerCase(),
      confidence: clampConfidence(obj.confidence),
    });
  }

  return { entities, relations };
}

export function fakeExtractEntities(text: string): ExtractionOutput {
  const names = Array.from(
    new Set((text.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) ?? []).slice(0, 8)),
  );
  return {
    entities: names.map((name) => ({
      name,
      kind: "concept",
      aliases: [],
      confidence: 0.55,
    })),
    relations: [],
  };
}
