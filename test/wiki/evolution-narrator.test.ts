/**
 * P2-T3: Evolution Narrator — LLM narrative generation + anti-hallucination validator.
 *
 * Tests two exported functions:
 *   - validateNarrative(narrative, facts): ValidationIssue[]
 *     Extracts [commit:HASH] refs from the narrative and verifies every
 *     hash exists in the facts object.
 *   - generateNarrative(facts, chapters, llmClient): Promise<string>
 *     Builds a strict prompt and calls the LLM, returning the narrative text.
 *
 * Anti-hallucination strategy:
 *   1. Extract /\[commit:([a-f0-9]{7,40})\]/g from the narrative
 *   2. For each extracted hash, check it exists in facts (changedIn, evolvedFrom, authoredBy)
 *   3. Support both full (40 char) and abbreviated (7+ char) SHA matching
 *   4. Flag any unknown hash as ValidationIssue { type: 'fabricated_commit', hash, context }
 */

import { describe, it, expect } from 'vitest';
import {
  validateNarrative,
  generateNarrative,
  type ValidationIssue,
} from '../../src/wiki/evolution-narrator.js';
import { EVOLUTION_STORY_PROMPT } from '../../src/llm/prompts.js';
import type { EvolutionFacts } from '../../src/wiki/evolution-facts-query.js';
import type { Chapter } from '../../src/wiki/chapter-detector.js';
import type { ILLMClient } from '../../src/llm/interface.js';

// ==========================================
// Helpers
// ==========================================

/** Build a minimal EvolutionFacts with the given commits. */
function factsWithCommits(
  commits: string[],
  extra: Partial<EvolutionFacts> = {},
): EvolutionFacts {
  return {
    nodeId: 'test-node',
    evolvedFrom: [],
    changedIn: commits.map((hash, i) => ({
      commit: hash,
      timestamp: `2024-0${1 + (i % 9)}-15T10:00:00Z`,
      additions: 10 + i,
      deletions: 5 + i,
      author: `author-${i}`,
    })),
    authoredBy: [],
    coChangedWith: [],
    changeTimeline: [],
    ...extra,
  };
}

/** Build a minimal EvolutionFacts with evolvedFrom commits. */
function factsWithEvolvedFrom(commits: string[]): EvolutionFacts {
  return {
    nodeId: 'test-node',
    evolvedFrom: commits.map((hash, i) => ({
      from: `node-v${i}`,
      to: `node-v${i - 1}`,
      commit: hash,
      timestamp: `2024-0${1 + i}-15T10:00:00Z`,
    })),
    changedIn: [],
    authoredBy: [],
    coChangedWith: [],
    changeTimeline: [],
  };
}

/** Build an empty facts object (no data). */
function emptyFacts(): EvolutionFacts {
  return {
    nodeId: 'test-node',
    evolvedFrom: [],
    changedIn: [],
    authoredBy: [],
    coChangedWith: [],
    changeTimeline: [],
  };
}

/** Build minimal chapters for generateNarrative tests. */
function simpleChapters(): Chapter[] {
  return [
    {
      type: 'founding',
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-05T00:00:00Z',
      keyCommits: ['abc1234'],
      description: 'Initial creation.',
    },
  ];
}

/** Build a mock ILLMClient with a canned response. */
function mockLLM(response: string): ILLMClient {
  return {
    generate: async () => response,
    generateJSON: async () => ({}),
  };
}

/** Build a mock ILLMClient that throws. */
function failingLLM(error: Error): ILLMClient {
  return {
    generate: async () => {
      throw error;
    },
    generateJSON: async () => {
      throw error;
    },
  };
}

// ==========================================
// Tests
// ==========================================

describe('EVOLUTION_STORY_PROMPT', () => {
  it('exists as an exported function from prompts.ts', () => {
    expect(EVOLUTION_STORY_PROMPT).toBeDefined();
    expect(typeof EVOLUTION_STORY_PROMPT).toBe('function');
  });

  it('produces a prompt string containing anti-hallucination instructions', () => {
    const prompt = EVOLUTION_STORY_PROMPT(
      factsWithCommits(['abcdef1234567890']),
      simpleChapters(),
    );
    expect(typeof prompt).toBe('string');
    // Must instruct the LLM to cite with [commit:HASH]
    expect(prompt).toContain('[commit:');
    // Must instruct not to fabricate
    expect(prompt.toLowerCase()).toMatch(/fabricat|hallucinat|only.*fact|不要编造|仅.*事实/);
  });
});

describe('validateNarrative', () => {
  it('passes when narrative references real commits from changedIn', () => {
    const facts = factsWithCommits(['abcdef1234567890abcdef1234567890abcdef12']);
    const narrative =
      'The symbol was initially created [commit:abcdef1234567890abcdef1234567890abcdef12].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('catches fabricated commits not in facts', () => {
    const facts = factsWithCommits(['1a2b3c4d5e6f7a8b']);
    const narrative = 'Some change was made [commit:deadbeef0000].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('fabricated_commit');
    expect(issues[0].hash).toBe('deadbeef0000');
  });

  it('catches partially-fabricated commits (mix of real + fake)', () => {
    const facts = factsWithCommits(['1a2b3c4d5e6f7a8b']);
    const narrative =
      'First change [commit:1a2b3c4d5e6f7a8b] then later [commit:0badf00d00000].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toHaveLength(1);
    expect(issues[0].hash).toBe('0badf00d00000');
    expect(issues[0].type).toBe('fabricated_commit');
  });

  it('handles empty narrative (no issues)', () => {
    const facts = factsWithCommits(['abcdef1234']);
    const narrative = '';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('handles narrative with no commit references', () => {
    const facts = factsWithCommits(['abcdef1234']);
    const narrative = 'This symbol was created at some point in history.';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('extracts and validates multiple commit references', () => {
    const facts = factsWithCommits([
      'aaa1111',
      'bbb2222',
      'ccc3333',
    ]);
    const narrative =
      'Started with [commit:aaa1111], then refined [commit:bbb2222], finally [commit:ccc3333].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('flags multiple unknown commits when multiple are fabricated', () => {
    const facts = factsWithCommits(['1a2b3c4d5e6f']);
    const narrative =
      'Changed [commit:1a2b3c4d5e6f] and [commit:0badf00d000] and [commit:feedface000].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toHaveLength(2);
    const hashes = issues.map((i) => i.hash);
    expect(hashes).toContain('0badf00d000');
    expect(hashes).toContain('feedface000');
  });

  it('handles abbreviated 7-char hashes', () => {
    const facts = factsWithCommits(['abcdef0']);
    const narrative = 'Created [commit:abcdef0].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('validates commits from evolvedFrom chain', () => {
    const facts = factsWithEvolvedFrom(['e0a1b2c3d4']);
    const narrative = 'Renamed from old symbol [commit:e0a1b2c3d4].';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });

  it('includes context in the ValidationIssue', () => {
    const facts = factsWithCommits(['1a2b3c4d5e']);
    const narrative = 'A big change happened [commit:ffffffffff] in the module.';

    const issues = validateNarrative(narrative, facts);

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('fabricated_commit');
    expect(issues[0].hash).toBe('ffffffffff');
    expect(issues[0].context).toContain('ffffffffff');
  });

  it('matches abbreviated hash as prefix of full hash in facts', () => {
    const fullHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const facts = factsWithCommits([fullHash]);
    const narrative = `Refactored in [commit:a1b2c3d].`;

    const issues = validateNarrative(narrative, facts);

    expect(issues).toEqual([]);
  });
});

describe('generateNarrative', () => {
  it('calls LLM with EVOLUTION_STORY_PROMPT', async () => {
    const facts = factsWithCommits(['abcdef1234567890']);
    const chapters = simpleChapters();
    let capturedPrompt = '';
    const llm: ILLMClient = {
      generate: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'A narrative response.';
      },
      generateJSON: async () => ({}),
    };

    await generateNarrative(facts, chapters, llm);

    // The prompt should contain key elements from EVOLUTION_STORY_PROMPT
    expect(capturedPrompt).toContain('[commit:');
    expect(capturedPrompt).toContain('abcdef1234567890');
  });

  it('returns the LLM response as the narrative', async () => {
    const facts = factsWithCommits(['abcdef1234567890']);
    const chapters = simpleChapters();
    const cannedResponse = 'This symbol had a rich evolution history.';
    const llm = mockLLM(cannedResponse);

    const result = await generateNarrative(facts, chapters, llm);

    expect(result).toBe(cannedResponse);
  });

  it('includes commit refs in output (mock LLM returns canned with refs)', async () => {
    const facts = factsWithCommits(['abcdef1234567890']);
    const chapters = simpleChapters();
    const cannedResponse = 'Created [commit:abcdef1234567890] by author-0.';
    const llm = mockLLM(cannedResponse);

    const result = await generateNarrative(facts, chapters, llm);

    expect(result).toContain('[commit:abcdef1234567890]');
    // Verify the result passes validation
    const issues = validateNarrative(result, facts);
    expect(issues).toEqual([]);
  });

  it('handles LLM failure gracefully with fallback narrative', async () => {
    const facts = factsWithCommits(['abcdef1234567890']);
    const chapters = simpleChapters();
    const llm = failingLLM(new Error('LLM service unavailable'));

    const result = await generateNarrative(facts, chapters, llm);

    // Should return a fallback, not throw
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Fallback should still contain real commit refs
    expect(result).toContain('abcdef1234567890');
  });

  it('returns "data insufficient" message for empty facts', async () => {
    const facts = emptyFacts();
    const chapters: Chapter[] = [];
    const llm = mockLLM('should not be used');

    const result = await generateNarrative(facts, chapters, llm);

    expect(result).toMatch(/insufficient|no.*data|无.*数据/i);
  });

  it('includes chapter information in the prompt sent to LLM', async () => {
    const facts = factsWithCommits(['abcdef1234567890']);
    const chapters: Chapter[] = [
      {
        type: 'founding',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-10T00:00:00Z',
        keyCommits: ['abcdef1234567890'],
        description: 'Initial creation with 3 commits.',
      },
      {
        type: 'growth',
        from: '2024-03-01T00:00:00Z',
        to: '2024-03-15T00:00:00Z',
        keyCommits: ['growth123'],
        description: 'Rapid feature development.',
      },
    ];
    let capturedPrompt = '';
    const llm: ILLMClient = {
      generate: async (prompt: string) => {
        capturedPrompt = prompt;
        return 'A narrative.';
      },
      generateJSON: async () => ({}),
    };

    await generateNarrative(facts, chapters, llm);

    expect(capturedPrompt).toContain('founding');
    expect(capturedPrompt).toContain('growth');
    expect(capturedPrompt).toContain('Initial creation');
  });
});
