import { describe, it, expect } from "vitest";
import {
  parseChatGptConversations,
  parseClaudeConversations,
} from "./export-import.lib.js";

const msg = (id: string, parent: string | null, role: string, text: string, t: number) => ({
  id,
  parent,
  message: {
    author: { role },
    content: { parts: [text] },
    create_time: t,
  },
});

describe("parseChatGptConversations", () => {
  it("walks the ACTIVE branch via current_node (regenerations excluded)", () => {
    const convo = {
      id: "conv-1",
      title: "Trip planning",
      create_time: 1750000000,
      update_time: 1750000300,
      current_node: "n3",
      mapping: {
        n1: msg("n1", null, "user", "Plan a trip to Kyoto", 1750000000),
        // n2a is a REJECTED regeneration branch — must not appear
        n2a: msg("n2a", "n1", "assistant", "WRONG BRANCH", 1750000100),
        n2b: msg("n2b", "n1", "assistant", "Sure — autumn is ideal.", 1750000150),
        n3: msg("n3", "n2b", "user", "Book November then.", 1750000200),
      },
    };
    const [c] = parseChatGptConversations([convo]);
    expect(c.id).toBe("conv-1");
    expect(c.messageCount).toBe(3);
    expect(c.text).toContain("Plan a trip to Kyoto");
    expect(c.text).toContain("autumn is ideal");
    expect(c.text).toContain("Book November then");
    expect(c.text).not.toContain("WRONG BRANCH");
    expect(c.text).toContain("ChatGPT Conversation: Trip planning");
  });

  it("falls back to create_time order when current_node is missing", () => {
    const convo = {
      id: "conv-2",
      title: "Fallback",
      mapping: {
        b: msg("b", "a", "assistant", "second", 200),
        a: msg("a", null, "user", "first", 100),
      },
    };
    const [c] = parseChatGptConversations([convo]);
    expect(c.text.indexOf("first")).toBeLessThan(c.text.indexOf("second"));
  });

  it("skips empty conversations and junk rows; rejects non-arrays", () => {
    expect(parseChatGptConversations([{ id: "x", title: "empty", mapping: {} }, null, 42])).toEqual([]);
    expect(() => parseChatGptConversations({})).toThrow(/array/);
  });
});

describe("parseClaudeConversations", () => {
  it("parses chat_messages with text and content-array fallbacks", () => {
    const convo = {
      uuid: "u-1",
      name: "Recipe ideas",
      created_at: "2026-06-01T10:00:00Z",
      chat_messages: [
        { sender: "human", text: "Ideas for dinner?", created_at: "2026-06-01T10:00:00Z" },
        { sender: "assistant", text: "", content: [{ type: "text", text: "Try shakshuka." }] },
        { sender: "assistant", text: "   " }, // empty — skipped
      ],
    };
    const [c] = parseClaudeConversations([convo]);
    expect(c.id).toBe("u-1");
    expect(c.messageCount).toBe(2);
    expect(c.text).toContain("Claude Conversation: Recipe ideas");
    expect(c.text).toContain("Ideas for dinner?");
    expect(c.text).toContain("Try shakshuka.");
    expect(c.createdAt).toBe("2026-06-01T10:00:00.000Z");
  });

  it("skips empty conversations; rejects non-arrays", () => {
    expect(parseClaudeConversations([{ uuid: "e", name: "empty", chat_messages: [] }])).toEqual([]);
    expect(() => parseClaudeConversations("nope")).toThrow(/array/);
  });
});
