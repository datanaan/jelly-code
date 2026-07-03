import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import { extractBlame, parseBlameOutput, summarizeOwnership } from "../../src/temporal/blame-parser.js";

const mockedExecSync = vi.mocked(execSync);

// Sample git blame --line-porcelain output (40-char hex hashes)
const samplePorcelain = [
  "abc123def456789012345678901234567890abcd 1 1 1",
  "author Alice",
  "author-mail <alice@example.com>",
  "author-time 1705312800",
  "author-tz +0800",
  "summary feat: initial commit",
  "",
  "\tconst x = 1;",
  "",
  "def456abc789012345678901234567890abcdef0 2 2 1",
  "author Bob",
  "author-mail <bob@example.com>",
  "author-time 1705399200",
  "author-tz +0800",
  "summary fix: edge case",
  "",
  "\tconst y = 2;",
  "",
  "abc123def456789012345678901234567890abcd 1 3 1",
  "author Alice",
  "author-mail <alice@example.com>",
  "author-time 1705312800",
  "author-tz +0800",
  "summary feat: initial commit",
  "",
  "\treturn x + y;",
].join("\n");

describe("parseBlameOutput", () => {
  it("should parse normal blame porcelain output", () => {
    const lines = parseBlameOutput(samplePorcelain);

    expect(lines).toHaveLength(3);

    expect(lines[0].lineNumber).toBe(1);
    expect(lines[0].commitHash).toBe("abc123def456789012345678901234567890abcd");
    expect(lines[0].author).toBe("Alice");
    expect(lines[0].authorEmail).toBe("alice@example.com");
    expect(lines[0].content).toBe("const x = 1;");

    expect(lines[1].lineNumber).toBe(2);
    expect(lines[1].commitHash).toBe("def456abc789012345678901234567890abcdef0");
    expect(lines[1].author).toBe("Bob");
    expect(lines[1].content).toBe("const y = 2;");

    expect(lines[2].lineNumber).toBe(3);
    expect(lines[2].author).toBe("Alice");
    expect(lines[2].content).toBe("return x + y;");
  });

  it("should summarize ownership percentages", () => {
    const lines = parseBlameOutput(samplePorcelain);
    const summaries = summarizeOwnership(lines);

    expect(summaries).toHaveLength(2);

    // Alice has 2 lines, Bob has 1 line
    const alice = summaries.find((s) => s.author === "Alice")!;
    const bob = summaries.find((s) => s.author === "Bob")!;

    expect(alice.contributionLines).toBe(2);
    expect(alice.percentage).toBeCloseTo(2 / 3, 3);

    expect(bob.contributionLines).toBe(1);
    expect(bob.percentage).toBeCloseTo(1 / 3, 3);
  });

  it("should return empty array for empty blame output", () => {
    expect(parseBlameOutput("")).toEqual([]);
    expect(parseBlameOutput("   ")).toEqual([]);
    expect(summarizeOwnership([])).toEqual([]);
  });

  it("should return empty array when file not found", () => {
    const error = new Error("fatal: no such path 'missing.ts' in HEAD");
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    const result = extractBlame("/tmp/repo", "missing.ts");
    expect(result).toEqual([]);
  });
});
