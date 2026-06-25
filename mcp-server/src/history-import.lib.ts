/**
 * Safe history-import detection — find a ChatGPT/Claude data export sitting in a
 * folder (typically ~/Downloads) and describe it well enough for a ONE-TAP
 * confirm before anything is read into the brain. Import is never silent: the
 * caller shows count + date-range + filename and only ingests on an explicit yes.
 *
 * Validation is deliberately two-gate so we never offer to import a random zip:
 *   1. the zip's file names match a known export shape (discriminator file), and
 *   2. its conversations.json parses AND yields at least one conversation.
 *
 * The pure functions here reuse the existing parsers (export-import.lib) and the
 * existing detector (ingest-cli.lib); the real zip/unzip I/O is injected so the
 * whole module is unit-testable without a real export on disk.
 */
import { basename } from "node:path";
import { detectExportKind, type ExportKind } from "./ingest-cli.lib.js";
import {
  parseChatGptConversations,
  parseClaudeConversations,
  type ExportConversation,
} from "./export-import.lib.js";

export type { ExportKind };

export interface ExportSummary {
  /** Number of conversations the export contains. */
  count: number;
  /** Earliest conversation timestamp (ISO), or null if none carry dates. */
  from: string | null;
  /** Latest conversation timestamp (ISO), or null. */
  to: string | null;
}

/** Earliest/latest conversation timestamps + count — the confirm-modal facts. */
export function summarizeConversations(convs: ExportConversation[]): ExportSummary {
  let from: string | null = null;
  let to: string | null = null;
  for (const c of convs) {
    for (const d of [c.createdAt, c.updatedAt]) {
      if (!d) continue;
      if (from === null || d < from) from = d;
      if (to === null || d > to) to = d;
    }
  }
  return { count: convs.length, from, to };
}

/**
 * Parse an already-JSON-parsed conversations.json for the given export kind and
 * summarize it. Throws if the structure is not a valid export (the parsers
 * enforce "must be an array"); a structurally-valid-but-empty export returns
 * count 0 so the caller can decline to offer it.
 */
export function summarizeExportJson(kind: ExportKind, parsed: unknown): ExportSummary {
  const convs =
    kind === "chatgpt-export"
      ? parseChatGptConversations(parsed)
      : parseClaudeConversations(parsed);
  return summarizeConversations(convs);
}

export interface ExportCandidate {
  /** Absolute path to the export .zip. */
  zipPath: string;
  /** Just the filename, for display. */
  filename: string;
  kind: ExportKind;
  summary: ExportSummary;
}

/** Injected I/O so the scanner needs no real zips (and no `unzip`) under test. */
export interface ScanIo {
  /** Absolute paths of candidate .zip files, newest first. */
  listZips(dir: string): Promise<string[]>;
  /** File names inside the zip (for the discriminator check). */
  entriesOf(zipPath: string): string[];
  /** Raw text of conversations.json inside the zip. */
  readConversationsJson(zipPath: string): string;
}

/**
 * Scan a directory for the newest valid ChatGPT/Claude export and return enough
 * to show a confirm modal, or null when none is found. Each gate that fails
 * (unreadable zip, unknown shape, unparseable JSON, empty export) skips that zip
 * and moves on — so a folder full of unrelated zips yields null, not a false
 * offer.
 */
export async function scanForExport(dir: string, io: ScanIo): Promise<ExportCandidate | null> {
  let zips: string[];
  try {
    zips = await io.listZips(dir);
  } catch {
    return null;
  }
  for (const zipPath of zips) {
    let kind: ExportKind | null;
    try {
      kind = detectExportKind(io.entriesOf(zipPath));
    } catch {
      continue; // not a readable zip (or `unzip` unavailable)
    }
    if (!kind) continue;
    let summary: ExportSummary;
    try {
      summary = summarizeExportJson(kind, JSON.parse(io.readConversationsJson(zipPath)));
    } catch {
      continue; // no/!valid conversations.json -> not a real export
    }
    if (summary.count === 0) continue; // structurally valid but empty -> skip
    return { zipPath, filename: basename(zipPath), kind, summary };
  }
  return null;
}

/** Human label for the export source ("ChatGPT" / "Claude"). */
export function providerLabel(kind: ExportKind): string {
  return kind === "chatgpt-export" ? "ChatGPT" : "Claude";
}

/**
 * One-line, non-technical description of an export for the confirm prompt, e.g.
 * "1,240 ChatGPT conversations from Jan 2024 to Jun 2026". Dates degrade
 * gracefully when the export carries none.
 */
export function describeCandidate(c: ExportCandidate): string {
  const n = c.summary.count.toLocaleString("en-US");
  const noun = c.summary.count === 1 ? "conversation" : "conversations";
  const range = formatRange(c.summary.from, c.summary.to);
  return `${n} ${providerLabel(c.kind)} ${noun}${range ? ` ${range}` : ""}`;
}

function formatRange(from: string | null, to: string | null): string {
  const m = (iso: string | null): string | null => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  };
  const a = m(from);
  const b = m(to);
  if (a && b) return a === b ? `from ${a}` : `from ${a} to ${b}`;
  if (a) return `from ${a}`;
  if (b) return `through ${b}`;
  return "";
}
