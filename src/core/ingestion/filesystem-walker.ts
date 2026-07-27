import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import {
  readJellyignore,
  DEFAULT_IGNORE_PATTERNS,
} from '../../config/ignore-service.js';
import { isVendorDirectory } from '../../config/vendor-detector.js';
import { isBinaryFile } from '../../config/binary-detector.js';
import {
  getLanguageIgnorePatterns,
  detectLanguageFromFiles,
} from '../../config/language-ignore-profiles.js';

export interface FileEntry {
  path: string;
  content: string;
}

/** Lightweight entry — path + size from stat, no content in memory */
export interface ScannedFile {
  path: string;
  size: number;
}

/** Path-only reference (for type signatures) */
export interface FilePath {
  path: string;
}

const READ_CONCURRENCY = 32;

/** Skip files larger than 512KB — they're usually generated/vendored and crash tree-sitter */
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || (512 * 1024).toString(), 10);

// ── Document whitelist (T6) ─────────────────────────────────────────
/**
 * Document file extensions that are ALWAYS preserved, even inside vendor/
 * or other skipped directories. These represent human-readable documentation
 * that carries valuable context regardless of location.
 *
 * Design principle: "文档白名单优先" — document files are identified and
 * preserved even inside vendor/, node_modules/, build/, or other skipped
 * directories. The whitelist check runs BEFORE vendor/binary detection.
 */
const DOCUMENT_EXTENSIONS = new Set([
  '.md',
  '.rst',
  '.adoc',
  '.org',
  '.txt',
  '.markdown',
]);

/**
 * Document filenames (case-insensitive, no extension) that are always
 * preserved. Matches ONLY when the file has no extension at all.
 * Files like `README` (bare), `LICENSE` (bare) match.
 * `README.md` matches via the extension whitelist instead.
 * `README.bak` does NOT match — `.bak` is not a document extension.
 */
const DOCUMENT_FILENAMES = new Set([
  'README',
  'CHANGELOG',
  'CHANGES',
  'LICENSE',
  'CONTRIBUTING',
  'AUTHORS',
  'NEWS',
  'TODO',
]);

/**
 * Check whether a file path represents a document that should be preserved
 * regardless of its directory location (vendor/, node_modules/, build/, etc.).
 *
 * This function checks both the file extension and the basename (without
 * extension) to determine if the file is a document:
 * - Extension match: `.md`, `.rst`, `.adoc`, `.org`, `.txt`, `.markdown`
 * - Filename match: `README`, `CHANGELOG`, `CHANGES`, `LICENSE`,
 *   `CONTRIBUTING`, `AUTHORS`, `NEWS`, `TODO` (case-insensitive, ONLY for
 *   files without any extension)
 *
 * @param filePath - Relative or absolute file path to check
 * @returns `true` if the file is a document that should be preserved
 */
export function isDocumentFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();

  // Extension whitelist (always applies): .md, .rst, .adoc, .org, .txt, .markdown
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return true;
  }

  // Filename whitelist (ONLY for files without extension, per JSDoc):
  // `README`, `LICENSE`, `CHANGELOG`, etc. — bare filenames only.
  // `README.bak`, `LICENSE.exe` should NOT match (wrong extension).
  if (ext === '') {
    const basename = path.basename(filePath).toUpperCase();
    if (DOCUMENT_FILENAMES.has(basename)) {
      return true;
    }
  }

  return false;
}

/**
 * Summary of files skipped by each detector during the walk.
 * Returned when `returnSkipSummary: true` is passed in the options.
 */
export interface SkipSummary {
  /** Files skipped because they reside in a vendor/dependency directory */
  skippedVendor: number;
  /** Files skipped because they are binary (non-text) */
  skippedBinary: number;
  /** Files skipped because they exceed MAX_FILE_SIZE */
  skippedLarge: number;
  /** Files skipped because they match a language-specific ignore pattern */
  skippedLanguage: number;
  /** Documents preserved by whitelist, even inside vendor/build dirs (T6) */
  preservedDocs: number;
}

/**
 * Walk result containing both the kept files and a skip summary.
 */
export interface WalkRepositoryResult {
  files: ScannedFile[];
  skipSummary: SkipSummary;
}

/**
 * Options for `walkRepositoryPaths`.
 */
export interface WalkOptions {
  /** When true, returns `WalkRepositoryResult` instead of `ScannedFile[]`. */
  returnSkipSummary?: boolean;
}

/**
 * Check if a relative file path should be ignored based on a set of
 * glob-style ignore patterns. Uses a simple segment/basename match
 * similar to gitignore semantics for directory patterns.
 */
function matchesIgnorePattern(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  for (const pattern of patterns) {
    let p = pattern.replace(/^\//, '');
    if (p.endsWith('/')) p = p.slice(0, -1);

    // Exact match against any path segment
    for (const seg of segments) {
      if (seg === p) return true;
    }

    // Glob-style match (*.ext patterns)
    if (p.includes('*')) {
      const regexStr = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`(^|/)${regexStr}(/|$)`);
      if (regex.test(normalized)) return true;
    }
  }
  return false;
}

/**
 * Phase 1: Scan repository — stat files to get paths + sizes, no content loaded.
 * Memory: ~10MB for 100K files vs ~1GB+ with content.
 *
 * Integrates four skip detectors:
 *
 * 1. **Vendor directory detector (T2):** Checks each file's directory path
 *    against known vendor patterns (`node_modules`, `vendor`, `third_party`, etc.).
 *    Uses `isVendorDirectory()` from `vendor-detector.ts`.
 *
 * 2. **Binary file detector (T3):** Checks each file using extension lookup
 *    and content-based heuristics (magic bytes, NULL ratio, UTF-8 validity).
 *    Uses `isBinaryFile()` from `binary-detector.ts`.
 *
 * 3. **Language profile (T1):** Detects the project's primary language from
 *    file extensions and config files, then applies language-specific ignore
 *    patterns (e.g., Rust `target/`, Python `__pycache__`).
 *    Uses `detectLanguageFromFiles()` + `getLanguageIgnorePatterns()` from
 *    `language-ignore-profiles.ts`.
 *
 * 4. **.jellyignore (T4):** Reads custom ignore patterns from `.jellyignore`
 *    at the repo root. These patterns have **highest priority** — they
 *    override all other ignore sources.
 *    Uses `readJellyignore()` from `ignore-service.ts`.
 *
 * Additionally, the existing `.gitignore` + default patterns continue to be
 * applied via glob's ignore option for the initial file listing.
 *
 * @param repoPath - Absolute path to the repository root
 * @param onProgress - Optional progress callback (current, total, filePath)
 * @param options - Optional walk options. Pass `{ returnSkipSummary: true }`
 *                  to get a `WalkRepositoryResult` with skip counts.
 * @returns `ScannedFile[]` by default, or `WalkRepositoryResult` when
 *          `options.returnSkipSummary` is `true`.
 */
export function walkRepositoryPaths(
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ScannedFile[]>;
export function walkRepositoryPaths(
  repoPath: string,
  onProgress: (current: number, total: number, filePath: string) => void | undefined,
  options: WalkOptions & { returnSkipSummary: true },
): Promise<WalkRepositoryResult>;
export async function walkRepositoryPaths(
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
  options?: WalkOptions,
): Promise<ScannedFile[] | WalkRepositoryResult> {
  // ── Build combined ignore patterns for glob pre-filtering ──────────
  // The existing createIgnoreFilter returns an IgnoreFilter object with
  // a .test() method, which is not directly usable by glob's `ignore`
  // option. We build a string-array of patterns instead.

  // 1. Read .jellyignore (T4) — highest priority custom patterns
  const jellyignorePatterns = await readJellyignore(repoPath);

  // 2. Read .gitignore + defaults for glob-level filtering
  // We extract the raw patterns from the ignore-service to build a glob-compatible array
  const baseIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS];

  // Also add .gitignore patterns
  const gitignorePath = path.join(repoPath, '.gitignore');
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      const gitignorePatterns = content
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.startsWith('#'));
      baseIgnorePatterns.push(...gitignorePatterns);
    }
  } catch {
    // Ignore errors reading .gitignore
  }

  // Combine all patterns for glob's ignore option.
  // jellyignore patterns are included here since they should take highest priority.
  // Directory patterns ending with '/' are expanded to `dir/**` so glob
  // properly excludes all files within them.
  const allGlobIgnore = [
    ...jellyignorePatterns.map((p) => (p.endsWith('/') ? `${p}**` : p)),
    ...baseIgnorePatterns,
  ];

  // ── Glob pass: get all files minus ignored patterns ────────────────
  const filtered = await glob('**/*', {
    cwd: repoPath,
    nodir: true,
    dot: false,
    ignore: allGlobIgnore,
  });

  // ── Language detection (T1) ────────────────────────────────────────
  // Detect primary language from the glob-filtered file list
  const detectedLanguage = detectLanguageFromFiles(filtered);
  const languagePatterns = detectedLanguage
    ? getLanguageIgnorePatterns(detectedLanguage)
    : [];

  // ── Process files in batches ───────────────────────────────────────
  const entries: ScannedFile[] = [];
  const skipSummary: SkipSummary = {
    skippedVendor: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    skippedLanguage: 0,
    preservedDocs: 0,
  };

  let processed = 0;

  for (let start = 0; start < filtered.length; start += READ_CONCURRENCY) {
    const batch = filtered.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const normalizedRel = relativePath.replace(/\\/g, '/');

        // ── T6: Document whitelist (HIGHEST priority) ──────────────
        // Documents (.md, .rst, .adoc, README, CHANGELOG, LICENSE, etc.)
        // are ALWAYS preserved — even inside vendor/, node_modules/,
        // build/, or other skipped directories. This check runs BEFORE
        // vendor/language/binary detection so docs are never skipped.
        // Design principle: "文档白名单优先" — document whitelist priority
        // is higher than skip blacklist.
        const isDoc = isDocumentFile(normalizedRel);

        if (!isDoc) {
          // ── T2: Vendor directory check (strongest signal) ───────
          // Check if the file's parent directory is a vendor directory.
          // This runs after the document whitelist so docs in vendor/
          // are still preserved.
          const parentDir = path.dirname(fullPath);
          const vendorResult = await isVendorDirectory(parentDir);
          if (vendorResult.isVendor) {
            skipSummary.skippedVendor++;
            return { kind: 'skipped' as const };
          }

          // ── T1: Language profile check ──────────────────────────
          if (languagePatterns.length > 0 && matchesIgnorePattern(normalizedRel, languagePatterns)) {
            skipSummary.skippedLanguage++;
            return { kind: 'skipped' as const };
          }
        }

        // ── Stat for size check ─────────────────────────────────────
        const stat = await fs.stat(fullPath);

        // ── Existing: Large file check ──────────────────────────────
        if (stat.size > MAX_FILE_SIZE) {
          skipSummary.skippedLarge++;
          return { kind: 'skipped' as const };
        }

        // ── T3: Binary file check (non-docs only) ─────────────────
        // Documents bypass binary detection — text-based docs are never
        // binary even if they have unusual byte patterns.
        if (!isDoc && (await isBinaryFile(fullPath))) {
          skipSummary.skippedBinary++;
          return { kind: 'skipped' as const };
        }

        if (isDoc) {
          skipSummary.preservedDocs++;
        }

        return {
          kind: 'kept' as const,
          file: { path: normalizedRel, size: stat.size },
        };
      }),
    );

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled') {
        if (result.value.kind === 'kept') {
          entries.push(result.value.file);
          onProgress?.(processed, filtered.length, result.value.file.path);
        }
      } else {
        onProgress?.(processed, filtered.length, batch[results.indexOf(result)]);
      }
    }
  }

  // ── Log skip summary ───────────────────────────────────────────────
  const totalSkipped =
    skipSummary.skippedVendor +
    skipSummary.skippedBinary +
    skipSummary.skippedLarge +
    skipSummary.skippedLanguage;
  if (totalSkipped > 0) {
    const parts: string[] = [];
    if (skipSummary.skippedVendor > 0) parts.push(`${skipSummary.skippedVendor} vendor`);
    if (skipSummary.skippedBinary > 0) parts.push(`${skipSummary.skippedBinary} binary`);
    if (skipSummary.skippedLarge > 0)
      parts.push(`${skipSummary.skippedLarge} large (>${MAX_FILE_SIZE / 1024}KB)`);
    if (skipSummary.skippedLanguage > 0) parts.push(`${skipSummary.skippedLanguage} language-specific`);
    console.warn(`  Skipped ${totalSkipped} files (${parts.join(', ')})`);
  }
  if (skipSummary.preservedDocs > 0) {
    console.warn(`  Preserved ${skipSummary.preservedDocs} document files (whitelist)`);
  }

  // ── Return based on options ────────────────────────────────────────
  if (options?.returnSkipSummary) {
    return { files: entries, skipSummary };
  }
  return entries;
}

/**
 * Phase 2: Read file contents for a specific set of relative paths.
 * Returns a Map for O(1) lookup. Silently skips files that fail to read.
 */
export const readFileContents = async (
  repoPath: string,
  relativePaths: string[],
): Promise<Map<string, string>> => {
  const contents = new Map<string, string>();

  for (let start = 0; start < relativePaths.length; start += READ_CONCURRENCY) {
    const batch = relativePaths.slice(start, start + READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relativePath) => {
        const fullPath = path.join(repoPath, relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { path: relativePath, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        contents.set(result.value.path, result.value.content);
      }
    }
  }

  return contents;
};

/**
 * Legacy API — scans and reads everything into memory.
 * Used by sequential fallback path only.
 */
export const walkRepository = async (
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<FileEntry[]> => {
  const scanned = await walkRepositoryPaths(repoPath, onProgress);
  const contents = await readFileContents(
    repoPath,
    scanned.map((f) => f.path),
  );
  return scanned
    .filter((f) => contents.has(f.path))
    .map((f) => ({ path: f.path, content: contents.get(f.path)! }));
};
