import { describe, it, expect, vi } from "vitest";
import {
  buildOwnership,
  findExpert,
  calculateBusFactor,
} from "../../src/coupling/ownership-builder.js";

function createMockGraphStore(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  } as any;
}

describe("buildOwnership", () => {
  it("should build ownership from mock AUTHORED_BY data", async () => {
    const graphStore = createMockGraphStore([
      [
        { nodeId: "file-a.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.8, lastChangeAt: "2026-04-01" },
        { nodeId: "file-a.ts", authorId: "bob@test.com", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 2, ownership: 0.2, lastChangeAt: "2026-03-01" },
        { nodeId: "file-b.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 5, ownership: 1.0, lastChangeAt: "2026-04-15" },
      ],
    ]);

    const result = await buildOwnership("proj-1", graphStore);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);

    const fileA = result.get("file-a.ts")!;
    expect(fileA).toHaveLength(2);
    expect(fileA[0].authorId).toBe("alice@test.com");
    expect(fileA[0].ownership).toBe(0.8);
    expect(fileA[1].authorId).toBe("bob@test.com");

    const fileB = result.get("file-b.ts")!;
    expect(fileB).toHaveLength(1);
    expect(fileB[0].ownership).toBe(1.0);
  });
});

describe("findExpert", () => {
  it("should return top owner for a node", async () => {
    const graphStore = createMockGraphStore([
      [
        { authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.8, lastChangeAt: "2026-04-01" },
      ],
    ]);

    const expert = await findExpert("proj-1", "file-a.ts", graphStore);

    expect(expert).not.toBeNull();
    expect(expert!.authorId).toBe("alice@test.com");
    expect(expert!.ownership).toBe(0.8);

    // Verify query used correct params
    const call = graphStore.query.mock.calls[0];
    expect(call[1]).toEqual({ projectId: "proj-1", nodeId: "file-a.ts" });
  });

  it("should return null when no ownership data exists", async () => {
    const graphStore = createMockGraphStore([[]]);

    const expert = await findExpert("proj-1", "nonexistent.ts", graphStore);

    expect(expert).toBeNull();
  });
});

describe("calculateBusFactor", () => {
  it("should return busFactor=1 for single-author project", async () => {
    // All modules owned by single author Alice
    const graphStore = createMockGraphStore([
      [
        { nodeId: "file-a.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 1.0, lastChangeAt: "2026-04-01" },
        { nodeId: "file-b.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 8, ownership: 1.0, lastChangeAt: "2026-04-10" },
        { nodeId: "file-c.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 5, ownership: 1.0, lastChangeAt: "2026-04-15" },
      ],
    ]);

    const result = await calculateBusFactor("proj-1", graphStore);

    // Alice owns all 3 modules. Removing her orphans all 3.
    // threshold=0.5 → orphanThreshold = floor(3 * 0.5) = 1
    // After removing Alice: 3 orphaned > 1 → busFactor = 1
    expect(result.busFactor).toBe(1);
    expect(result.criticalAuthors).toHaveLength(1);
    expect(result.criticalAuthors[0].authorId).toBe("alice@test.com");
    expect(result.criticalAuthors[0].ownedModules).toBe(3);
  });

  it("should return higher bus factor for balanced team", async () => {
    const graphStore = createMockGraphStore([
      [
        // 4 modules, 2 authors each owning 2
        { nodeId: "file-a.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 10, ownership: 0.9, lastChangeAt: "2026-04-01" },
        { nodeId: "file-b.ts", authorId: "alice@test.com", authorName: "Alice", authorEmail: "alice@test.com", changeCount: 8, ownership: 0.9, lastChangeAt: "2026-04-10" },
        { nodeId: "file-c.ts", authorId: "bob@test.com", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 7, ownership: 0.9, lastChangeAt: "2026-04-05" },
        { nodeId: "file-d.ts", authorId: "bob@test.com", authorName: "Bob", authorEmail: "bob@test.com", changeCount: 6, ownership: 0.9, lastChangeAt: "2026-04-12" },
      ],
    ]);

    const result = await calculateBusFactor("proj-1", graphStore, 0.5);

    // 4 modules, threshold=0.5 → orphanThreshold = floor(4*0.5) = 2
    // Authors sorted by modules: Alice(2), Bob(2) (or Bob(2), Alice(2))
    // Remove first author: 2 orphaned. 2 > 2? No. Remove second: 4 orphaned > 2 → busFactor = 2
    expect(result.busFactor).toBe(2);
    expect(result.criticalAuthors).toHaveLength(2);
  });

  it("should return busFactor=0 for empty project", async () => {
    const graphStore = createMockGraphStore([[]]);

    const result = await calculateBusFactor("empty-proj", graphStore);

    expect(result.busFactor).toBe(0);
    expect(result.criticalAuthors).toHaveLength(0);
  });
});
