/**
 * Document classifier (P0b-T1)
 *
 * Given a file path, determine whether the file is a document suitable for
 * Wiki ingestion. Uses a three-layer detection strategy with confidence
 * scoring:
 *
 * 1. **Extension layer** (strong, confidence=1.0) — Files with known document
 *    extensions (`.md`, `.rst`, `.adoc`, `.org`, `.markdown`) are documents.
 *    This layer short-circuits: if the extension matches, no further checks
 *    are needed.
 *
 * 2. **Path/filename layer** (medium, confidence=0.9) — Files with well-known
 *    document basenames (`README`, `CHANGELOG`, `LICENSE`, etc.) and no
 *    extension, OR files located inside known documentation directories
 *    (`docs/`, `doc/`, `documentation/`).
 *
 * 3. **Content heuristics** (weak, confidence=0.7) — For files with ambiguous
 *    extensions (currently only `.txt`), peek at the first 1KB of content and
 *    look for markdown markers (headings `#`, bullet lists `-`/`*`, fenced
 *    code blocks ```).
 *
 * Design note: This is a more sophisticated successor to P0a-T6's simpler
 * `isDocumentFile()` in `src/core/ingestion/filesystem-walker.ts`. That
 * function returns a boolean; this one returns a structured result with
 * confidence and source attribution for richer downstream decisions.
 *
 * `.txt` is deliberately excluded from the extension layer — it is ambiguous
 * (could be config, data, logs, or markdown) and requires content inspection.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, basename, dirname } from 'node:path';

/**
 * Document extensions recognized by the extension layer (Layer 1).
 * Files with these extensions are documents with confidence=1.0.
 *
 * Note: `.txt` is intentionally excluded — it goes through the content
 * heuristics layer (Layer 3) because `.txt` is ambiguous.
 */
export const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.rst',
  '.adoc',
  '.org',
  '.markdown',
]);

/**
 * Well-known document filenames (case-insensitive, no extension).
 * Files matching these names with no extension are documents with
 * confidence=0.9.
 */
const DOC_FILENAMES: ReadonlySet<string> = new Set([
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
 * Directory names that indicate documentation context.
 * Files inside these directories (at any nesting level) are classified
 * as documents with confidence=0.9.
 */
const DOC_DIRECTORIES: ReadonlySet<string> = new Set([
  'docs',
  'doc',
  'documentation',
]);

/** Maximum bytes to read for content heuristics (Layer 3). */
const CONTENT_PEEK_BYTES = 1024;

/**
 * Result of document classification.
 */
export interface ClassificationResult {
  /** Whether the file is classified as a document */
  isDoc: boolean;
  /**
   * Confidence score in [0, 1]:
   * - 1.0 = extension match (strongest)
   * - 0.9 = path/filename match
   * - 0.7 = content heuristics match
   * - 0.0 = not a document
   */
  confidence: number;
  /** Human-readable reason for the classification */
  reason: string;
  /** Which layer made the determination: 'extension' | 'path' | 'content' | 'none' */
  source: 'extension' | 'path' | 'content' | 'none';
}

/**
 * Classify whether a file is a document suitable for Wiki ingestion.
 *
 * Uses a three-layer detection strategy (see module JSDoc for details):
 * 1. Extension match (confidence=1.0) — short-circuits remaining layers
 * 2. Path/filename match (confidence=0.9)
 * 3. Content heuristics for `.txt` files (confidence=0.7)
 *
 * The function is async because Layer 3 may read file content from disk.
 * Layers 1 and 2 involve no I/O and resolve immediately.
 *
 * @param filePath - Relative or absolute file path to classify
 * @returns Classification result with `isDoc`, `confidence`, `reason`, and `source`
 */
export async function classifyFile(filePath: string): Promise<ClassificationResult> {
  // Guard: empty or whitespace-only path
  if (!filePath || filePath.trim() === '') {
    return notDoc('empty or whitespace-only path');
  }

  const ext = extname(filePath).toLowerCase();

  // --- Layer 1: Extension match (strongest, confidence=1.0) ---
  if (DOC_EXTENSIONS.has(ext)) {
    return {
      isDoc: true,
      confidence: 1.0,
      reason: `document extension '${ext}'`,
      source: 'extension',
    };
  }

  // --- Layer 2: Path/filename match (confidence=0.9) ---
  // 2a: Filename match (only for files without extension)
  if (ext === '') {
    const base = basename(filePath).toUpperCase();
    if (DOC_FILENAMES.has(base)) {
      return {
        isDoc: true,
        confidence: 0.9,
        reason: `known document filename '${base}'`,
        source: 'path',
      };
    }
  }

  // 2b: Documentation directory match
  if (isInDocDirectory(filePath)) {
    return {
      isDoc: true,
      confidence: 0.9,
      reason: `file in documentation directory`,
      source: 'path',
    };
  }

  // --- Layer 3: Content heuristics (weakest, confidence=0.7) ---
  // Only applies to .txt files (ambiguous extension).
  if (ext === '.txt') {
    const score = markdownScore(filePath);
    if (score >= 1.0) {
      return {
        isDoc: true,
        confidence: 0.7,
        reason: `content markdown score ${score.toFixed(1)} >= 1.0`,
        source: 'content',
      };
    }
  }

  return notDoc(`no document indicators (ext='${ext || 'none'}')`);
}

/**
 * Check if a file path resides inside a known documentation directory.
 * Checks if any path segment matches a documentation directory name.
 */
function isInDocDirectory(filePath: string): boolean {
  const dir = dirname(filePath);
  if (dir === '.' || dir === '/' || dir === '') {
    return false;
  }
  const segments = dir.split(/[/\\]/);
  return segments.some(
    (seg) => seg.length > 0 && DOC_DIRECTORIES.has(seg.toLowerCase()),
  );
}

/**
 * Score markdown markers in the first 1KB of a file.
 *
 * Returns a weighted score where:
 * - Strong markers (headings, code blocks, links) each add 1.0
 * - Weak markers (bullet lists, numbered lists, blockquotes) each add 0.5
 *
 * A score >= 1.0 indicates the file is likely markdown content.
 * Returns 0 if the file doesn't exist, can't be read, or has no markers.
 */
function markdownScore(filePath: string): number {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return 0;
    }
    const raw = readFileSync(filePath, {
      encoding: 'utf8',
      flag: 'r',
    });
    // Strip UTF-8 BOM if present — a leading BOM would break line-anchored
    // regexes (e.g. /^#{1,6}\s/m) by prepending a zero-width char to the
    // first line.
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const content = stripped.slice(0, CONTENT_PEEK_BYTES);

    let score = 0;

    // --- Strong markers (weight=1.0 each) ---

    // Markdown headings: lines starting with 1-6 '#' characters + space
    if (/^#{1,6}\s/m.test(content)) score += 1.0;

    // Fenced code blocks: ``` or ~~~
    if (/^(`{3,}|~{3,})/m.test(content)) score += 1.0;

    // Inline links: [text](url)
    if (/\[.+?\]\(.+?\)/.test(content)) score += 1.0;

    // --- Weak markers (weight=0.5 each) ---

    // Bullet lists: lines starting with - or * followed by space
    if (/^[-*]\s/m.test(content)) score += 0.5;

    // Numbered lists: lines starting with digit + . + space
    if (/^\d+\.\s/m.test(content)) score += 0.5;

    // Blockquotes: lines starting with >
    if (/^>\s/m.test(content)) score += 0.5;

    return score;
  } catch {
    return 0;
  }
}

/** Helper: build a not-document result */
function notDoc(reason: string): ClassificationResult {
  return {
    isDoc: false,
    confidence: 0.0,
    reason,
    source: 'none',
  };
}
