/**
 * Binary file detector
 *
 * Determines whether a file is likely binary (non-text) and should be
 * skipped during code indexing.
 *
 * Uses a four-layer detection strategy:
 * 1. Extension check (fastest, no I/O) — matches known binary extensions
 * 2. Magic bytes check — reads first 8 bytes and matches known file signatures
 * 3. NULL byte heuristic — if first 8KB contains >30% NULL bytes, likely binary
 * 4. UTF-8 decode check — attempts to decode content as UTF-8; failure implies binary
 *
 * Used by the filesystem walker (T5 integration) to skip binary files early,
 * avoiding pointless I/O and tokenization attempts on non-text content.
 *
 * Design decisions:
 * - Always returns `Promise<boolean>` for uniform caller code, even though
 *   extension-only checks could be synchronous.
 * - Non-existent files return `false` (not throw) so the walker can skip
 *   gracefully without crash recovery.
 * - Reads at most 8KB of file content for layers 2-4 to bound I/O cost.
 */

import { extname } from 'node:path';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * Known binary file extensions.
 *
 * Includes:
 * - Native libraries: .so, .dll, .dylib, .a, .lib
 * - Executables: .exe, .app, .msi
 * - Object files: .o, .obj, .pdb
 * - Java compiled: .class, .jar, .war
 * - Python compiled: .pyc, .pyo, .pyd
 * - Archives: .zip, .tar, .gz, .bz2, .7z, .rar, .xz
 * - Media: .png, .jpg, .jpeg, .gif, .bmp, .ico, .webp, .tiff, .wav, .mp3, .mp4, .avi, .mov, .webm
 * - Fonts: .woff, .woff2, .ttf, .otf, .eot
 * - Documents: .pdf, .doc, .docx, .xls, .xlsx, .ppt, .pptx
 * - Data: .dat, .bin, .db, .sqlite, .mdb
 * - Other: .wasm, .pak, .dex
 */
export const BINARY_EXTENSIONS: readonly string[] = [
  // Native libraries and object files
  '.so',
  '.dll',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.pdb',
  // Executables
  '.exe',
  '.app',
  '.msi',
  '.com',
  '.bat', // Technically text (batch script) but intentionally excluded from indexing as a skip heuristic.
  // Java compiled
  '.class',
  '.jar',
  '.war',
  '.ear',
  // Python compiled
  '.pyc',
  '.pyo',
  '.pyd',
  // Archives
  '.zip',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.tar',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  '.svgz',
  '.heic',
  // Audio/Video
  '.wav',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.webm',
  '.mkv',
  '.flv',
  '.ogg',
  '.flac',
  '.aac',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Documents (binary formats)
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Data
  '.dat',
  '.bin',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  // Other binary
  '.wasm',
  '.pak',
  '.dex',
  '.nib',
  '.swf',
] as const;

/**
 * Known magic byte signatures for binary file types.
 * Each entry is a prefix that, if matched, definitively identifies the file as binary.
 */
const MAGIC_BYTES: ReadonlyArray<{ bytes: number[]; label: string }> = [
  // ELF (Linux/Unix executable/library)
  { bytes: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF' },
  // PE (Windows executable/DLL) — "MZ" header
  { bytes: [0x4d, 0x5a], label: 'PE' },
  // Mach-O 32-bit (little-endian)
  { bytes: [0xce, 0xfa, 0xed, 0xfe], label: 'Mach-O 32 LE' },
  // Mach-O 64-bit (little-endian)
  { bytes: [0xcf, 0xfa, 0xed, 0xfe], label: 'Mach-O 64 LE' },
  // Mach-O (big-endian)
  { bytes: [0xfe, 0xed, 0xfa, 0xce], label: 'Mach-O BE' },
  // Mach-O 64 (big-endian)
  { bytes: [0xfe, 0xed, 0xfa, 0xcf], label: 'Mach-O 64 BE' },
  // Java class file
  { bytes: [0xca, 0xfe, 0xba, 0xbe], label: 'Java class' },
  // ZIP / JAR / Office Open XML / EPUB
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP' },
  // Empty ZIP
  { bytes: [0x50, 0x4b, 0x05, 0x06], label: 'ZIP (empty)' },
  // RAR
  { bytes: [0x52, 0x61, 0x72, 0x21], label: 'RAR' },
  // 7z
  { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7z' },
  // PDF
  { bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  // PNG
  { bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
  // JPEG (JFIF)
  { bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
  // GIF
  { bytes: [0x47, 0x49, 0x46, 0x38], label: 'GIF' },
  // BMP
  { bytes: [0x42, 0x4d], label: 'BMP' },
  // WebP (RIFF....WEBP)
  { bytes: [0x52, 0x49, 0x46, 0x46], label: 'RIFF (WebP/AVI)' },
  // ICO
  { bytes: [0x00, 0x00, 0x01, 0x00], label: 'ICO' },
  // Wasm
  { bytes: [0x00, 0x61, 0x73, 0x6d], label: 'WebAssembly' },
  // Compiled Python (.pyc) — Python 3.x magic varies, but starts with 0x42 0x0d 0x0d 0x0a for 3.7+
  { bytes: [0x42, 0x0d, 0x0d, 0x0a], label: 'Python bytecode (3.7+)' },
] as const;

/**
 * Maximum number of bytes to read from file for content-based checks.
 * 8KB is enough for magic bytes + NULL heuristic + UTF-8 validity.
 */
const MAX_READ_BYTES = 8192;

/**
 * NULL byte ratio threshold. If the first chunk contains more than this
 * ratio of NULL bytes, it is classified as binary.
 *
 * 0.30 (30%) is the standard heuristic used by git and other tools.
 */
const NULL_BYTE_THRESHOLD = 0.30;

/**
 * Check if the file extension is a known binary extension.
 * Comparison is case-insensitive.
 */
function hasBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (!ext) {
    return false;
  }
  return BINARY_EXTENSIONS.includes(ext);
}

/**
 * Check if the file content starts with a known magic byte signature.
 */
function matchesMagicBytes(buffer: Buffer): boolean {
  for (const sig of MAGIC_BYTES) {
    if (buffer.length < sig.bytes.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate the ratio of NULL bytes in the buffer.
 * Returns a value between 0.0 and 1.0.
 */
function nullByteRatio(buffer: Buffer): number {
  if (buffer.length === 0) {
    return 0;
  }
  let nullCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x00) {
      nullCount++;
    }
  }
  return nullCount / buffer.length;
}

/**
 * Check if the buffer contains valid UTF-8 by attempting to decode it.
 * If decoding fails, the content is likely binary.
 *
 * Uses Node.js TextDecoder with the 'utf-8' encoding and the fatal: true
 * option so that invalid byte sequences cause an error instead of
 * silent replacement characters.
 */
function isValidUtf8(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether the given file is binary (non-text content).
 *
 * Uses a four-layer strategy, checking from fastest to slowest:
 *
 * **Layer 1 (Extension — fastest, no I/O):**
 * Checks the file extension against a list of known binary extensions
 * (.so, .dll, .exe, .class, .pyc, .jar, etc.). This is instantaneous
 * and covers the vast majority of binary files.
 *
 * **Layer 2 (Magic Bytes — one read):**
 * Reads the first 8 bytes and checks against known file signatures
 * (ELF, PE, Mach-O, Java class, ZIP, etc.). Catches binary files
 * with unknown or missing extensions.
 *
 * **Layer 3 (NULL Byte Heuristic):**
 * Checks the ratio of NULL bytes in the first 8KB. If more than 30%
 * are NULLs, the file is likely binary. This catches proprietary
 * binary formats not covered by magic bytes.
 *
 * **Layer 4 (UTF-8 Decode Check):**
 * Attempts to decode the content as UTF-8. If decoding fails, the
 * file is classified as binary.
 *
 * @param filePath - Absolute or relative path to the file
 * @returns `true` if the file is binary, `false` otherwise.
 *          Non-existent files return `false` (no throw) so callers
 *          can skip gracefully.
 *
 * @example
 * ```typescript
 * if (await isBinaryFile('/path/to/file')) {
 *   skipIndexing();
 * }
 * ```
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  // Input validation — guard against null/undefined/non-string
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }

  // Layer 1: Extension check (fastest, no I/O)
  if (hasBinaryExtension(filePath)) {
    return true;
  }

  // Layers 2-4: Content-based checks (require filesystem I/O)
  let fileHandle: FileHandle | undefined;
  try {
    fileHandle = await open(filePath, 'r');
    // Read at most MAX_READ_BYTES for all content checks.
    // Destructure bytesRead directly from read() — avoids an extra stat() syscall.
    const { buffer, bytesRead } = await fileHandle.read(
      Buffer.alloc(MAX_READ_BYTES),
      0,
      MAX_READ_BYTES,
      0,
    );

    if (bytesRead === 0) {
      return false; // Empty file is not binary
    }

    // Use only the actual bytes read
    const content = buffer.subarray(0, bytesRead);

    // Layer 2: Magic bytes check
    if (matchesMagicBytes(content)) {
      return true;
    }

    // Layer 3: NULL byte heuristic
    if (nullByteRatio(content) > NULL_BYTE_THRESHOLD) {
      return true;
    }

    // Layer 4: UTF-8 decode check
    if (!isValidUtf8(content)) {
      return true;
    }

    return false;
  } catch {
    // File doesn't exist, permission denied, or other I/O error.
    // Return false so the walker can skip gracefully.
    return false;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}
