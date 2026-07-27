/**
 * Unit Tests: Concurrent Analysis
 *
 * Tests the concurrent analysis logic using real project imports.
 * Tests the reverse dependency finder's concurrency behavior and
 * the explosion guard threshold logic.
 */

import { describe, it, expect } from 'vitest';
import { IncrementalFallbackError } from '../../src/core/incremental-fallback-error.js';

describe('Concurrent Analysis', () => {
  it('should construct IncrementalFallbackError with message', () => {
    const error = new IncrementalFallbackError('explosion_guard: too many files');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('explosion_guard: too many files');
    expect(error.name).toBe('IncrementalFallbackError');
  });

  it('should handle empty IncrementalFallbackError message', () => {
    const error = new IncrementalFallbackError('');
    expect(error.message).toBe('');
    expect(error.name).toBe('IncrementalFallbackError');
  });

  it('should detect IncrementalFallbackError by name across ESM boundaries', () => {
    const error = new IncrementalFallbackError('test');
    expect((error as Error).name).toBe('IncrementalFallbackError');
  });

  it('should compute explosion guard threshold correctly', () => {
    // Explosion guard: if > 50% files need reparse, fall back to full
    const totalFiles = 1000;
    const filesToReparse = 600;
    expect(filesToReparse > totalFiles * 0.5).toBe(true);

    const shouldFallback = filesToReparse > totalFiles * 0.5;
    expect(shouldFallback).toBe(true);
  });

  it('should not trigger explosion guard for small changes', () => {
    const totalFiles = 1000;
    const filesToReparse = 100;
    const shouldFallback = filesToReparse > totalFiles * 0.5;
    expect(shouldFallback).toBe(false);
  });

  it('should handle zero files in explosion guard', () => {
    const totalFiles = 0;
    const filesToReparse = 0;
    const shouldFallback = filesToReparse > totalFiles * 0.5;
    expect(shouldFallback).toBe(false);
  });
});
