/**
 * Vendor directory detector
 *
 * Determines whether a directory path represents a vendor/dependency
 * directory that should be skipped during code indexing.
 *
 * Uses a three-layer detection strategy:
 * 1. Path pattern (strong) — matches known vendor directory names in the path
 * 2. Package file detection (medium) — checks for package manager files
 *    in non-root directories (filesystem I/O required)
 * 3. Content heuristics (weak/reserved) — reserved for future use
 *
 * Used by the filesystem walker to complement language-aware ignore profiles.
 */

import { existsSync } from 'node:fs';
import { join, basename, normalize } from 'node:path';

/**
 * Result of vendor directory detection.
 */
export interface VendorDetectionResult {
  /** Whether the directory is classified as vendor/dependency */
  isVendor: boolean;
  /** Human-readable explanation of why (or why not) */
  reason: string;
  /** Confidence score from 0.0 (definitely not) to 1.0 (definitely vendor) */
  confidence: number;
}

/**
 * Confidence scale rationale:
 *
 * - **0.95+**: Universal vendor-only directories that never appear in user code.
 *   These names are reserved by tooling conventions and universally signal "skip".
 *   Example: `node_modules`.
 *
 * - **0.85-0.95**: Strong vendor signal but may appear in rare edge cases
 *   (e.g., a user who literally names a directory `vendor` for app code).
 *   Examples: `vendor`, `third_party`, `bower_components`, `__pycache__`, `jspm_packages`.
 *
 * - **0.80-0.85**: Often vendor but context-dependent. These names have legitimate
 *   non-vendor uses in some ecosystems.
 *   Examples: `deps`, `venv` (could be a user's Python venv or app dir).
 *
 * - **0.6**: Layer 2 signal — a package file exists but the directory is not a project
 *   root. This is weaker because a package file alone doesn't prove vendored content;
 *   it needs filesystem corroboration (which Layer 2 provides via the project-root check).
 */
const VENDOR_PATH_PATTERNS: ReadonlyArray<{
  pattern: string;
  confidence: number;
  label: string;
}> = [
  { pattern: 'node_modules', confidence: 0.97, label: 'npm dependencies' },
  { pattern: 'vendor', confidence: 0.9, label: 'Go/vendor dependencies' },
  { pattern: 'third_party', confidence: 0.88, label: 'third-party code' },
  { pattern: 'bower_components', confidence: 0.92, label: 'Bower components' },
  { pattern: 'deps', confidence: 0.85, label: 'dependency directory' },
  { pattern: '__pycache__', confidence: 0.93, label: 'Python bytecode cache' },
  { pattern: '.venv', confidence: 0.9, label: 'Python virtual environment' },
  { pattern: 'venv', confidence: 0.82, label: 'Python virtual environment' },
  { pattern: 'jspm_packages', confidence: 0.92, label: 'jspm packages' },
];

/**
 * Package manager files that indicate a directory might be a vendored package.
 * Used in Layer 2 detection.
 */
const PACKAGE_FILES = [
  'package.json',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'setup.py',
] as const;

/**
 * Normalize a path for consistent matching.
 * Converts backslashes to forward slashes and resolves relative segments.
 */
function normalizePath(dirPath: string): string {
  return normalize(dirPath).replace(/\\/g, '/');
}

/**
 * Extract directory path segments for pattern matching.
 * Returns lowercase segment names.
 */
function getPathSegments(dirPath: string): string[] {
  const normalized = normalizePath(dirPath);
  return normalized
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => segment.toLowerCase());
}

/**
 * Check if any path segment matches a known vendor directory name.
 * Uses exact segment matching (not substring) to avoid false positives
 * like "vendortest" matching "vendor".
 */
function matchPathPattern(
  segments: string[],
): { matched: boolean; confidence: number; label: string } {
  for (const segment of segments) {
    for (const entry of VENDOR_PATH_PATTERNS) {
      if (segment === entry.pattern) {
        return { matched: true, confidence: entry.confidence, label: entry.label };
      }
    }
  }
  return { matched: false, confidence: 0, label: '' };
}

/**
 * Directories that indicate the current location is a project root,
 * not a vendored package. Used to suppress Layer 2 false positives.
 */
const PROJECT_ROOT_MARKERS = [
  'src',
  'lib',
  'test',
  'tests',
  'spec',
  'cmd',
  'internal',
  'pkg',
  'docs',
  'scripts',
  '.git',
  '.github',
] as const;

/**
 * Check if the directory looks like a project root (has source/test directories).
 * A directory with package files AND project structure markers is the project
 * itself, not a vendored dependency.
 */
function looksLikeProjectRoot(dirPath: string): boolean {
  for (const marker of PROJECT_ROOT_MARKERS) {
    const markerPath = join(dirPath, marker);
    if (existsSync(markerPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the directory contains package manager files.
 */
function hasPackageFiles(dirPath: string): boolean {
  for (const pkgFile of PACKAGE_FILES) {
    if (existsSync(join(dirPath, pkgFile))) {
      return true;
    }
  }
  return false;
}

/**
 * Detect whether the given directory path is a vendor/dependency directory.
 *
 * Uses a three-layer strategy:
 *
 * **Layer 1 (Path Pattern — Strong):**
 * Matches the directory path against known vendor directory names
 * (node_modules, vendor, third_party, bower_components, deps, __pycache__, etc.).
 * This layer requires no filesystem access and provides high-confidence results.
 *
 * **Layer 2 (Package File Detection — Medium):**
 * If no strong path pattern matches, checks whether the directory contains
 * package manager files (package.json, Cargo.toml, etc.) and is NOT at the
 * repository root. This catches vendored packages in custom-named directories.
 * Requires filesystem access.
 *
 * **Layer 3 (Content Heuristics — Weak, Reserved):**
 * Reserved for future enhancement. Would check file content patterns
 * (e.g., copyright headers, minified code ratio) for low-confidence signals.
 *
 * @param dirPath - Absolute or relative path to the directory
 * @returns Detection result with vendor classification, reason, and confidence
 */
// TODO(I-1): This function is async only for Layer 2 filesystem I/O (existsSync calls).
// Layer 1 (path pattern) callers pay unnecessary async overhead. In T5 integration,
// consider splitting into isVendorByPath (sync) + isVendorByFilesystem (async) so
// the walker can batch-sync-filter path patterns and only fall back to async for
// ambiguous directories.
export async function isVendorDirectory(dirPath: string): Promise<VendorDetectionResult> {
  // I-2: Guard against null/undefined/empty/whitespace input.
  // normalizePath calls node:path.normalize() which throws TypeError on null/undefined.
  // Empty/whitespace strings pass normalize() but produce bogus paths that could
  // cause filesystem side-effects in Layer 2 (existsSync on '.' or '   ').
  if (!dirPath || typeof dirPath !== 'string' || dirPath.trim().length === 0) {
    return { isVendor: false, reason: 'Invalid path', confidence: 0.0 };
  }

  const segments = getPathSegments(dirPath);

  if (segments.length === 0) {
    return {
      isVendor: false,
      reason: 'Root or empty path',
      confidence: 0.0,
    };
  }

  // Layer 1: Path pattern matching (strong signal, no I/O)
  const patternMatch = matchPathPattern(segments);
  if (patternMatch.matched) {
    return {
      isVendor: true,
      reason: `Path matches vendor directory pattern (${patternMatch.label})`,
      confidence: patternMatch.confidence,
    };
  }

  // Layer 2: Package file detection (medium signal, I/O required)
  // Checks for package manager files in directories that don't look like
  // project roots. A directory with package.json + src/ is the project,
  // not a vendored dependency.
  try {
    if (hasPackageFiles(dirPath) && !looksLikeProjectRoot(dirPath)) {
      return {
        isVendor: true,
        reason:
          'Directory contains package manager files but lacks project structure (possible vendored dependency)',
        confidence: 0.6,
      };
    }
  } catch {
    // Filesystem error — fall through to non-vendor result
  }

  // No vendor signals detected
  const dirName = basename(normalizePath(dirPath)) || dirPath;
  return {
    isVendor: false,
    reason: `Directory '${dirName}' does not match any vendor pattern and contains no package files`,
    confidence: 0.0,
  };
}
