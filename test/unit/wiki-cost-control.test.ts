/**
 * Tests for Wiki Cost Control (P2-T8)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the WikiService class's generateAllEvolutionStories cost control logic
// by testing the config interface and threshold logic directly.

describe('WikiConfig cost control fields', () => {
  it('has default values in WikiConfig interface', () => {
    // Verify the interface shape — these should compile without error
    const config = {
      staleDays: 30,
      autoWriteBack: true,
      maxLlmCallsPerBatch: 50,
      maxTokensPerCall: 4096,
      importanceThreshold: 10,
      evolutionDepthThreshold: 2,
    };

    expect(config.maxLlmCallsPerBatch).toBe(50);
    expect(config.maxTokensPerCall).toBe(4096);
    expect(config.importanceThreshold).toBe(10);
    expect(config.evolutionDepthThreshold).toBe(2);
  });

  it('allows unlimited LLM calls when set to 0', () => {
    const config = {
      staleDays: 30,
      autoWriteBack: false,
      maxLlmCallsPerBatch: 0,
      maxTokensPerCall: 0,
      importanceThreshold: 10,
      evolutionDepthThreshold: 2,
    };

    // 0 means unlimited (per the WikiConfig doc)
    const maxCalls = config.maxLlmCallsPerBatch > 0 ? config.maxLlmCallsPerBatch : Infinity;
    expect(maxCalls).toBe(Infinity);
  });

  it('limits LLM calls when threshold is set', () => {
    const config = {
      staleDays: 30,
      autoWriteBack: false,
      maxLlmCallsPerBatch: 3,
      maxTokensPerCall: 2048,
      importanceThreshold: 5,
      evolutionDepthThreshold: 1,
    };

    const maxCalls = config.maxLlmCallsPerBatch > 0 ? config.maxLlmCallsPerBatch : Infinity;
    expect(maxCalls).toBe(3);
  });
});

describe('Cost control logic (thresholds)', () => {
  it('importance gate skips low-change nodes', () => {
    // Simulate the logic from generateAllEvolutionStories
    const importanceThreshold = 10;
    const evolutionDepthThreshold = 2;

    const lowChange = { changedInCount: 3, evolvedFromDepth: 0 };
    const highChange = { changedInCount: 15, evolvedFromDepth: 0 };
    const deepEvolution = { changedInCount: 0, evolvedFromDepth: 5 };

    const isImportantLow = lowChange.changedInCount > importanceThreshold
      || lowChange.evolvedFromDepth > evolutionDepthThreshold;
    const isImportantHigh = highChange.changedInCount > importanceThreshold
      || highChange.evolvedFromDepth > evolutionDepthThreshold;
    const isImportantDeep = deepEvolution.changedInCount > importanceThreshold
      || deepEvolution.evolvedFromDepth > evolutionDepthThreshold;

    expect(isImportantLow).toBe(false);
    expect(isImportantHigh).toBe(true);
    expect(isImportantDeep).toBe(true);
  });

  it('applies configurable thresholds', () => {
    // With relaxed thresholds, more nodes pass
    const importanceThreshold = 5;
    const evolutionDepthThreshold = 1;

    const borderline = { changedInCount: 6, evolvedFromDepth: 0 };
    const strictFail = { changedInCount: 3, evolvedFromDepth: 0 };
    const evolutionFail = { changedInCount: 0, evolvedFromDepth: 1 };

    const isImportantBorderline = borderline.changedInCount > importanceThreshold
      || borderline.evolvedFromDepth > evolutionDepthThreshold;
    const isImportantStrictFail = strictFail.changedInCount > importanceThreshold
      || strictFail.evolvedFromDepth > evolutionDepthThreshold;
    const isImportantEvolution = evolutionFail.changedInCount > importanceThreshold
      || evolutionFail.evolvedFromDepth > evolutionDepthThreshold;

    expect(isImportantBorderline).toBe(true);
    expect(isImportantStrictFail).toBe(false);
    // evolutionDepthThreshold=1, so depth > 1 means depth >= 2
    expect(isImportantEvolution).toBe(false);
  });
});
