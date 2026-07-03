/**
 * Unit Tests: Vendor directory detector
 *
 * Tests isVendorDirectory() across three detection layers:
 * 1. Path pattern matching (strong signal, no filesystem access)
 * 2. Package file detection (medium signal, filesystem access)
 * 3. Content heuristics (weak signal, filesystem access)
 *
 * Pure path-pattern tests run in <50ms (no filesystem I/O).
 * Tests with real temp directories (mkdtempSync) run in ~100ms+.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isVendorDirectory, VendorDetectionResult } from '../../src/config/vendor-detector.js';

// Track temp dirs for cleanup
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** Helper: create a temp directory and register for cleanup */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vendor-test-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

describe('vendor-detector', () => {
  describe('Layer 1: Path pattern matching (strong signal)', () => {
    it('recognizes vendor/ by path pattern', async () => {
      const result = await isVendorDirectory('/repo/vendor');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.reason).toBeTruthy();
    });

    it('recognizes node_modules/ by path pattern with high confidence', async () => {
      const result = await isVendorDirectory('/repo/node_modules');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('recognizes nested node_modules/ path', async () => {
      const result = await isVendorDirectory('/repo/sub/node_modules');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('recognizes third_party/ by path pattern', async () => {
      const result = await isVendorDirectory('/repo/third_party');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('recognizes bower_components/ by path pattern', async () => {
      const result = await isVendorDirectory('/repo/bower_components');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('recognizes deps/ by path pattern', async () => {
      const result = await isVendorDirectory('/repo/deps');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('recognizes __pycache__/ by path pattern', async () => {
      const result = await isVendorDirectory('/repo/src/__pycache__');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('recognizes deeply nested vendor directory', async () => {
      const result = await isVendorDirectory('/a/b/c/d/vendor');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('recognizes vendor/ with trailing slash', async () => {
      const result = await isVendorDirectory('/repo/vendor/');
      expect(result.isVendor).toBe(true);
    });
  });

  describe('Layer 1: Non-vendor paths', () => {
    it('does not classify src/ as vendor', async () => {
      const result = await isVendorDirectory('/repo/src');
      expect(result.isVendor).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it('does not classify lib/ as vendor', async () => {
      const result = await isVendorDirectory('/repo/lib');
      expect(result.isVendor).toBe(false);
    });

    it('does not classify app/ as vendor', async () => {
      const result = await isVendorDirectory('/repo/app');
      expect(result.isVendor).toBe(false);
    });

    it('does not classify test/ as vendor', async () => {
      const result = await isVendorDirectory('/repo/test');
      expect(result.isVendor).toBe(false);
    });

    it('does not classify components/ as vendor (app components, not bower)', async () => {
      const result = await isVendorDirectory('/repo/src/components');
      expect(result.isVendor).toBe(false);
    });

    it('does not classify empty root path as vendor', async () => {
      const result = await isVendorDirectory('/');
      expect(result.isVendor).toBe(false);
    });
  });

  describe('Layer 1: Edge cases', () => {
    // I-2 regression tests: null/undefined/empty/whitespace must not throw
    it('handles empty string without throwing', async () => {
      const result = await isVendorDirectory('');
      expect(result.isVendor).toBe(false);
      expect(result.confidence).toBe(0.0);
    });

    it('handles whitespace-only string without throwing', async () => {
      const result = await isVendorDirectory('   ');
      expect(result.isVendor).toBe(false);
      expect(result.confidence).toBe(0.0);
    });

    it('handles undefined without throwing', async () => {
      const result = await isVendorDirectory(undefined as any);
      expect(result.isVendor).toBe(false);
      expect(result.confidence).toBe(0.0);
    });

    it('handles null without throwing', async () => {
      const result = await isVendorDirectory(null as any);
      expect(result.isVendor).toBe(false);
      expect(result.confidence).toBe(0.0);
    });

    it('handles Windows-style backslash paths', async () => {
      const result = await isVendorDirectory('C:\\repo\\node_modules');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('handles relative paths', async () => {
      const result = await isVendorDirectory('./vendor');
      expect(result.isVendor).toBe(true);
    });

    it('is case-insensitive for VENDOR/', async () => {
      const result = await isVendorDirectory('/repo/VENDOR');
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.8);
    });

    it('is case-insensitive for Vendor/', async () => {
      const result = await isVendorDirectory('/repo/Vendor');
      expect(result.isVendor).toBe(true);
    });

    it('is case-insensitive for NODE_MODULES/', async () => {
      const result = await isVendorDirectory('/repo/NODE_MODULES');
      expect(result.isVendor).toBe(true);
    });

    it('does not match vendor-like substrings (e.g. vendortest)', async () => {
      const result = await isVendorDirectory('/repo/vendortest');
      expect(result.isVendor).toBe(false);
    });

    it('does not match node_modules_like', async () => {
      const result = await isVendorDirectory('/repo/node_modules_like');
      expect(result.isVendor).toBe(false);
    });
  });

  describe('Layer 2: Package file detection (filesystem)', () => {
    it('detects directory with package.json in non-root location as potential vendor', async () => {
      // Create a temp repo root with a subdir that has package.json
      // but NOT at the root level
      const repoRoot = makeTempDir('repo');
      const subDir = join(repoRoot, 'nested', 'pkg');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'package.json'), '{"name": "some-dep"}');

      const result = await isVendorDirectory(subDir);
      // Without a strong path pattern, package.json in a non-root dir
      // triggers medium confidence vendor detection
      expect(result.isVendor).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      expect(result.confidence).toBeLessThan(0.9); // medium, not strong
    });

    it('does NOT classify repo root with package.json as vendor', async () => {
      const repoRoot = makeTempDir('repo-root');
      writeFileSync(join(repoRoot, 'package.json'), '{"name": "my-project"}');
      // Also add src/ to make it look like a real project
      mkdirSync(join(repoRoot, 'src'));

      const result = await isVendorDirectory(repoRoot);
      expect(result.isVendor).toBe(false);
    });

    it('detects directory with Cargo.toml as potential vendor in nested path', async () => {
      const repoRoot = makeTempDir('repo');
      const subDir = join(repoRoot, 'vendor', 'rust-lib');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'Cargo.toml'), '[package]\nname = "dep"');

      const result = await isVendorDirectory(subDir);
      expect(result.isVendor).toBe(true);
      // vendor/ path pattern is strong, so confidence should be high
      expect(result.confidence).toBeGreaterThan(0.8);
    });
  });

  describe('Result structure', () => {
    it('returns result with all required fields for vendor path', async () => {
      const result = await isVendorDirectory('/repo/node_modules');
      expect(result).toHaveProperty('isVendor');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('confidence');
      expect(typeof result.isVendor).toBe('boolean');
      expect(typeof result.reason).toBe('string');
      expect(typeof result.confidence).toBe('number');
    });

    it('returns result with all required fields for non-vendor path', async () => {
      const result = await isVendorDirectory('/repo/src');
      expect(result).toHaveProperty('isVendor');
      expect(result).toHaveProperty('reason');
      expect(result).toHaveProperty('confidence');
      expect(typeof result.isVendor).toBe('boolean');
      expect(typeof result.reason).toBe('string');
      expect(typeof result.confidence).toBe('number');
    });

    it('confidence is always between 0.0 and 1.0', async () => {
      const vendorResult = await isVendorDirectory('/repo/node_modules');
      const nonVendorResult = await isVendorDirectory('/repo/src');
      expect(vendorResult.confidence).toBeGreaterThanOrEqual(0.0);
      expect(vendorResult.confidence).toBeLessThanOrEqual(1.0);
      expect(nonVendorResult.confidence).toBeGreaterThanOrEqual(0.0);
      expect(nonVendorResult.confidence).toBeLessThanOrEqual(1.0);
    });

    it('non-vendor result has non-empty reason string', async () => {
      const result = await isVendorDirectory('/repo/src');
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('vendor result has non-empty reason string', async () => {
      const result = await isVendorDirectory('/repo/vendor');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
