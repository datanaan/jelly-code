/**
 * Parse git blame porcelain output and summarize ownership.
 *
 * Uses `git blame --line-porcelain <file>` to get per-line authorship,
 * then aggregates into per-author summaries.
 */

import { execSync } from "child_process";
import type { BlameLine, BlameSummary } from "./types.js";

/**
 * Extract blame data for a single file.
 *
 * @returns BlameLine[] — empty if file doesn't exist or repo is invalid.
 */
export function extractBlame(
  repoPath: string,
  filePath: string,
): BlameLine[] {
  try {
    const raw = execSync(
      `git -C ${repoPath} blame --line-porcelain -- "${filePath}"`,
      {
        encoding: "utf-8",
        timeout: 60000, // 1 minute — blame can be slow on large files
      },
    );
    return parseBlameOutput(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // File not found, not a git repo, or other error — return empty
    if (
      message.includes("no such path") ||
      message.includes("not a git repository") ||
      message.includes("fatal:") ||
      message.includes("does not exist")
    ) {
      return [];
    }
    // Unexpected error — rethrow
    throw err;
  }
}

/**
 * Parse git blame `--line-porcelain` output into BlameLine[].
 *
 * Porcelain format: each "chunk" starts with `<hash> <orig_line> <final_line> <num_lines>`,
 * followed by header lines (`author`, `author-mail`, `author-time`, etc.),
 * then a tab-prefixed content line.
 */
export function parseBlameOutput(raw: string): BlameLine[] {
  const result: BlameLine[] = [];
  if (!raw || !raw.trim()) {
    return result;
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const allLines = normalized.split("\n");

  // State machine: iterate through lines, detecting chunk boundaries
  // A chunk starts with a line matching: <hash> <orig_line> <final_line> <num_lines>
  const headerRe = /^([0-9a-f]{40}) (\d+) (\d+) (\d+)/;

  let commitHash = "";
  let finalLineNum = 0;
  let author = "";
  let authorEmail = "";
  let timestamp = "";

  for (const line of allLines) {
    const headerMatch = line.match(headerRe);
    if (headerMatch) {
      // Start of a new chunk — reset state
      commitHash = headerMatch[1];
      finalLineNum = parseInt(headerMatch[3], 10);
      author = "";
      authorEmail = "";
      timestamp = "";
      continue;
    }

    if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("author-mail ")) {
      authorEmail = line.slice("author-mail ".length).replace(/[<>]/g, "");
    } else if (line.startsWith("author-time ")) {
      const epoch = parseInt(line.slice("author-time ".length), 10);
      timestamp = new Date(epoch * 1000).toISOString();
    } else if (line.startsWith("\t")) {
      // Content line — emit a BlameLine
      result.push({
        lineNumber: finalLineNum,
        commitHash,
        author,
        authorEmail,
        timestamp,
        content: line.slice(1), // remove leading tab
      });
    }
    // Other lines (summary, filename, etc.) are ignored
  }

  return result;
}

/**
 * Summarize blame data into per-author ownership percentages.
 */
export function summarizeOwnership(blameLines: BlameLine[]): BlameSummary[] {
  if (blameLines.length === 0) {
    return [];
  }

  const totalLines = blameLines.length;
  const byAuthor = new Map<string, { name: string; email: string; lines: number }>();

  for (const line of blameLines) {
    const key = line.authorEmail;
    const existing = byAuthor.get(key);
    if (existing) {
      existing.lines++;
    } else {
      byAuthor.set(key, {
        name: line.author,
        email: line.authorEmail,
        lines: 1,
      });
    }
  }

  const summaries: BlameSummary[] = [];
  for (const entry of byAuthor.values()) {
    summaries.push({
      author: entry.name,
      authorEmail: entry.email,
      contributionLines: entry.lines,
      percentage: Math.round((entry.lines / totalLines) * 10000) / 10000, // 4 decimal places
    });
  }

  // Sort by contribution descending
  summaries.sort((a, b) => b.contributionLines - a.contributionLines);

  return summaries;
}
