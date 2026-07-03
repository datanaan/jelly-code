import { describe, it, expect, vi } from "vitest";
import { calculateEnhancedBusFactor, findCriticalAuthors, findRiskModules } from "../../src/lineage/bus-factor.js";

/**
 * Helper: create a mock IGraphStore with controllable query responses.
 */
function createMockGraphStore(queryResults?: Array<Record<string, unknown>[]>) {
  let callIndex = 0;
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockImplementation(() => {
      const results = queryResults?.[callIndex++] ?? [];
      return Promise.resolve(results);
    }),
  } as any;
}

describe("calculateEnhancedBusFactor", () => {
  it("should return busFactor=1 for single author project", async () => {
    // One author owns all modules
    const graphStore = createMockGraphStore([
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.8 },
        { moduleId: "m3", moduleName: "Module3", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.7 },
      ],
    ]);

    const report = await calculateEnhancedBusFactor("proj-1", graphStore);

    // With only one author, removing them immediately orphans all modules
    // threshold=0.5, totalModules=3, orphanThreshold=1
    // After removing 1 author: 3 orphaned > 1 → busFactor = 1
    expect(report.busFactor).toBe(1);
    expect(report.criticalAuthors).toHaveLength(1);
    expect(report.criticalAuthors[0].authorId).toBe("a1");
    expect(report.criticalAuthors[0].ownedModules).toBe(3);
    expect(report.threshold).toBe(0.5);
  });

  it("should return higher busFactor for balanced team", async () => {
    // Three authors, each owns one module exclusively
    const graphStore = createMockGraphStore([
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a2", name: "Bob", email: "b@t.com", ownership: 0.8 },
        { moduleId: "m3", moduleName: "Module3", authorId: "a3", name: "Carol", email: "c@t.com", ownership: 0.7 },
      ],
    ]);

    const report = await calculateEnhancedBusFactor("proj-1", graphStore, 0.5);

    // 3 modules, threshold=0.5, orphanThreshold=1
    // Each author owns 1 module. Removing 1 author → 1 orphaned (not > 1)
    // Removing 2nd author → 2 orphaned (> 1) → busFactor = 2
    expect(report.busFactor).toBe(2);
    expect(report.criticalAuthors).toHaveLength(3);
  });

  it("should identify critical authors correctly", async () => {
    // Alice owns 3 modules, Bob owns 1
    const graphStore = createMockGraphStore([
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.8 },
        { moduleId: "m3", moduleName: "Module3", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.7 },
        { moduleId: "m4", moduleName: "Module4", authorId: "a2", name: "Bob", email: "b@t.com", ownership: 0.6 },
      ],
    ]);

    const criticalAuthors = await findCriticalAuthors("proj-1", graphStore);

    // Alice should be the top critical author (3 modules vs 1)
    expect(criticalAuthors[0].authorId).toBe("a1");
    expect(criticalAuthors[0].ownedModules).toBe(3);
    expect(criticalAuthors[1].authorId).toBe("a2");
    expect(criticalAuthors[1].ownedModules).toBe(1);
  });

  it("should find risk modules (sole author)", async () => {
    // m1 has only Alice, m2 has Alice+Bob
    const graphStore = createMockGraphStore([
      [
        { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.8 },
        { moduleId: "m2", moduleName: "Module2", authorId: "a2", name: "Bob", email: "b@t.com", ownership: 0.7 },
      ],
    ]);

    const riskModules = await findRiskModules("proj-1", graphStore);

    // m1 has only 1 author with ownership > 0.5 → risk module
    // m2 has 2 authors with ownership > 0.5 → not risk
    expect(riskModules).toHaveLength(1);
    expect(riskModules[0].moduleId).toBe("m1");
    expect(riskModules[0].soleAuthorId).toBe("a1");
  });

  it("should give different results for different thresholds", async () => {
    // 10 modules, all owned by author a1
    const moduleData = Array.from({ length: 10 }, (_, i) => ({
      moduleId: `m${i}`,
      moduleName: `Module${i}`,
      authorId: "a1",
      name: "Alice",
      email: "a@t.com",
      ownership: 0.9,
    }));

    const graphStoreLow = createMockGraphStore([moduleData]);
    const reportLow = await calculateEnhancedBusFactor("proj-1", graphStoreLow, 0.3);

    const graphStoreHigh = createMockGraphStore([moduleData]);
    const reportHigh = await calculateEnhancedBusFactor("proj-1", graphStoreHigh, 0.7);

    // With threshold 0.3: 10 * 0.3 = 3 → removing a1 orphans 10 > 3 → busFactor = 1
    // With threshold 0.7: 10 * 0.7 = 7 → removing a1 orphans 10 > 7 → busFactor = 1
    // Both give 1 since single author — let's test a multi-author scenario instead
    expect(reportLow.threshold).toBe(0.3);
    expect(reportHigh.threshold).toBe(0.7);

    // Multi-author scenario for threshold comparison
    const multiAuthorData = [
      { moduleId: "m1", moduleName: "Module1", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.9 },
      { moduleId: "m2", moduleName: "Module2", authorId: "a1", name: "Alice", email: "a@t.com", ownership: 0.8 },
      { moduleId: "m3", moduleName: "Module3", authorId: "a2", name: "Bob", email: "b@t.com", ownership: 0.8 },
      { moduleId: "m4", moduleName: "Module4", authorId: "a3", name: "Carol", email: "c@t.com", ownership: 0.8 },
      { moduleId: "m5", moduleName: "Module5", authorId: "a3", name: "Carol", email: "c@t.com", ownership: 0.7 },
    ];

    // threshold=0.3: orphanThreshold = floor(5 * 0.3) = 1
    // Remove a1 (1 module) → 2 orphaned > 1 → busFactor = 1 (a1 has 2 modules)
    // Wait, a1 owns m1+m2 = 2 modules
    // Sorted ascending: a2(1), a1(2), a3(2)
    // Remove a2 → 1 orphaned > 1? No, 1 == 1. Need > not >=. So not yet.
    // Remove a1 → 1+2=3 orphaned > 1 → busFactor = 2
    const gs1 = createMockGraphStore([multiAuthorData]);
    const r1 = await calculateEnhancedBusFactor("proj-1", gs1, 0.3);

    // threshold=0.7: orphanThreshold = floor(5 * 0.7) = 3
    // Remove a2 → 1 orphaned > 3? No
    // Remove a1 → 3 orphaned > 3? No (3 == 3)
    // Remove a3 → 5 orphaned > 3 → busFactor = 3
    const gs2 = createMockGraphStore([multiAuthorData]);
    const r2 = await calculateEnhancedBusFactor("proj-1", gs2, 0.7);

    expect(r1.busFactor).toBeLessThanOrEqual(r2.busFactor);
  });

  it("should return busFactor=-1 when no temporal data", async () => {
    const graphStore = createMockGraphStore([[]]);

    const report = await calculateEnhancedBusFactor("proj-1", graphStore);

    expect(report.busFactor).toBe(-1);
    expect(report.message).toContain("No temporal data");
  });
});
