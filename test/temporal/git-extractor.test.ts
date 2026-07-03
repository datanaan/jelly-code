import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitExtractOptions } from "../../src/temporal/types.js";

// Mock child_process before importing the module under test
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Import after mocking
import { execSync } from "child_process";
import { extractGitLog } from "../../src/temporal/git-extractor.js";

const mockedExecSync = vi.mocked(execSync);

describe("extractGitLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should extract commits from normal git log output", () => {
    const gitOutput = [
      "abc123def456abc123def456abc123def456abcd|Alice|alice@example.com|2026-01-15T10:00:00+08:00|feat: add feature",
      "M\tsrc/main.ts",
      "",
      "def456789abcdef456789abcdef456789abcdef4|Bob|bob@example.com|2026-01-14T08:00:00+08:00|fix: bug",
      "A\tsrc/new.ts",
    ].join("\n");

    mockedExecSync.mockReturnValue(gitOutput);

    const result = extractGitLog("/tmp/repo");
    expect(result.isGitRepo).toBe(true);
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0].hash).toBe("abc123def456abc123def456abc123def456abcd");
    expect(result.commits[0].changedFiles[0].filePath).toBe("src/main.ts");
  });

  it("should do incremental extraction with since hash", () => {
    mockedExecSync.mockReturnValue("");

    const options: GitExtractOptions = { since: "abc123def" };
    extractGitLog("/tmp/repo", options);

    const calledCmd = mockedExecSync.mock.calls[0][0] as string;
    expect(calledCmd).toContain("abc123def..HEAD");
  });

  it("should return isGitRepo: false for non-git repo", () => {
    const error = new Error("fatal: not a git repository");
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    const result = extractGitLog("/tmp/not-a-repo");
    expect(result.isGitRepo).toBe(false);
    expect(result.commits).toEqual([]);
  });

  it("should return empty commits for empty repo", () => {
    const error = new Error("fatal: your current branch does not have any commits yet");
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    const result = extractGitLog("/tmp/empty-repo");
    expect(result.isGitRepo).toBe(true);
    expect(result.commits).toEqual([]);
  });

  it("should respect max commits limit", () => {
    mockedExecSync.mockReturnValue("");

    const options: GitExtractOptions = { maxCommits: 50 };
    extractGitLog("/tmp/repo", options);

    const calledCmd = mockedExecSync.mock.calls[0][0] as string;
    expect(calledCmd).toContain("--max-count=50");
  });

  it("should handle timeout gracefully", () => {
    const error = new Error("execSync ETIMEDOUT: process timed out");
    mockedExecSync.mockImplementation(() => {
      throw error;
    });

    const result = extractGitLog("/tmp/huge-repo");
    expect(result.isGitRepo).toBe(true);
    expect(result.commits).toEqual([]);
  });
});
