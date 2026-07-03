import { describe, it, expect } from "vitest";
import { parseGitLogOutput, parseFileChanges, mapFileChangesToNodes } from "../../src/temporal/commit-parser.js";

describe("parseGitLogOutput", () => {
  it("should parse normal multi-commit output", () => {
    const raw = [
      "abc123def456abc123def456abc123def456abcd|Alice|alice@example.com|2026-01-15T10:00:00+08:00|feat: add parser",
      "M\tparser.ts",
      "A\tnew-file.ts",
      "",
      "789abc456def789abc456def789abc456def78ab|Bob|bob@example.com|2026-01-14T09:00:00+08:00|fix: buffer overflow",
      "D\told-file.ts",
    ].join("\n");

    const commits = parseGitLogOutput(raw);
    expect(commits).toHaveLength(2);

    expect(commits[0].hash).toBe("abc123def456abc123def456abc123def456abcd");
    expect(commits[0].author).toBe("Alice");
    expect(commits[0].authorEmail).toBe("alice@example.com");
    expect(commits[0].timestamp).toBe("2026-01-15T10:00:00+08:00");
    expect(commits[0].message).toBe("feat: add parser");
    expect(commits[0].changedFiles).toHaveLength(2);
    expect(commits[0].changedFiles[0].filePath).toBe("parser.ts");
    expect(commits[0].changedFiles[0].changeType).toBe("modified");

    expect(commits[1].hash).toBe("789abc456def789abc456def789abc456def78ab");
    expect(commits[1].message).toBe("fix: buffer overflow");
    expect(commits[1].changedFiles[0].changeType).toBe("deleted");
  });

  it("should parse file changes with A/M/D types", () => {
    const lines = ["A\tadded.ts", "M\tmodified.ts", "D\tdeleted.ts"];
    const changes = parseFileChanges(lines);

    expect(changes).toHaveLength(3);
    expect(changes[0]).toEqual({ filePath: "added.ts", changeType: "added" });
    expect(changes[1]).toEqual({ filePath: "modified.ts", changeType: "modified" });
    expect(changes[2]).toEqual({ filePath: "deleted.ts", changeType: "deleted" });
  });

  it("should parse rename entries (R100 old new)", () => {
    const lines = ["R100\told/path.ts\tnew/path.ts"];
    const changes = parseFileChanges(lines);

    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe("renamed");
    expect(changes[0].filePath).toBe("old/path.ts");
    expect(changes[0].newPath).toBe("new/path.ts");
  });

  it("should skip merge commits (handled by --no-merges flag, not in output)", () => {
    // Merge commits are excluded by the --no-merges git flag,
    // so the parser doesn't need special handling.
    // We verify isMerge is always false from parseGitLogOutput.
    const raw = "abc123def456abc123def456abc123def456abcd|Alice|a@b.com|2026-01-01T00:00:00Z|normal commit\nM\tfile.ts";
    const commits = parseGitLogOutput(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0].isMerge).toBe(false);
  });

  it("should return empty array for empty output", () => {
    expect(parseGitLogOutput("")).toEqual([]);
    expect(parseGitLogOutput("  \n  ")).toEqual([]);
  });

  it("should mapFileChangesToNodes with mock findFileNodeIds", async () => {
    const changes = [
      { filePath: "src/a.ts", changeType: "modified" as const },
      { filePath: "src/missing.ts", changeType: "added" as const },
      { filePath: "src/b.ts", changeType: "deleted" as const },
    ];

    const findFileNodeIds = async (path: string): Promise<string[]> => {
      if (path === "src/missing.ts") return [];
      if (path === "src/a.ts") return ["node-a-1", "node-a-2"];
      return ["node-b"];
    };

    const { mapped, unmapped } = await mapFileChangesToNodes(changes, findFileNodeIds);

    // src/a.ts maps to 2 nodes, src/b.ts maps to 1 node, src/missing.ts is unmapped
    expect(mapped).toHaveLength(3);
    expect(mapped[0].nodeId).toBe("node-a-1");
    expect(mapped[1].nodeId).toBe("node-a-2");
    expect(mapped[2].nodeId).toBe("node-b");

    expect(unmapped).toHaveLength(1);
    expect(unmapped[0].filePath).toBe("src/missing.ts");
  });
});
