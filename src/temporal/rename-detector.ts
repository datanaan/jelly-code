/**
 * Detect file renames and build rename chains from git history.
 *
 * Uses `git log --diff-filter=R --summary --format=...` to find rename events,
 * then constructs complete rename chains (A->B->C).
 */

import { execSync } from "child_process";
import type { RenameInfo } from "./types.js";

/**
 * Detect file renames in the repository history.
 *
 * @param repoPath - Absolute path to the git repository
 * @param since - Optional date or commit hash to start from
 * @returns Array of RenameInfo entries
 */
export function detectRenames(
  repoPath: string,
  since?: string,
): RenameInfo[] {
  const args: string[] = [
    "git",
    "-C",
    repoPath,
    "log",
    "--diff-filter=R",
    "--summary",
    '--format="%H|%aI"',
  ];

  if (since) {
    if (/^[0-9a-f]{7,}$/i.test(since)) {
      args.push(`${since}..HEAD`);
    } else {
      args.push(`--since=${since}`);
    }
  }

  try {
    const raw = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: 300000, // 5 minutes
      maxBuffer: 100 * 1024 * 1024,
    });
    return parseRenameOutput(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("not a git repository") ||
      message.includes("does not have any commits")
    ) {
      return [];
    }
    throw err;
  }
}

/**
 * Parse the combined --summary + --format output to extract renames.
 *
 * Format blocks look like:
 *   "abc123|2026-01-15T10:00:00+08:00"
 *    rename old_path => new_path (NN%)
 *    (blank line)
 */
function parseRenameOutput(raw: string): RenameInfo[] {
  const renames: RenameInfo[] = [];
  if (!raw || !raw.trim()) return renames;

  const normalized = raw.replace(/\r\n/g, "\n");
  // Split into blocks at format header lines
  const blocks = normalized.split(/\n(?=")/);

  let currentHash = "";
  let currentTimestamp = "";

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    for (const line of lines) {
      // Header line: "hash|timestamp"
      if (line.startsWith('"') && line.includes("|")) {
        const cleaned = line.replace(/"/g, "");
        const pipeIdx = cleaned.indexOf("|");
        if (pipeIdx > 0) {
          currentHash = cleaned.slice(0, pipeIdx);
          currentTimestamp = cleaned.slice(pipeIdx + 1);
        }
        continue;
      }

      // Rename line: " rename old/path => new/path (NN%)"
      const renameMatch = line.match(
        /rename\s+(.+?)\s+=>\s+(.+?)(?:\s+\(\d+%\))?$/,
      );
      if (renameMatch && currentHash) {
        renames.push({
          oldPath: renameMatch[1].trim(),
          newPath: renameMatch[2].trim(),
          commitHash: currentHash,
          timestamp: currentTimestamp,
        });
      }
    }
  }

  return renames;
}

/**
 * Build rename chains from a list of rename events.
 *
 * Given renames like A->B, B->C, produces a map from the current path (C)
 * to the full history [A->B, B->C].
 *
 * @returns Map from current file path to its full rename history
 */
export function buildRenameChains(
  renames: RenameInfo[],
): Map<string, RenameInfo[]> {
  const chains = new Map<string, RenameInfo[]>();

  if (renames.length === 0) return chains;

  // Build forward map: oldPath -> RenameInfo
  const forwardMap = new Map<string, RenameInfo>();
  // Build reverse map: newPath -> RenameInfo
  const reverseMap = new Map<string, RenameInfo>();

  for (const r of renames) {
    forwardMap.set(r.oldPath, r);
    reverseMap.set(r.newPath, r);
  }

  // Find all "terminal" paths (newPath that is never an oldPath in another rename)
  const isOldPath = new Set(renames.map((r) => r.oldPath));
  const terminals = renames.filter((r) => !isOldPath.has(r.newPath));

  // For each terminal, walk backwards to build the full chain
  for (const terminal of terminals) {
    const chain: RenameInfo[] = [];
    let current: RenameInfo | undefined = terminal;

    while (current) {
      chain.unshift(current); // add to front
      current = reverseMap.get(current.oldPath);
    }

    // Map from the final path to the full chain
    chains.set(terminal.newPath, chain);
  }

  // Also include renames where newPath IS an oldPath (intermediate nodes)
  // These are reachable via the chain already, but we add entries for completeness
  for (const rename of renames) {
    if (!chains.has(rename.newPath)) {
      // This is an intermediate node — find which terminal chain contains it
      for (const [terminalPath, chain] of chains) {
        const idx = chain.findIndex(
          (r) => r.newPath === rename.newPath,
        );
        if (idx >= 0) {
          // Already covered by the terminal chain
          break;
        }
      }
    }
  }

  return chains;
}
