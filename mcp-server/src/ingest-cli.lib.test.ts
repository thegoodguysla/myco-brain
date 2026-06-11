import { describe, it, expect } from "vitest";
import {
  isTextFile,
  looksBinary,
  parseGitHubTarget,
  SKIP_DIRS,
} from "./ingest-cli.lib.js";

describe("isTextFile", () => {
  it("accepts known code/doc/config extensions", () => {
    for (const f of ["a.md", "src/index.ts", "config.yaml", "q.sql", "main.py"]) {
      expect(isTextFile(f)).toBe(true);
    }
  });

  it("accepts extension-less files by basename", () => {
    expect(isTextFile("repo/Dockerfile")).toBe(true);
    expect(isTextFile("repo/README")).toBe(true);
    expect(isTextFile("repo/.gitignore")).toBe(true);
  });

  it("rejects binary/unknown extensions", () => {
    for (const f of ["img.png", "a.zip", "vid.mp4", "lib.so", "font.woff2"]) {
      expect(isTextFile(f)).toBe(false);
    }
  });
});

describe("looksBinary", () => {
  it("flags buffers containing a NUL byte", () => {
    expect(looksBinary(Buffer.from([104, 105, 0, 33]))).toBe(true);
  });

  it("passes clean UTF-8 text", () => {
    expect(looksBinary(Buffer.from("hello world\n# heading", "utf8"))).toBe(false);
  });
});

describe("parseGitHubTarget", () => {
  it("parses github: shorthand", () => {
    expect(parseGitHubTarget("github:octocat/Hello-World")).toBe("octocat/Hello-World");
    expect(parseGitHubTarget("github:owner/repo.git")).toBe("owner/repo");
  });

  it("parses https github URLs", () => {
    expect(parseGitHubTarget("https://github.com/owner/repo")).toBe("owner/repo");
    expect(parseGitHubTarget("https://github.com/owner/repo.git")).toBe("owner/repo");
    expect(parseGitHubTarget("https://github.com/owner/repo/tree/main")).toBe("owner/repo");
  });

  it("returns null for non-GitHub targets", () => {
    expect(parseGitHubTarget("./local/dir")).toBeNull();
    expect(parseGitHubTarget("/abs/path/file.md")).toBeNull();
    expect(parseGitHubTarget("github:incomplete")).toBeNull();
  });
});

describe("SKIP_DIRS", () => {
  it("includes the usual noise directories", () => {
    for (const d of ["node_modules", ".git", "dist", "__pycache__"]) {
      expect(SKIP_DIRS.has(d)).toBe(true);
    }
  });
});
