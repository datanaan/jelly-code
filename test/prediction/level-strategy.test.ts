import { describe, it, expect, vi, beforeEach } from "vitest";
import { determineAnalysisLevel } from "../../src/prediction/level-strategy.js";
import { AnalysisLevel } from "../../src/prediction/types.js";

// Mock child_process to control execSync behavior
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "child_process";

describe("determineAnalysisLevel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return L2_FULL for small repos (< 50K files)", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("  12345\n");

    const decision = await determineAnalysisLevel("/some/repo");

    expect(decision.level).toBe(AnalysisLevel.L2_FULL);
    expect(decision.estimatedFiles).toBe(12345);
    expect(decision.reason).toContain("12345 files");
    expect(decision.reason).toContain("L2_FULL");
  });

  it("should return L0_GIT_LOG for large repos (>= 50K files)", async () => {
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("  75000\n");

    const decision = await determineAnalysisLevel("/mega/repo");

    expect(decision.level).toBe(AnalysisLevel.L0_GIT_LOG);
    expect(decision.estimatedFiles).toBe(75000);
    expect(decision.reason).toContain("75000 files");
    expect(decision.reason).toContain("L0_GIT_LOG");
  });

  it("should respect forceLevel override", async () => {
    // Even if repo is huge, forceLevel wins
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue("  100000\n");

    const decision = await determineAnalysisLevel("/mega/repo", {
      forceLevel: AnalysisLevel.L2_FULL,
    });

    expect(decision.level).toBe(AnalysisLevel.L2_FULL);
    expect(decision.estimatedFiles).toBe(-1);
    expect(decision.reason).toContain("User-forced");
    // Should NOT call execSync when forceLevel is set
    expect(execSync).not.toHaveBeenCalled();
  });

  it("should fall back to find command when not a git repo", async () => {
    // First call (git ls-files) fails, second call (find) succeeds
    (execSync as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => {
        throw new Error("not a git repository");
      })
      .mockImplementationOnce(() => "  500\n");

    const decision = await determineAnalysisLevel("/not/git/dir");

    expect(decision.level).toBe(AnalysisLevel.L2_FULL);
    expect(decision.estimatedFiles).toBe(500);
    expect(execSync).toHaveBeenCalledTimes(2);
    // Second call should be the find fallback
    expect((execSync as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain(
      "find",
    );
  });
});
