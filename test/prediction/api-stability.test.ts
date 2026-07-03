import { describe, it, expect, vi } from "vitest";
import { calculateApiStability } from "../../src/prediction/api-stability.js";

/**
 * Creates a mock IGraphStore with a single batch query result.
 * The new implementation uses ONE query that joins Route→handler→CHANGED_IN.
 */
function createMockGraphStore(queryResult: Record<string, unknown>[]) {
  return {
    query: vi.fn(async (
      _cypher: string,
      _params: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      return queryResult;
    }),
  } as any;
}

describe("calculateApiStability", () => {
  it("should calculate stability from batch route+change data", async () => {
    // Single batch query result: route + handler + change stats
    const graphStore = createMockGraphStore([
      {
        handlerId: "File:routes/search.ts",
        routeName: "/api/search",
        routeFile: "routes/search.ts",
        changeCount: 3,
        lastChangedAt: "2026-05-01T00:00:00Z",
        firstChangedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    const scores = await calculateApiStability("proj-1", graphStore);

    expect(scores).toHaveLength(1);
    expect(scores[0].apiPath).toBe("/api/search");
    // stability = max(0, 1 - 3 * 0.1) = 0.7
    expect(scores[0].stability).toBeCloseTo(0.7);
    expect(scores[0].changeFrequency).toBeGreaterThan(0);
    expect(scores[0].stabilityLevel).toBe("moderate");
    // Should only call query once (batch)
    expect(graphStore.query).toHaveBeenCalledTimes(1);
  });

  it("should classify stability levels correctly", async () => {
    const graphStore = createMockGraphStore([
      { handlerId: "h-stable", routeName: "/api/health", routeFile: "health.ts",
        changeCount: 1, lastChangedAt: "2026-04-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z" },
      { handlerId: "h-moderate", routeName: "/api/users", routeFile: "users.ts",
        changeCount: 3, lastChangedAt: "2026-05-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z" },
      { handlerId: "h-volatile", routeName: "/api/experimental", routeFile: "exp.ts",
        changeCount: 8, lastChangedAt: "2026-05-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z" },
    ]);

    const scores = await calculateApiStability("proj-1", graphStore);

    expect(scores).toHaveLength(3);

    const stable = scores.find((s) => s.apiPath === "/api/health")!;
    const moderate = scores.find((s) => s.apiPath === "/api/users")!;
    const volatile = scores.find((s) => s.apiPath === "/api/experimental")!;

    expect(stable.stabilityLevel).toBe("stable");
    expect(stable.stability).toBeCloseTo(0.9);

    expect(moderate.stabilityLevel).toBe("moderate");
    expect(moderate.stability).toBeCloseTo(0.7);

    expect(volatile.stabilityLevel).toBe("volatile");
    expect(volatile.stability).toBeCloseTo(0.2);
  });

  it("should return empty array when no route data exists", async () => {
    const graphStore = createMockGraphStore([]);

    const scores = await calculateApiStability("proj-1", graphStore);

    expect(scores).toHaveLength(0);
    expect(graphStore.query).toHaveBeenCalledTimes(1);
  });

  it("should assign stability 1.0 when changeCount is 0", async () => {
    const graphStore = createMockGraphStore([
      {
        handlerId: "handler-1",
        routeName: "/api/stable",
        routeFile: "stable.ts",
        changeCount: 0,
        lastChangedAt: null,
        firstChangedAt: null,
      },
    ]);

    const scores = await calculateApiStability("proj-1", graphStore);

    expect(scores).toHaveLength(1);
    expect(scores[0].stability).toBe(1.0);
    expect(scores[0].stabilityLevel).toBe("stable");
    expect(scores[0].changeFrequency).toBe(0);
  });

  it("should handle multiple handlers with different stability", async () => {
    const graphStore = createMockGraphStore([
      {
        handlerId: "h1", routeName: "/api/v1/resource", routeFile: "v1.ts",
        changeCount: 2, lastChangedAt: "2026-04-01T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
      {
        handlerId: "h2", routeName: "/api/v2/resource", routeFile: "v2.ts",
        changeCount: 6, lastChangedAt: "2026-05-15T00:00:00Z", firstChangedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    const scores = await calculateApiStability("proj-1", graphStore);

    expect(scores).toHaveLength(2);

    const v1 = scores.find((s) => s.apiPath === "/api/v1/resource")!;
    const v2 = scores.find((s) => s.apiPath === "/api/v2/resource")!;

    expect(v1.stability).toBeCloseTo(0.8);
    expect(v1.stabilityLevel).toBe("stable");
    expect(v1.lastChangedAt).toBe("2026-04-01T00:00:00Z");

    expect(v2.stability).toBeCloseTo(0.4);
    expect(v2.stabilityLevel).toBe("volatile");
    expect(v2.lastChangedAt).toBe("2026-05-15T00:00:00Z");
  });
});
