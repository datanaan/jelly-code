/**
 * Parse git log output into structured CommitData.
 *
 * Handles the `--name-status --format="%H|%an|%ae|%aI|%s"` output format.
 */

import type { CommitData, FileChange, ChangedInRelation } from "./types.js";

/**
 * Parse raw git log output into CommitData[].
 *
 * Each commit block starts with a header line:
 *   `<hash>|<author>|<email>|<date>|<message>`
 * followed by zero or more name-status lines:
 *   `M\tpkg/foo.ts` / `A\tnew.ts` / `D\told.ts` / `R100\told\tnew`
 *
 * IMPORTANT: Git log with --name-status does NOT reliably separate commits
 * with double newlines. A commit with file changes is followed by a single
 * newline then the next commit header. We split on the header pattern instead.
 */
export function parseGitLogOutput(raw: string): CommitData[] {
  const commits: CommitData[] = [];
  if (!raw || !raw.trim()) {
    return commits;
  }

  const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");

  let currentHeaderIdx = -1;
  const headerIndices: number[] = [];

  // Find all commit header lines (40-char hex hash followed by |)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[0-9a-f]{40}\|/.test(line)) {
      headerIndices.push(i);
    }
  }

  for (let h = 0; h < headerIndices.length; h++) {
    const startIdx = headerIndices[h];
    const endIdx = h + 1 < headerIndices.length ? headerIndices[h + 1] : lines.length;

    const headerLine = lines[startIdx];
    const pipeIdx = headerLine.indexOf("|");
    if (pipeIdx === -1) continue;

    const parts = headerLine.split("|");
    if (parts.length < 5) continue;

    const [hash, author, authorEmail, timestamp, ...messageParts] = parts;
    const message = messageParts.join("|"); // message may contain |

    // Lines between this header and the next header are name-status lines
    const nameStatusLines = lines.slice(startIdx + 1, endIdx).filter((l) => l.trim().length > 0);
    const changedFiles = parseFileChanges(nameStatusLines);

    commits.push({
      hash: hash.trim(),
      message: message.trim(),
      author: author.trim(),
      authorEmail: authorEmail.trim(),
      timestamp: timestamp.trim(),
      additions: 0, // not available from name-status output
      deletions: 0, // not available from name-status output
      isMerge: false, // --no-merges flag ensures this
      changedFiles,
    });
  }

  return commits;
}

/**
 * Parse `--name-status` lines into FileChange[].
 *
 * Status codes:
 *   A = added, M = modified, D = deleted,
 *   R### = renamed (with similarity percentage), C### = copied
 */
export function parseFileChanges(nameStatusLines: string[]): FileChange[] {
  const changes: FileChange[] = [];

  for (const line of nameStatusLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Format: STATUS\tPATH  or  R100\tOLD\tNEW
    const parts = trimmed.split("\t");
    const status = parts[0];

    if (!status) continue;

    // Rename entries: R100\told_path\tnew_path
    if (status.startsWith("R")) {
      changes.push({
        filePath: parts[1] || "",
        changeType: "renamed",
        newPath: parts[2] || undefined,
      });
      continue;
    }

    // Copy entries: treat as "added"
    if (status.startsWith("C")) {
      changes.push({
        filePath: parts[1] || "",
        changeType: "added",
      });
      continue;
    }

    // Standard entries: A/M/D\tfilepath
    const filePath = parts[1] || "";
    let changeType: FileChange["changeType"];

    switch (status) {
      case "A":
        changeType = "added";
        break;
      case "M":
        changeType = "modified";
        break;
      case "D":
        changeType = "deleted";
        break;
      default:
        // Unknown status — skip
        continue;
    }

    changes.push({ filePath, changeType });
  }

  return changes;
}

/**
 * Map file changes to graph node IDs via a lookup function.
 *
 * For each file change, calls findFileNodeIds to resolve the path to one or
 * more node IDs. Returns mapped ChangedInRelation entries and unmapped changes
 * where no node was found.
 */
export async function mapFileChangesToNodes(
  changes: FileChange[],
  findFileNodeIds: (filePath: string) => Promise<string[]>,
): Promise<{ mapped: ChangedInRelation[]; unmapped: FileChange[] }> {
  const mapped: ChangedInRelation[] = [];
  const unmapped: FileChange[] = [];

  for (const change of changes) {
    const nodeIds = await findFileNodeIds(change.filePath);
    if (nodeIds.length === 0) {
      unmapped.push(change);
    } else {
      for (const nodeId of nodeIds) {
        mapped.push({
          nodeId,
          commitHash: "", // to be filled by caller
          changeType: change.changeType,
          additions: change.additions ?? 0,
          deletions: change.deletions ?? 0,
          timestamp: "", // to be filled by caller
        });
      }
    }
  }

  return { mapped, unmapped };
}
