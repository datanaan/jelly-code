import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StoreSet } from "../../src/store/interfaces.js";

// Mock temporal modules so analyzeLevel0 can dynamic-import them
vi.mock("../../src/temporal/git-extractor.js", () => ({
  extractGitLog: vi.fn(),
}));

vi.mock("../../src/temporal/temporal-writer.js", () => ({
  writeCommits: vi.fn(),
  writeAuthors: vi.fn(),
}));

import { analyzeLevel0 } from "../../src/prediction/level0-analyzer.js";
import { extractGitLog } from "../../src/temporal/git-extractor.js";
import { writeCommits, writeAuthors } from "../../src/temporal/temporal-writer.js";

/**
 * Create a mock StoreSet with tracking for all graph operations.
 */
function createMockStoreSet(): {
  stores: StoreSet;
  createdNodes: any[];
  queryCalls: Array<{ cypher: string; params: Record<string, unknown> }>;
} {
  const createdNodes: any[] = [];
  const queryCalls: Array<{ cypher: string; params: Record<string, unknown> }> = [];

  const stores: StoreSet = {
    graph: {
      batchCreateNodes: vi.fn(async (nodes: any[]) => {
        createdNodes.push(...nodes);
      }),
      query: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
        queryCalls.push({ cypher, params });
        return [];
      }),
    },
    search: {} as any,
    vector: {} as any,
    llm: {} as any,
  } as any;

  return { stores, createdNodes, queryCalls };
}

describe("analyzeLevel0", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create commit and author nodes", async () => {
    const { stores } = createMockStoreSet();

    (extractGitLog as ReturnType<typeof vi.fn>).mockReturnValue({
      commits: [
        {
          hash: "abc123",
          message: "initial commit",
          author: "Alice",
          authorEmail: "alice@example.com",
          timestamp: "2026-01-15T10:00:00Z",
          additions: 100,
          deletions: 0,
          isMerge: false,
          changedFiles: [
            { filePath: "src/main.ts", changeType: "added" },
          ],
        },
        {
          hash: "def456",
          message: "fix bug",
          author: "Bob",
          authorEmail: "bob@example.com",
          timestamp: "2026-02-20T14:30:00Z",
          additions: 10,
          deletions: 5,
          isMerge: false,
          changedFiles: [
            { filePath: "src/util.ts", changeType: "modified" },
          ],
        },
      ],
      isGitRepo: true,
    });

    const result = await analyzeLevel0("/repo", "project-1", stores);

    // Should call writeCommits with the 2 commits
    expect(writeCommits).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ hash: "abc123" }),
        expect.objectContaining({ hash: "def456" }),
      ]),
      "project-1",
      stores.graph,
    );

    // Should call writeAuthors with the 2 authors
    expect(writeAuthors).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ email: "alice@example.com", commitCount: 1 }),
        expect.objectContaining({ email: "bob@example.com", commitCount: 1 }),
      ]),
      stores.graph,
    );

    expect(result.commitCount).toBe(2);
    expect(result.authorCount).toBe(2);
  });

  it("should create file-level CHANGED_IN relations", async () => {
    const { stores, queryCalls } = createMockStoreSet();

    (extractGitLog as ReturnType<typeof vi.fn>).mockReturnValue({
      commits: [
        {
          hash: "abc123",
          message: "add feature",
          author: "Alice",
          authorEmail: "alice@example.com",
          timestamp: "2026-01-15T10:00:00Z",
          additions: 50,
          deletions: 0,
          isMerge: false,
          changedFiles: [
            { filePath: "src/foo.ts", changeType: "added" },
            { filePath: "src/bar.ts", changeType: "added" },
          ],
        },
      ],
      isGitRepo: true,
    });

    await analyzeLevel0("/repo", "project-1", stores);

    // Should have CHANGED_IN queries
    const changedInQueries = queryCalls.filter(
      (q) => q.cypher.includes("CHANGED_IN"),
    );
    expect(changedInQueries.length).toBeGreaterThan(0);

    // The CHANGED_IN rows should contain our file paths
    const changedInQuery = changedInQueries[0];
    const rows = changedInQuery.params.rows as any[];
    const sourceIds = rows.map((r: any) => r.sourceId);
    expect(sourceIds).toContain("src/foo.ts");
    expect(sourceIds).toContain("src/bar.ts");
  });

  it("should create file-level CO_CHANGED_WITH relations", async () => {
    const { stores, queryCalls } = createMockStoreSet();

    // Two commits that both touch foo.ts and bar.ts — co-occurrence pair
    (extractGitLog as ReturnType<typeof vi.fn>).mockReturnValue({
      commits: [
        {
          hash: "commit1",
          message: "first",
          author: "Alice",
          authorEmail: "alice@example.com",
          timestamp: "2026-01-15T10:00:00Z",
          additions: 10,
          deletions: 0,
          isMerge: false,
          changedFiles: [
            { filePath: "src/foo.ts", changeType: "added" },
            { filePath: "src/bar.ts", changeType: "added" },
          ],
        },
        {
          hash: "commit2",
          message: "second",
          author: "Alice",
          authorEmail: "alice@example.com",
          timestamp: "2026-02-15T10:00:00Z",
          additions: 5,
          deletions: 2,
          isMerge: false,
          changedFiles: [
            { filePath: "src/foo.ts", changeType: "modified" },
            { filePath: "src/bar.ts", changeType: "modified" },
          ],
        },
      ],
      isGitRepo: true,
    });

    const result = await analyzeLevel0("/repo", "project-1", stores);

    // Should have CO_CHANGED_WITH queries
    const coChangedQueries = queryCalls.filter(
      (q) => q.cypher.includes("CO_CHANGED_WITH"),
    );
    expect(coChangedQueries.length).toBeGreaterThan(0);

    // Should have exactly 1 coupling pair (foo.ts <-> bar.ts)
    expect(result.couplingPairs).toBe(1);

    // The coupling pair should have correct metrics
    const rows = coChangedQueries[0].params.rows as any[];
    expect(rows[0].coChangeCount).toBe(2); // co-occurred in 2 commits
    expect(rows[0].support).toBeCloseTo(1.0); // 2 co-changes / 2 total commits = 1.0
  });

  it("should return correct counts", async () => {
    const { stores } = createMockStoreSet();

    (extractGitLog as ReturnType<typeof vi.fn>).mockReturnValue({
      commits: [
        {
          hash: "c1",
          message: "commit 1",
          author: "Alice",
          authorEmail: "alice@ex.com",
          timestamp: "2026-01-10T10:00:00Z",
          additions: 10,
          deletions: 0,
          isMerge: false,
          changedFiles: [
            { filePath: "a.ts", changeType: "added" },
            { filePath: "b.ts", changeType: "added" },
            { filePath: "c.ts", changeType: "added" },
          ],
        },
        {
          hash: "c2",
          message: "commit 2",
          author: "Bob",
          authorEmail: "bob@ex.com",
          timestamp: "2026-02-10T10:00:00Z",
          additions: 5,
          deletions: 3,
          isMerge: false,
          changedFiles: [
            { filePath: "a.ts", changeType: "modified" },
            { filePath: "d.ts", changeType: "added" },
          ],
        },
      ],
      isGitRepo: true,
    });

    const result = await analyzeLevel0("/repo", "p1", stores);

    // 2 commits
    expect(result.commitCount).toBe(2);
    // 2 authors (Alice + Bob)
    expect(result.authorCount).toBe(2);
    // 4 unique files (a.ts, b.ts, c.ts, d.ts)
    expect(result.fileCount).toBe(4);
    // Co-occurrence pairs:
    //   c1: {a,b,c} -> pairs: a:b, a:c, b:c (3 pairs)
    //   c2: {a,d}   -> pairs: a:d (1 pair)
    //   total unique pairs = 4
    expect(result.couplingPairs).toBe(4);
  });
});
