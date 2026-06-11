/**
 * Sanitize unit tests — verify injected memory tags are stripped.
 *
 */
import { describe, it, expect } from "vitest";
import { sanitize } from "./sanitize.js";

describe("sanitize", () => {
  describe("single-bracket system tags", () => {
    it("strips [memory:id:xxx] tags", () => {
      expect(sanitize("Hello [memory:id:abc-123] world")).toBe("Hello  world");
    });

    it("strips [brain:chunk:xxx] tags", () => {
      expect(sanitize("[brain:chunk:def-456] content here")).toBe("content here");
    });

    it("strips [mcp:ref:xxx] tags", () => {
      expect(sanitize("see [mcp:ref:abc] for details")).toBe("see  for details");
    });

    it("strips [system:agent:xxx] tags", () => {
      expect(sanitize("from [system:agent:bot-1]")).toBe("from");
    });

    it("strips [hyobject:xxx] tags", () => {
      expect(sanitize("object [hyobject:abc-def-ghi] created")).toBe("object  created");
    });

    it("strips [chunk:xxx] tags", () => {
      expect(sanitize("[chunk:1] paragraph text")).toBe("paragraph text");
    });

    it("strips [ref:xxx] tags", () => {
      expect(sanitize("reference [ref:note-42] here")).toBe("reference  here");
    });

    it("strips [source:xxx] tags", () => {
      expect(sanitize("from [source:agent_memory] store")).toBe("from  store");
    });

    it("strips [id:xxx] tags", () => {
      expect(sanitize("entity [id:user-007] updated")).toBe("entity  updated");
    });

    it("strips case-insensitive", () => {
      expect(sanitize("Hello [MEMORY:id:ABC] world [Brain:chunk:DEF]")).toBe("Hello  world");
    });
  });

  describe("double-bracket system tags", () => {
    it("strips [[memory:id:xxx]] tags", () => {
      expect(sanitize("text [[memory:id:abc-123]] more")).toBe("text  more");
    });

    it("strips [[brain:ref:xxx]] tags", () => {
      expect(sanitize("[[brain:ref:note-1]] start of text")).toBe("start of text");
    });

    it("strips [[chunk:xxx]] tags", () => {
      expect(sanitize("middle [[chunk:5]] end")).toBe("middle  end");
    });

    it("strips [[source:xxx]] tags", () => {
      expect(sanitize("[[source:agent_memory]] content")).toBe("content");
    });

    it("strips [[id:xxx]] tags", () => {
      expect(sanitize("[[id:fact-42]] learned something")).toBe("learned something");
    });

    it("strips case-insensitive", () => {
      expect(sanitize("[[MEMORY:id:X]] [[Brain:chunk:Y]]")).toBe("");
    });
  });

  describe("HTML comments", () => {
    it("strips single-line HTML comments", () => {
      expect(sanitize("before <!-- comment --> after")).toBe("before  after");
    });

    it("strips multi-line HTML comments", () => {
      const input = "top\n<!-- metadata\ninjected here -->\nbottom";
      expect(sanitize(input)).toBe("top\n\nbottom");
    });

    it("strips HTML comments with memory tag content", () => {
      expect(sanitize("text <!-- memory:id:abc-123 --> more")).toBe("text  more");
    });
  });

  describe("content preservation", () => {
    it("preserves normal text unchanged", () => {
      const text = "Project Brain uses pgvector for vector storage.";
      expect(sanitize(text)).toBe(text);
    });

    it("preserves code blocks", () => {
      const code = "```python\nprint('hello')\n```";
      expect(sanitize(code)).toBe(code);
    });

    it("preserves markdown links", () => {
      const md = "[link text](https://example.com)";
      expect(sanitize(md)).toBe(md);
    });

    it("preserves valid wiki-style content without namespace prefix", () => {
      const wiki = "I read about [[machine learning]] today.";
      expect(sanitize(wiki)).toBe(wiki);
    });

    it("preserves UUIDs and IDs that are not tagged", () => {
      const text = "hyobject_id=abc-123-def is the primary key";
      expect(sanitize(text)).toBe(text);
    });

    it("preserves bracket content that is not a system tag", () => {
      const text = "Use the [official documentation](link) and [Guide] for setup.";
      expect(sanitize(text)).toBe(text);
    });
  });

  describe("whitespace cleanup", () => {
    it("collapses triple+ spaces to double spaces", () => {
      expect(sanitize("a  [memory:id:x]  b")).toBe("a  b");
    });

    it("collapses triple+ newlines to double", () => {
      const input = "line1\n\n\n\nline2";
      const result = sanitize(input);
      expect(result).toBe("line1\n\nline2");
    });

    it("trims leading and trailing whitespace", () => {
      expect(sanitize("   [memory:id:x] content   ")).toBe("content");
    });
  });

  describe("idempotency", () => {
    it("is idempotent — safe to call multiple times", () => {
      const input = "[memory:id:abc] [brain:chunk:def] hello [[ref:ghi]]";
      const first = sanitize(input);
      const second = sanitize(first);
      expect(second).toBe(first);
    });
  });

  describe("real-world feedback loop scenarios", () => {
    it("strips memory tags that could accumulate on re-ingestion", () => {
      const infected = "Client XYZ uses Postgres [memory:id:prev-1] [brain:chunk:prev-2] for analytics";
      const clean = sanitize(infected);
      expect(clean).not.toContain("[memory:");
      expect(clean).not.toContain("[brain:");
      expect(clean).toContain("Client XYZ uses Postgres");
      expect(clean).toContain("for analytics");
    });

    it("prevents tag accumulation across multiple save/recall cycles", () => {
      let content = "Project Alpha launched in Q2.";
      for (let i = 0; i < 5; i++) {
        content = sanitize(`[memory:id:cycle-${i}] ${content} [[brain:ref:xyz]]`);
      }
      expect(content).not.toMatch(/\[memory:|\[brain:|\[\[brain:/);
      expect(content).toContain("Project Alpha launched in Q2.");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(sanitize("")).toBe("");
    });

    it("handles string of only tags", () => {
      expect(sanitize("[memory:id:x] [[brain:ref:y]]")).toBe("");
    });

    it("handles string with only whitespace and tags", () => {
      expect(sanitize("  [memory:id:x]  \n  [[brain:ref:y]]  ")).toBe("");
    });

    it("handles very long content", () => {
      const long = "a".repeat(10000) + "[memory:id:abc]" + "b".repeat(10000);
      const result = sanitize(long);
      expect(result).not.toContain("[memory:");
      expect(result.length).toBe(20000);
    });
  });
});
