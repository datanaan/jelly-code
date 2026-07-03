import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";
import { detectRenames, buildRenameChains } from "../../src/temporal/rename-detector.js";

const mockedExecSync = vi.mocked(execSync);

describe("detectRenames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should detect renames from git log summary", () => {
    const gitOutput = [
      '"abc123|2026-01-15T10:00:00+08:00"',
      " rename old/path.ts => new/path.ts (100%)",
      "",
      '"def456|2026-01-16T11:00:00+08:00"',
      " rename src/a.ts => src/b.ts (95%)",
    ].join("\n");

    mockedExecSync.mockReturnValue(gitOutput);

    const renames = detectRenames("/tmp/repo");
    expect(renames).toHaveLength(2);
    expect(renames[0].oldPath).toBe("old/path.ts");
    expect(renames[0].newPath).toBe("new/path.ts");
    expect(renames[0].commitHash).toBe("abc123");
    expect(renames[1].oldPath).toBe("src/a.ts");
    expect(renames[1].newPath).toBe("src/b.ts");
  });

  it("should build rename chains (A->B->C)", () => {
    const renames = [
      { oldPath: "src/a.ts", newPath: "src/b.ts", commitHash: "hash1", timestamp: "2026-01-01T00:00:00Z" },
      { oldPath: "src/b.ts", newPath: "src/c.ts", commitHash: "hash2", timestamp: "2026-01-02T00:00:00Z" },
    ];

    const chains = buildRenameChains(renames);

    // Terminal is src/c.ts, chain should be [a->b, b->c]
    expect(chains.has("src/c.ts")).toBe(true);
    const chain = chains.get("src/c.ts")!;
    expect(chain).toHaveLength(2);
    expect(chain[0].oldPath).toBe("src/a.ts");
    expect(chain[0].newPath).toBe("src/b.ts");
    expect(chain[1].oldPath).toBe("src/b.ts");
    expect(chain[1].newPath).toBe("src/c.ts");
  });

  it("should return empty array when no renames found", () => {
    mockedExecSync.mockReturnValue("");

    const renames = detectRenames("/tmp/repo");
    expect(renames).toEqual([]);

    const chains = buildRenameChains([]);
    expect(chains.size).toBe(0);
  });
});
