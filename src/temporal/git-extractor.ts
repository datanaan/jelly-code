/**
 * Extract git log data from a repository.
 *
 * Uses `git log --name-status --format=...` to produce raw output,
 * then delegates parsing to commit-parser.
 */

import { execSync } from "child_process";
import type { CommitData, GitExtractOptions } from "./types.js";
import { parseGitLogOutput } from "./commit-parser.js";

const DEFAULT_MAX_COMMITS = 10000;
const GIT_TIMEOUT_MS = 300000; // 5 minutes

/**
 * Extract commit history from a git repository.
 *
 * @returns Object with commits array and isGitRepo flag.
 *          If the path is not a git repo, returns empty commits and isGitRepo: false.
 */
export function extractGitLog(
  repoPath: string,
  options?: GitExtractOptions,
): { commits: CommitData[]; isGitRepo: boolean } {
  const maxCommits = options?.maxCommits ?? DEFAULT_MAX_COMMITS;
  const includeMerges = options?.includeMerges ?? false;

  const args: string[] = [
    "git",
    "-C",
    repoPath,
    "log",
    `--max-count=${maxCommits}`,
    "--name-status",
    '--format="%H|%an|%ae|%aI|%s"',
  ];

  if (!includeMerges) {
    args.push("--no-merges");
  }

  // Incremental extraction
  if (options?.since) {
    // If since looks like a commit hash (hex, 7+ chars), use hash range
    if (/^[0-9a-f]{7,}$/i.test(options.since)) {
      args.push(`${options.since}..HEAD`);
    } else {
      // Treat as date
      args.push(`--since=${options.since}`);
    }
  }

  if (options?.until) {
    args.push(`--until=${options.until}`);
  }

  try {
    const raw = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 200 * 1024 * 1024, // 200MB for large repos
    });

    // Strip surrounding quotes from format output
    const cleaned = raw.replace(/^"|"$/gm, "");
    const commits = parseGitLogOutput(cleaned);
    return { commits, isGitRepo: true };
  } catch (err: unknown) {
    // Not a git repo or other error
    const errorMessage = err instanceof Error ? err.message : String(err);

    // If the error is because it's not a git repo, return gracefully
    if (
      errorMessage.includes("not a git repository") ||
      errorMessage.includes("does not appear to be a git repo")
    ) {
      return { commits: [], isGitRepo: false };
    }

    // Timeout — treat as non-fatal, return what we have
    if (errorMessage.includes("ETIMEDOUT") || errorMessage.includes("timed out")) {
      return { commits: [], isGitRepo: true };
    }

    // Empty repo — "fatal: your current branch does not have any commits yet"
    if (errorMessage.includes("does not have any commits")) {
      return { commits: [], isGitRepo: true };
    }

    // Other errors — rethrow
    throw err;
  }
}
