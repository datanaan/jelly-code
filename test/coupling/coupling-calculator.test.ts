import { describe, it, expect } from "vitest";
import {
  calculateCouplingMetrics,
  filterNoisyCouplings,
  getTopNCouplings,
} from "../../src/coupling/coupling-calculator.js";
import type { CoOccurrencePair, CouplingMetrics } from "../../src/coupling/types.js";

describe("calculateCouplingMetrics", () => {
  it("should calculate basic metrics (support, confidence, lift)", () => {
    const pairs: CoOccurrencePair[] = [
      { nodeA: "node-a", nodeB: "node-b", coChangeCount: 5 },
    ];
    const commitsTouchingNode = new Map([
      ["node-a", 10],
      ["node-b", 20],
    ]);
    const totalCommits = 100;

    const metrics = calculateCouplingMetrics(pairs, commitsTouchingNode, totalCommits);

    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m.coChangeCount).toBe(5);
    expect(m.support).toBe(0.05);              // 5/100
    expect(m.confidenceAtoB).toBe(0.5);        // 5/10
    expect(m.confidenceBtoA).toBe(0.25);       // 5/20
    // lift = 0.05 / (0.1 * 0.2) = 0.05 / 0.02 = 2.5
    expect(m.lift).toBeCloseTo(2.5, 10);
  });

  it("should return empty array when totalCommits is zero", () => {
    const pairs: CoOccurrencePair[] = [
      { nodeA: "node-a", nodeB: "node-b", coChangeCount: 1 },
    ];
    const commitsTouchingNode = new Map([["node-a", 1]]);

    const metrics = calculateCouplingMetrics(pairs, commitsTouchingNode, 0);
    expect(metrics).toHaveLength(0);
  });
});

describe("filterNoisyCouplings", () => {
  it("should filter with default thresholds", () => {
    // This pair passes all default thresholds: support >= 0.01, count >= 2, lift > 1.0
    const passing: CouplingMetrics = {
      nodeA: "a",
      nodeB: "b",
      coChangeCount: 5,
      support: 0.1,
      confidenceAtoB: 0.5,
      confidenceBtoA: 0.3,
      lift: 2.0,
    };

    // This pair now passes with relaxed thresholds (support 0.01 >= 0.01, lift 2.0 > 1.0)
    const mediumSupport: CouplingMetrics = {
      nodeA: "c",
      nodeB: "d",
      coChangeCount: 3,
      support: 0.01,
      confidenceAtoB: 0.4,
      confidenceBtoA: 0.2,
      lift: 2.0,
    };

    // This pair fails count threshold (1 < 2)
    const lowCount: CouplingMetrics = {
      nodeA: "e",
      nodeB: "f",
      coChangeCount: 1,
      support: 0.1,
      confidenceAtoB: 0.5,
      confidenceBtoA: 0.3,
      lift: 2.0,
    };

    // This pair fails lift threshold (1.0 is NOT > 1.0, need strictly greater)
    const lowLift: CouplingMetrics = {
      nodeA: "g",
      nodeB: "h",
      coChangeCount: 5,
      support: 0.1,
      confidenceAtoB: 0.5,
      confidenceBtoA: 0.3,
      lift: 1.0,
    };

    // This pair fails support threshold (0.005 < 0.01)
    const veryLowSupport: CouplingMetrics = {
      nodeA: "i",
      nodeB: "j",
      coChangeCount: 3,
      support: 0.005,
      confidenceAtoB: 0.4,
      confidenceBtoA: 0.2,
      lift: 2.0,
    };

    const result = filterNoisyCouplings([passing, mediumSupport, lowCount, lowLift, veryLowSupport]);
    expect(result).toHaveLength(2);
    expect(result[0].nodeA).toBe("a");
    expect(result[1].nodeA).toBe("c");
  });

  it("should filter with custom thresholds", () => {
    const metrics: CouplingMetrics[] = [
      {
        nodeA: "a",
        nodeB: "b",
        coChangeCount: 3,
        support: 0.03,
        confidenceAtoB: 0.5,
        confidenceBtoA: 0.3,
        lift: 1.2,
      },
    ];

    // Default thresholds pass this (support 0.03 >= 0.01, lift 1.2 > 1.0)
    expect(filterNoisyCouplings(metrics)).toHaveLength(1);

    // Strict thresholds should reject
    const result = filterNoisyCouplings(metrics, {
      minSupport: 0.05,
      minLift: 1.5,
    });
    expect(result).toHaveLength(0);
  });
});

describe("getTopNCouplings", () => {
  it("should return exactly N results", () => {
    const metrics: CouplingMetrics[] = [
      { nodeA: "a", nodeB: "b", coChangeCount: 5, support: 0.05, confidenceAtoB: 0.5, confidenceBtoA: 0.3, lift: 2.0 },
      { nodeA: "c", nodeB: "d", coChangeCount: 3, support: 0.03, confidenceAtoB: 0.8, confidenceBtoA: 0.4, lift: 1.5 },
      { nodeA: "e", nodeB: "f", coChangeCount: 1, support: 0.01, confidenceAtoB: 0.2, confidenceBtoA: 0.1, lift: 1.0 },
    ];

    const top2 = getTopNCouplings(metrics, 2);
    expect(top2).toHaveLength(2);
    // Sorted by confidenceAtoB descending: c:d (0.8), a:b (0.5)
    expect(top2[0].nodeA).toBe("c");
    expect(top2[1].nodeA).toBe("a");
  });

  it("should return fewer results when less than N available", () => {
    const metrics: CouplingMetrics[] = [
      { nodeA: "a", nodeB: "b", coChangeCount: 5, support: 0.05, confidenceAtoB: 0.5, confidenceBtoA: 0.3, lift: 2.0 },
    ];

    const top5 = getTopNCouplings(metrics, 5);
    expect(top5).toHaveLength(1);
    expect(top5[0].nodeA).toBe("a");
  });

  it("should handle lift calculation with zero support denominator", () => {
    const pairs: CoOccurrencePair[] = [
      { nodeA: "a", nodeB: "b", coChangeCount: 3 },
    ];
    // Node "b" has zero commits touching it → supportB = 0
    const commitsTouchingNode = new Map([
      ["a", 10],
      // "b" intentionally missing → 0
    ]);
    const totalCommits = 100;

    const metrics = calculateCouplingMetrics(pairs, commitsTouchingNode, totalCommits);
    expect(metrics).toHaveLength(1);
    // supportB = 0/100 = 0, denominator = supportA * supportB = 0.1 * 0 = 0
    // lift should be 0 (not NaN or Infinity)
    expect(metrics[0].lift).toBe(0);
    expect(metrics[0].confidenceBtoA).toBe(0);
  });

  it("should demonstrate confidence is directional (A->B != B->A)", () => {
    const pairs: CoOccurrencePair[] = [
      { nodeA: "a", nodeB: "b", coChangeCount: 5 },
    ];
    // node-a touched in 10 commits, node-b touched in 50 commits
    const commitsTouchingNode = new Map([
      ["a", 10],
      ["b", 50],
    ]);
    const totalCommits = 200;

    const metrics = calculateCouplingMetrics(pairs, commitsTouchingNode, totalCommits);

    expect(metrics).toHaveLength(1);
    const m = metrics[0];

    // confidenceAtoB = 5/10 = 0.5 (when a changes, b also changes 50% of the time)
    expect(m.confidenceAtoB).toBe(0.5);

    // confidenceBtoA = 5/50 = 0.1 (when b changes, a also changes 10% of the time)
    expect(m.confidenceBtoA).toBe(0.1);

    // They are not equal
    expect(m.confidenceAtoB).not.toBe(m.confidenceBtoA);
  });
});
