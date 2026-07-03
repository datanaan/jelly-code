/**
 * Document discoverer (P0b-T2)
 *
 * Walks a repository and returns all document files suitable for Wiki
 * ingestion. Combines two building blocks:
 *
 * 1. **P0a's `walkRepositoryPaths`** — walks the filesystem with vendor,
 *    binary, language, and size filtering. The document whitelist (T6)
 *    ensures docs inside vendor/ and other skipped directories are
 *    preserved.
 *
 * 2. **T1's `classifyFile`** — classifies each file using a three-layer
 *    strategy (extension → path/filename → content heuristics) and returns
 *    a structured `ClassificationResult` with confidence and source
 *    attribution.
 *
 * The discoverer calls the walker to get all kept files (including
 * preserved docs), then filters through the classifier to return only
 * those classified as documents. Each result includes the classification
 * metadata for downstream decisions (e.g., confidence-weighted ingestion).
 *
 * @example
 * ```typescript
 * import { discoverDocs } from './doc-discovery.js';
 *
 * // Full scan — return all documents
 * const docs = await discoverDocs('/path/to/repo');
 *
 * // Incremental — only documents modified since last sync
 * const newDocs = await discoverDocs('/path/to/repo', {
 *   since: Date.now() - 24 * 3600 * 1000, // last 24 hours
 * });
 * ```
 */

import { join } from 'node:path';
import { statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { walkRepositoryPaths } from '../core/ingestion/filesystem-walker.js';
import { classifyFile, type ClassificationResult } from './doc-classifier.js';

/**
 * Repository structure metadata (P0b-T7).
 *
 * Provides high-level structural information about a repository to help
 * downstream tools (like `deriveBatchParams`) make smarter decisions about
 * where to look for documentation and how to ingest it.
 */
export interface RepoStructure {
  /**
   * The primary documentation directory name, or null if none found.
   * Checked in priority order: `docs`, `doc`, `documentation`.
   */
  docsDir: string | null;

  /**
   * Paths to monorepo package README files (relative paths from repo root,
   * forward slashes). For example: `packages/core/README.md`.
   * Empty if the repo is not a monorepo or packages lack READMEs.
   */
  moduleReadmes: string[];

  /**
   * True if the repository appears to be a monorepo — detected via
   * `packages/` subdirectories or workspace config files
   * (package.json `workspaces` field, lerna.json, pnpm-workspace.yaml).
   */
  isMonorepo: boolean;

  /**
   * True if `.github/wiki/` directory exists (GitHub Wiki convention).
   */
  hasGitHubWiki: boolean;
}

/**
 * A document discovered in a repository, ready for Wiki ingestion.
 */
export interface DiscoveredDoc {
  /**
   * Relative file path from the repository root.
   * Uses forward slashes on all platforms (e.g., `docs/guide.md`).
   */
  path: string;
  /**
   * File size in bytes (from stat, provided by the walker).
   */
  size: number;
  /**
   * Classification result from `classifyFile`, including confidence,
   * source layer, and human-readable reason.
   */
  classification: ClassificationResult;
}

/**
 * Options for incremental document discovery.
 */
export interface DiscoverDocsOptions {
  /**
   * Unix epoch timestamp in milliseconds. When set (non-zero), only
   * documents whose file modification time (mtime) is **greater than or
   * equal to** this value are returned.
   *
   * - Omit `since` or set to `0` to return **all** documents (full scan).
   * - Set to a past timestamp to return only documents modified since then.
   *
   * The filter uses file `mtime` (via `fs.stat`), not git history. This
   * works on any filesystem without requiring a git repository. A git
   * `log --since` based approach would be more accurate for detecting
   * content changes (vs. metadata-only touches) but adds a git dependency.
   *
   * **Semantics**: `mtimeMs >= since` (inclusive boundary — a file
   * modified at exactly the `since` timestamp IS included).
   */
  since?: number;
}

/**
 * Discover all document files in a repository.
 *
 * Walks the repository using P0a's `walkRepositoryPaths` (which applies
 * vendor, binary, language, and size filtering with document whitelist
 * preservation), then filters the result through T1's `classifyFile` to
 * return only files classified as documents.
 *
 * @param repoPath - Absolute path to the repository root
 * @param options - Optional discovery options. Set `options.since` to a
 *                  Unix epoch timestamp (ms) to return only documents
 *                  modified at or after that time (incremental mode).
 * @returns Array of discovered documents with classification metadata,
 *          sorted by relative path. Returns an empty array if no documents
 *          are found, the repository is empty, or (in incremental mode) no
 *          documents have been modified since the given timestamp.
 */
export async function discoverDocs(
  repoPath: string,
  options?: DiscoverDocsOptions,
): Promise<DiscoveredDoc[]> {
  // Extract since filter — 0 or undefined means "no filter" (full scan).
  const since = options?.since ?? 0;
  const useSinceFilter = since > 0;

  // Step 1: Walk the repository to get all kept files.
  // The walker preserves docs inside vendor/ via the T6 whitelist.
  const scannedFiles = await walkRepositoryPaths(repoPath);

  // Step 2: Classify each file and filter to documents only.
  // In incremental mode, also filter by mtime >= since.
  const discovered: DiscoveredDoc[] = [];

  for (const file of scannedFiles) {
    // Build the full path for both mtime check and content heuristics.
    // (Layer 3 of classifyFile may read the file.)
    const fullPath = join(repoPath, file.path);

    // Incremental filter: check mtime before expensive classification.
    // Uses >= semantics: a file modified at exactly `since` is included.
    if (useSinceFilter) {
      const mtimeMs = statSync(fullPath).mtimeMs;
      if (mtimeMs < since) {
        continue; // File not modified since cutoff — skip
      }
    }

    const classification = await classifyFile(fullPath);

    if (classification.isDoc) {
      discovered.push({
        path: file.path,
        size: file.size,
        classification,
      });
    }
  }

  // Step 3: Sort by path for deterministic output.
  discovered.sort((a, b) => a.path.localeCompare(b.path));

  return discovered;
}

// ==========================================
// Repository Structure Detection (P0b-T7)
// ==========================================

/**
 * Documentation directory candidates, in priority order.
 * `docs/` is most common; `documentation/` is less common but used by
 * some large projects. `doc/` is a legacy variant.
 */
const DOC_DIR_CANDIDATES = ['docs', 'doc', 'documentation'] as const;

/**
 * Common workspace/package directory names in monorepos.
 */
const MONOREPO_DIR_CANDIDATES = ['packages', 'apps', 'libs', 'modules'] as const;

/**
 * Detect repository structure metadata.
 *
 * Inspects the repository root for:
 * 1. **docs/ directory** — common docs locations checked in priority order
 *    (`docs` > `doc` > `documentation`). Returns the first match.
 *
 * 2. **Monorepo module READMEs** — scans `packages/`, `apps/`, `libs/`,
 *    and `modules/` subdirectories for `README.md` files. Also checks
 *    workspace config: `package.json` workspaces field, `lerna.json`,
 *    and `pnpm-workspace.yaml`.
 *
 * 3. **GitHub Wiki** — checks for `.github/wiki/` directory.
 *
 * This function uses synchronous filesystem operations and is safe to
 * call on any existing directory. Non-existent or unreadable paths are
 * treated as absent.
 *
 * @param repoPath - Absolute path to the repository root
 * @returns RepoStructure with detection results. All fields default to
 *          null/false/empty when nothing is detected.
 */
export async function detectRepoStructure(repoPath: string): Promise<RepoStructure> {
  const result: RepoStructure = {
    docsDir: null,
    moduleReadmes: [],
    isMonorepo: false,
    hasGitHubWiki: false,
  };

  // --- 1. Detect docs/ directory ---
  for (const candidate of DOC_DIR_CANDIDATES) {
    const dirPath = join(repoPath, candidate);
    if (existsSync(dirPath) && isDirectory(dirPath)) {
      result.docsDir = candidate;
      break; // First match wins (priority order)
    }
  }

  // --- 2. Detect monorepo ---
  const monorepoInfo = detectMonorepo(repoPath);
  result.isMonorepo = monorepoInfo.isMonorepo;
  result.moduleReadmes = monorepoInfo.moduleReadmes;

  // --- 3. Detect GitHub Wiki ---
  const wikiPath = join(repoPath, '.github', 'wiki');
  if (existsSync(wikiPath) && isDirectory(wikiPath)) {
    result.hasGitHubWiki = true;
  }

  return result;
}

/**
 * Check if a path is a directory.
 * Returns false if the path does not exist or is not accessible.
 */
function isDirectory(absPath: string): boolean {
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect monorepo structure: workspace config + packages directory READMEs.
 *
 * A repo is considered a monorepo if any of:
 * - `package.json` has a `workspaces` field (npm/yarn workspaces)
 * - `lerna.json` exists
 * - `pnpm-workspace.yaml` exists
 * - Has `packages/` (or `apps/`, `libs/`, `modules/`) directory with
 *   subdirectories
 *
 * Module READMEs are collected from all workspace-like directories.
 */
function detectMonorepo(
  repoPath: string,
): { isMonorepo: boolean; moduleReadmes: string[] } {
  let isMonorepo = false;
  const moduleReadmes: string[] = [];

  // Check workspace config files
  isMonorepo = hasWorkspaceConfig(repoPath);

  // Check packages/ and similar directories for subdirectories with READMEs
  for (const dirCandidate of MONOREPO_DIR_CANDIDATES) {
    const dirPath = join(repoPath, dirCandidate);

    if (!existsSync(dirPath) || !isDirectory(dirPath)) {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }

    // Filter to subdirectories (packages/a, packages/b, ...)
    const subdirs = entries.filter((entry) => {
      const entryPath = join(dirPath, entry);
      return isDirectory(entryPath);
    });

    if (subdirs.length > 0) {
      // Found subdirectories in packages/ — this is likely a monorepo
      isMonorepo = true;

      // Collect README.md files from each subdirectory
      for (const subdir of subdirs) {
        const readmePath = join(dirCandidate, subdir, 'README.md');
        const fullReadmePath = join(repoPath, readmePath);
        if (existsSync(fullReadmePath)) {
          moduleReadmes.push(readmePath);
        }
      }
    }
  }

  return { isMonorepo, moduleReadmes };
}

/**
 * Check if the repository has workspace configuration files indicating
 * a monorepo setup.
 */
function hasWorkspaceConfig(repoPath: string): boolean {
  // Check package.json for workspaces field
  const packageJsonPath = join(repoPath, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content) as Record<string, unknown>;
      if ('workspaces' in pkg && pkg.workspaces !== undefined && pkg.workspaces !== null) {
        return true;
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // Check lerna.json
  const lernaJsonPath = join(repoPath, 'lerna.json');
  if (existsSync(lernaJsonPath)) {
    return true;
  }

  // Check pnpm-workspace.yaml
  const pnpmWorkspacePath = join(repoPath, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    return true;
  }

  return false;
}
