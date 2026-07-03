/**
 * Ignore service.
 *
 * Provides file filtering based on .gitignore and common exclusion patterns.
 * Used by the filesystem walker to skip irrelevant files during indexing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** UTF-8 Byte Order Mark */
const UTF8_BOM = '\uFEFF';

/** Default patterns to always ignore */
export const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.venv',
  'venv',
  '.env',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.idea',
  '.vscode',
  '.vs',
  '*.pyc',
  '*.pyo',
  '*.so',
  '*.dll',
  '*.exe',
  '*.o',
  '*.a',
  '*.class',
  '*.jar',
  '*.war',
  '*.min.js',
  '*.min.css',
  '*.map',
  '.DS_Store',
  'Thumbs.db',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.env.local',
  '.env.production',
];

export interface IgnoreFilter {
  /** Test if a file path should be ignored */
  test: (filePath: string) => boolean;
}

/**
 * Read and parse `.jellyignore` from the repository root.
 *
 * The `.jellyignore` file follows the same conventions as `.gitignore` for
 * comments (`#` prefix) but is evaluated with **highest priority** — patterns
 * here override all other ignore sources (defaults, .gitignore).
 *
 * Parsing rules:
 * - UTF-8 encoding (BOM stripped if present)
 * - `#` at start of line (after optional whitespace) → full-line comment, skipped
 * - Inline comments: ` #` (space-hash) → everything from ` #` onward stripped
 * - Empty and whitespace-only lines skipped
 * - CRLF (`\r\n`) and LF (`\n`) line endings handled
 * - Leading and trailing whitespace on each pattern stripped
 *
 * @param repoRoot Absolute path to the repository root
 * @returns Array of glob patterns (empty array if file missing)
 */
export async function readJellyignore(repoRoot: string): Promise<string[]> {
  const jellyignorePath = join(repoRoot, '.jellyignore');

  if (!existsSync(jellyignorePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(jellyignorePath, 'utf-8');
  } catch {
    // If we can't read it, treat as empty (no patterns)
    return [];
  }

  // Strip UTF-8 BOM if present
  if (content.startsWith(UTF8_BOM)) {
    content = content.slice(1);
  }

  // Normalize CRLF to LF, then split
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  const patterns: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine.trim();

    // Skip empty and whitespace-only lines
    if (line.trim().length === 0) {
      continue;
    }

    // Skip full-line comments (line starts with # after optional leading whitespace)
    const trimmedForComment = line.trimStart();
    if (trimmedForComment.startsWith('#')) {
      continue;
    }

    // Handle inline comments: strip from " #" (space-hash) onward.
    // A hash without a preceding space is part of the pattern (e.g. "file#1.tmp").
    const commentIdx = line.indexOf(' #');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx).trimEnd();
    }

    // Pattern may have already been emptied by inline comment stripping
    if (line.length === 0) {
      continue;
    }

    patterns.push(line);
  }

  return patterns;
}

/**
 * Create an ignore filter for the given repository root.
 * Reads .gitignore if present and combines with default patterns.
 */
export function createIgnoreFilter(repoRoot: string): IgnoreFilter {
  const patterns = [...DEFAULT_IGNORE_PATTERNS];

  // Read .gitignore if present
  const gitignorePath = join(repoRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      const gitignorePatterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      patterns.push(...gitignorePatterns);
    } catch {
      // Ignore errors reading .gitignore
    }
  }

  // Build a simple matcher: convert glob patterns to regex-like checks
  const regexes = patterns.map(pattern => {
    // Normalize pattern
    let p = pattern.replace(/^\//, ''); // Remove leading slash
    if (p.endsWith('/')) p = p.slice(0, -1); // Remove trailing slash

    // Simple glob-to-regex conversion
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    return new RegExp(`(^|/)${escaped}(/|$)`);
  });

  return {
    test(filePath: string): boolean {
      // Normalize path separators
      const normalized = filePath.replace(/\\/g, '/');
      return regexes.some(regex => regex.test(normalized));
    },
  };
}
