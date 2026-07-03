/**
 * Change Detector
 *
 * Detects file changes between the last analyzed commit and the current HEAD
 * by comparing commit hashes and running `git diff --name-status`.
 */

import { execSync } from 'child_process';
import type { IGraphStore } from '../store/interfaces.js';

export interface ChangeSet {
  /** Files that were modified — need re-indexing */
  modified: string[];
  /** Files that were deleted — need node removal */
  deleted: string[];
  /** Files that were added — need new indexing */
  added: string[];
  /** The commit the last analysis ran on */
  fromCommit: string;
  /** The current HEAD commit */
  toCommit: string;
}

/**
 * Detect changes since the last analysis.
 *
 * Returns null if no previous analysis exists (triggers full analysis),
 * or an empty ChangeSet if no changes detected.
 */
export async function detectChanges(
  localPath: string,
  graphStore: IGraphStore,
  projectId: string,
): Promise<ChangeSet | null> {
  // 1. Query Project.lastCommit from Neo4j
  let lastCommit: string | undefined;
  try {
    const result = await graphStore.query(
      'MATCH (p:Project {id: $projectId}) RETURN p.lastCommit AS c',
      { projectId },
    );
    lastCommit = (result[0] as Record<string, unknown> | undefined)?.c as string | undefined;
  } catch {
    // Project might not exist
  }

  if (!lastCommit) {
    console.log(`[change-detector] No lastCommit found for ${projectId}, will trigger full analysis`);
    return null;
  }

  // 2. Get current HEAD
  const headCommit = execSync('git rev-parse HEAD', {
    cwd: localPath,
    encoding: 'utf-8',
  }).trim();

  // 3. Same commit = no changes
  if (headCommit === lastCommit) {
    console.log(`[change-detector] No changes: HEAD (${headCommit.slice(0, 8)}) == lastCommit`);
    return {
      modified: [],
      deleted: [],
      added: [],
      fromCommit: lastCommit,
      toCommit: headCommit,
    };
  }

  // 4. Get diff
  console.log(`[change-detector] Detecting changes: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
  const diffOutput = execSync(
    `git diff --name-status ${lastCommit}..${headCommit}`,
    { cwd: localPath, encoding: 'utf-8' },
  );

  // 5. Parse output
  const modified: string[] = [];
  const deleted: string[] = [];
  const added: string[] = [];

  for (const line of diffOutput.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0]?.trim();
    const filePath = parts[1]?.trim();

    if (!status || !filePath) continue;

    if (status === 'D') {
      deleted.push(filePath);
    } else if (status === 'A') {
      added.push(filePath);
    } else if (status === 'R' && parts[2]) {
      // Rename = delete old + add new
      deleted.push(filePath);
      added.push(parts[2].trim());
    } else {
      // M (modified) or other (C, T, etc.)
      modified.push(filePath);
    }
  }

  console.log(
    `[change-detector] Changes: ${modified.length} modified, ${deleted.length} deleted, ${added.length} added`,
  );

  return {
    modified,
    deleted,
    added,
    fromCommit: lastCommit,
    toCommit: headCommit,
  };
}
