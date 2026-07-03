import { describe, it, expect, vi } from "vitest";
import { writeCoChangedRelations } from "../../src/coupling/coupling-writer.js";
import type { CouplingMetrics } from "../../src/coupling/types.js";

function createMockGraphStore() {
  return {
    query: vi.fn<Promise<Record<string, unknown>[]>, [string, Record<string, unknown>?]>().mockResolvedValue([]),
    batchCreateRelations: vi.fn<Promise<void>, [any[]]>().mockResolvedValue(undefined),
  } as any;
}

describe("writeCoChangedRelations", () => {
  it("should delete existing and write couplings via batchCreateRelations", async () => {
    const graphStore = createMockGraphStore();
    const couplings: CouplingMetrics[] = [
      {
        nodeA: "node-a",
        nodeB: "node-b",
        coChangeCount: 5,
        support: 0.1,
        confidenceAtoB: 0.5,
        confidenceBtoA: 0.3,
        lift: 2.0,
      },
    ];

    await writeCoChangedRelations(couplings, "proj-1", graphStore, 100);

    // First call: delete existing via query
    expect(graphStore.query).toHaveBeenCalledTimes(1);
    const deleteCall = graphStore.query.mock.calls[0];
    expect(deleteCall[0]).toContain("DELETE r");
    expect(deleteCall[1]).toEqual({ projectId: "proj-1" });

    // Second call: batchCreateRelations with Relation[]
    expect(graphStore.batchCreateRelations).toHaveBeenCalledTimes(1);
    const relations = graphStore.batchCreateRelations.mock.calls[0][0];
    // Two relations: A->B and B->A
    expect(relations).toHaveLength(2);
    expect(relations[0].sourceId).toBe("node-a");
    expect(relations[0].targetId).toBe("node-b");
    expect(relations[0].confidence).toBe(0.5);
    expect(relations[0].type).toBe("CO_CHANGED_WITH");
    expect(relations[0].projectId).toBe("proj-1");
    expect(relations[1].sourceId).toBe("node-b");
    expect(relations[1].targetId).toBe("node-a");
    expect(relations[1].confidence).toBe(0.3);
  });

  it("should delete existing CO_CHANGED_WITH before writing", async () => {
    const graphStore = createMockGraphStore();
    const couplings: CouplingMetrics[] = [
      {
        nodeA: "a",
        nodeB: "b",
        coChangeCount: 3,
        support: 0.05,
        confidenceAtoB: 0.6,
        confidenceBtoA: 0.4,
        lift: 1.8,
      },
    ];

    await writeCoChangedRelations(couplings, "proj-2", graphStore, 50);

    // Verify first call is the delete
    const firstCall = graphStore.query.mock.calls[0];
    expect(firstCall[0]).toContain("MATCH (a)-[r:CODE_RELATION {type: 'CO_CHANGED_WITH'}]->(b)");
    expect(firstCall[0]).toContain("WHERE a.projectId = $projectId");
    expect(firstCall[0]).toContain("DELETE r");
    expect(firstCall[1]).toEqual({ projectId: "proj-2" });
  });

  it("should early-return without queries when couplings array is empty", async () => {
    const graphStore = createMockGraphStore();

    await writeCoChangedRelations([], "proj-1", graphStore, 100);

    expect(graphStore.query).not.toHaveBeenCalled();
    expect(graphStore.batchCreateRelations).not.toHaveBeenCalled();
  });
});
