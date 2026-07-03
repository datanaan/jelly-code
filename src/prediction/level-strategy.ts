/**
 * Analysis level strategy — determines whether to perform full AST analysis
 * or lightweight git-log-only analysis based on repository size.
 *
 * Mega repos (50K+ files) get L0_GIT_LOG to keep analysis time under seconds.
 * Normal repos get L2_FULL for complete AST + git + embeddings.
 *
 * User can override with forceLevel parameter.
 */

import { execSync } from "child_process";
import { AnalysisLevel } from "./types.js";

export interface LevelDecision {
  level: AnalysisLevel;
  estimatedFiles: number;
  reason: string;
}

const DEFAULT_FILE_COUNT_THRESHOLD = 50_000;

/**
 * Determine analysis level based on repository file count.
 *
 * - < threshold files → L2_FULL (complete AST + git + embeddings)
 * - >= threshold files → L0_GIT_LOG (git log statistics only)
 *
 * User can override with forceLevel parameter.
 */
export async function determineAnalysisLevel(
  repoPath: string,
  options?: { forceLevel?: AnalysisLevel; fileCountThreshold?: number; cachedFileCount?: number },
): Promise<LevelDecision> {
  // Step 1: If forceLevel provided, return that level immediately
  if (options?.forceLevel !== undefined) {
    return {
      level: options.forceLevel,
      estimatedFiles: -1,
      reason: `User-forced level: ${options.forceLevel}`,
    };
  }

  // Step 2: Estimate file count (use cached if available, avoids execSync)
  const threshold = options?.fileCountThreshold ?? DEFAULT_FILE_COUNT_THRESHOLD;
  const fileCount = options?.cachedFileCount && options.cachedFileCount > 0
    ? options.cachedFileCount
    : estimateFileCount(repoPath);

  // Step 3: Determine level based on threshold
  if (fileCount >= threshold) {
    return {
      level: AnalysisLevel.L0_GIT_LOG,
      estimatedFiles: fileCount,
      reason: `${fileCount} files >= ${threshold} threshold — using L0_GIT_LOG for performance`,
    };
  }

  return {
    level: AnalysisLevel.L2_FULL,
    estimatedFiles: fileCount,
    reason: `${fileCount} files < ${threshold} threshold — using L2_FULL for complete analysis`,
  };
}

/**
 * Estimate file count in a repository.
 *
 * Strategy:
 * 1. Try `git ls-files | wc -l` (fast, git-aware, respects .gitignore)
 * 2. If not a git repo, fall back to `find` excluding node_modules and .git
 */
function estimateFileCount(repoPath: string): number {
  // Try git ls-files first (fast and git-aware)
  try {
    const result = execSync("git ls-files | wc -l", {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
    });
    const count = parseInt(result.trim(), 10);
    if (!isNaN(count)) {
      return count;
    }
  } catch {
    // Not a git repo or git command failed — fall through to find
  }

  // Fall back to find command
  try {
    const result = execSync(
      "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l",
      {
        cwd: repoPath,
        encoding: "utf-8",
        timeout: 60_000,
      },
    );
    const count = parseInt(result.trim(), 10);
    if (!isNaN(count)) {
      return count;
    }
  } catch {
    // Both methods failed
  }

  // If we can't determine, assume small (safe default: L2_FULL)
  return 0;
}
