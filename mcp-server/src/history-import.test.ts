import { describe, it, expect } from "vitest";
import {
  summarizeConversations,
  summarizeExportJson,
  scanForExport,
  describeCandidate,
  providerLabel,
  type ScanIo,
} from "./history-import.lib.js";

// A minimal ChatGPT conversations.json node tree: one user + one assistant turn.
function chatgptExport(opts: { title?: string; create?: number; update?: number }): unknown {
  return [
    {
      id: "conv-1",
      title: opts.title ?? "A chat",
      create_time: opts.create ?? 1_700_000_000,
      update_time: opts.update ?? 1_700_000_500,
      current_node: "b",
      mapping: {
        a: { id: "a", parent: null, message: { author: { role: "user" }, content: { parts: ["hi"] }, create_time: opts.create } },
        b: { id: "b", parent: "a", message: { author: { role: "assistant" }, content: { parts: ["hello"] }, create_time: opts.update } },
      },
    },
  ];
}

const claudeExport: unknown = [
  {
    uuid: "u-1",
    name: "Claude chat",
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-03T00:00:00Z",
    chat_messages: [
      { sender: "human", text: "hey", created_at: "2026-01-02T00:00:00Z" },
      { sender: "assistant", text: "yo", created_at: "2026-01-03T00:00:00Z" },
    ],
  },
];

function io(over: Partial<ScanIo> = {}): ScanIo {
  return {
    listZips: async () => ["/dl/chatgpt-export.zip"],
    entriesOf: () => ["conversations.json", "chat.html", "user.json"],
    readConversationsJson: () => JSON.stringify(chatgptExport({})),
    ...over,
  };
}

describe("history-import: summarize", () => {
  it("computes count + min/max date range across created/updated", () => {
    const s = summarizeExportJson("chatgpt-export", chatgptExport({ create: 1_704_067_200, update: 1_750_000_000 }));
    expect(s.count).toBe(1);
    expect(s.from).not.toBeNull();
    expect(s.to).not.toBeNull();
    expect(s.from! <= s.to!).toBe(true);
  });

  it("empty conversation list summarizes to count 0", () => {
    expect(summarizeConversations([]).count).toBe(0);
  });

  it("rejects a non-array conversations.json (wrong structure)", () => {
    expect(() => summarizeExportJson("chatgpt-export", { not: "an array" })).toThrow();
  });
});

describe("history-import: scanForExport (two-gate validation)", () => {
  it("returns the candidate when names + JSON both validate", async () => {
    const c = await scanForExport("/dl", io());
    expect(c).not.toBeNull();
    expect(c!.kind).toBe("chatgpt-export");
    expect(c!.filename).toBe("chatgpt-export.zip");
    expect(c!.summary.count).toBe(1);
  });

  it("detects a Claude export by its discriminator files", async () => {
    const c = await scanForExport("/dl", io({
      entriesOf: () => ["conversations.json", "projects.json", "users.json"],
      readConversationsJson: () => JSON.stringify(claudeExport),
    }));
    expect(c!.kind).toBe("claude-export");
    expect(providerLabel(c!.kind)).toBe("Claude");
  });

  it("skips a zip whose names don't match any export shape", async () => {
    const c = await scanForExport("/dl", io({
      entriesOf: () => ["photos/IMG_001.jpg", "notes.txt"],
    }));
    expect(c).toBeNull();
  });

  it("skips a matching-name zip whose conversations.json is not JSON", async () => {
    const c = await scanForExport("/dl", io({ readConversationsJson: () => "<<not json>>" }));
    expect(c).toBeNull();
  });

  it("skips a structurally-valid but EMPTY export (nothing to offer)", async () => {
    const c = await scanForExport("/dl", io({ readConversationsJson: () => "[]" }));
    expect(c).toBeNull();
  });

  it("skips unreadable zips and keeps scanning to the next candidate", async () => {
    const c = await scanForExport("/dl", io({
      listZips: async () => ["/dl/broken.zip", "/dl/chatgpt-export.zip"],
      entriesOf: (z) => {
        if (z.endsWith("broken.zip")) throw new Error("unzip failed");
        return ["conversations.json", "user.json"];
      },
    }));
    expect(c).not.toBeNull();
    expect(c!.zipPath).toBe("/dl/chatgpt-export.zip");
  });

  it("returns null (not a throw) when the folder can't be listed", async () => {
    const c = await scanForExport("/dl", io({ listZips: async () => { throw new Error("ENOENT"); } }));
    expect(c).toBeNull();
  });
});

describe("history-import: describeCandidate", () => {
  it("renders a non-technical one-liner with count + range", async () => {
    const c = await scanForExport("/dl", io())!;
    const line = describeCandidate(c!);
    expect(line).toMatch(/1 ChatGPT conversation\b/);
    expect(line).toMatch(/from /);
  });

  it("pluralizes and thousands-separates the count", () => {
    const line = describeCandidate({
      zipPath: "/dl/x.zip",
      filename: "x.zip",
      kind: "chatgpt-export",
      summary: { count: 1240, from: null, to: null },
    });
    expect(line).toMatch(/1,240 ChatGPT conversations/);
  });
});
