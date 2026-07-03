/**
 * P2-T3: Evolution Narrator — LLM narrative generation + anti-hallucination validator.
 *
 * This module produces human-readable evolution stories for code symbols by:
 *   1. Building a strict prompt from EvolutionFacts + Chapters
 *   2. Calling the LLM to generate a narrative
 *   3. Validating the output for fabricated commit references
 *
 * Anti-hallucination design:
 *   - The prompt instructs the LLM to cite every claim with [commit:HASH]
 *   - validateNarrative() extracts all [commit:HASH] refs from the output
 *   - Each extracted hash is verified against the known facts
 *   - Unknown hashes are flagged as ValidationIssue { type: 'fabricated_commit' }
 *   - Supports both full (40-char) and abbreviated (7+ char) SHA matching
 *
 * Dependencies:
 *   - EvolutionFacts (from T1: evolution-facts-query.ts)
 *   - Chapter[] (from T2: chapter-detector.ts)
 *   - ILLMClient (from llm/interface.ts)
 *   - EVOLUTION_STORY_PROMPT (from llm/prompts.ts)
 */

import type { EvolutionFacts } from './evolution-facts-query.js';
import type { Chapter } from './chapter-detector.js';
import type { ILLMClient } from '../llm/interface.js';
import { EVOLUTION_STORY_PROMPT } from '../llm/prompts.js';

// ─── Types ────────────────────────────────────────────────────────

/**
 * A validation issue found during anti-hallucination checking.
 */
export interface ValidationIssue {
  /** The type of issue detected. */
  type: 'fabricated_commit';
  /** The commit hash that was flagged. */
  hash: string;
  /** Surrounding text context where the hash was found. */
  context: string;
}

// ─── Constants ────────────────────────────────────────────────────

/**
 * Regex to extract [commit:HASH] references from narrative text.
 * Matches hex hashes of 7-40 characters (abbreviated or full SHA-1).
 */
const COMMIT_REF_REGEX = /\[commit:([a-f0-9]{7,40})\]/gi;

/**
 * Minimum number of facts entries to consider data sufficient for narrative.
 * If both changedIn and evolvedFrom are empty, we return "data insufficient".
 */
const MIN_FACTS_FOR_NARRATIVE = 1;

// ─── Anti-Hallucination Validator ─────────────────────────────────

/**
 * Collect all known commit hashes from an EvolutionFacts object.
 *
 * Gathers hashes from three sources:
 *   - changedIn[].commit — commits that changed the node
 *   - evolvedFrom[].commit — commits in the lineage chain
 *   - authoredBy — (no commit hashes, only author names — skipped)
 *
 * @param facts — the EvolutionFacts to extract hashes from
 * @returns Set of known commit hashes (full and abbreviated forms)
 */
function collectKnownHashes(facts: EvolutionFacts): Set<string> {
  const hashes = new Set<string>();

  for (const c of facts.changedIn) {
    hashes.add(c.commit.toLowerCase());
  }

  for (const e of facts.evolvedFrom) {
    hashes.add(e.commit.toLowerCase());
  }

  return hashes;
}

/**
 * Check if an extracted hash matches any known hash.
 *
 * Supports:
 *   - Exact match (full 40-char or abbreviated)
 *   - Prefix match (abbreviated hash is prefix of full hash)
 *
 * @param hash — the hash extracted from the narrative
 * @param knownHashes — set of known commit hashes
 * @returns true if the hash is known (exact or prefix match)
 */
function isKnownHash(hash: string, knownHashes: Set<string>): boolean {
  const lower = hash.toLowerCase();

  // Exact match
  if (knownHashes.has(lower)) {
    return true;
  }

  // Prefix match: abbreviated hash (7-39 chars) as prefix of a full hash
  if (lower.length < 40) {
    for (const known of knownHashes) {
      if (known.startsWith(lower)) {
        return true;
      }
    }
  }

  // Reverse: full hash from narrative matches abbreviated hash in facts
  for (const known of knownHashes) {
    if (lower.startsWith(known)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract surrounding context for a commit reference.
 *
 * Returns ±50 characters around the [commit:HASH] tag.
 *
 * @param narrative — the full narrative text
 * @param matchIndex — the start index of the match
 * @param matchLength — the length of the full match string
 * @returns context string
 */
function extractContext(
  narrative: string,
  matchIndex: number,
  matchLength: number,
): string {
  const CONTEXT_RADIUS = 50;
  const start = Math.max(0, matchIndex - CONTEXT_RADIUS);
  const end = Math.min(narrative.length, matchIndex + matchLength + CONTEXT_RADIUS);
  return narrative.substring(start, end);
}

/**
 * Validate a generated narrative for fabricated commit references.
 *
 * Extracts all [commit:HASH] references from the narrative and verifies
 * each hash exists in the provided facts. Unknown hashes are flagged
 * as ValidationIssue.
 *
 * @param narrative — the LLM-generated narrative text
 * @param facts — the EvolutionFacts used to generate the narrative
 * @returns array of validation issues (empty if all commits are valid)
 */
export function validateNarrative(
  narrative: string,
  facts: EvolutionFacts,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!narrative || narrative.length === 0) {
    return issues;
  }

  const knownHashes = collectKnownHashes(facts);

  // Reset regex lastIndex (it's a global regex)
  COMMIT_REF_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COMMIT_REF_REGEX.exec(narrative)) !== null) {
    const extractedHash = match[1];
    const fullMatch = match[0];
    const matchIndex = match.index;

    if (!isKnownHash(extractedHash, knownHashes)) {
      issues.push({
        type: 'fabricated_commit',
        hash: extractedHash,
        context: extractContext(narrative, matchIndex, fullMatch.length),
      });
    }
  }

  return issues;
}

// ─── Narrative Generator ──────────────────────────────────────────

/**
 * Build a fallback narrative when LLM is unavailable.
 *
 * Uses only data from facts and chapters — no LLM generation.
 * The fallback is intentionally simple but contains real commit hashes
 * so it passes anti-hallucination validation.
 *
 * @param facts — the EvolutionFacts
 * @param chapters — the detected chapters
 * @returns a factual fallback narrative string
 */
function buildFallbackNarrative(
  facts: EvolutionFacts,
  chapters: Chapter[],
): string {
  const parts: string[] = [];

  // Summary of changes
  if (facts.changedIn.length > 0) {
    const commits = facts.changedIn
      .map((c) => `[commit:${c.commit}]`)
      .join(', ');
    parts.push(`This symbol was modified in ${facts.changedIn.length} commit(s): ${commits}.`);
  }

  if (facts.evolvedFrom.length > 0) {
    const evoCommits = facts.evolvedFrom
      .map((e) => `[commit:${e.commit}]`)
      .join(', ');
    parts.push(`Symbol lineage evolved through ${facts.evolvedFrom.length} transition(s): ${evoCommits}.`);
  }

  // Chapter summaries
  if (chapters.length > 0) {
    const chapterSummary = chapters
      .map((ch) => `${ch.type} (${ch.from.substring(0, 10)} to ${ch.to.substring(0, 10)})`)
      .join('; ');
    parts.push(`Detected phases: ${chapterSummary}.`);
  }

  if (parts.length === 0) {
    return 'No evolution data available for this symbol.';
  }

  return parts.join(' ');
}

/**
 * Check if there is sufficient data to generate a meaningful narrative.
 *
 * @param facts — the EvolutionFacts to check
 * @returns true if at least one source has data
 */
function hasSufficientData(facts: EvolutionFacts): boolean {
  return (
    facts.changedIn.length >= MIN_FACTS_FOR_NARRATIVE ||
    facts.evolvedFrom.length >= MIN_FACTS_FOR_NARRATIVE
  );
}

/**
 * Generate a human-readable evolution narrative for a code symbol.
 *
 * Workflow:
 *   1. Check data sufficiency — if empty, return "data insufficient" message
 *   2. Build the prompt using EVOLUTION_STORY_PROMPT
 *   3. Call the LLM
 *   4. On LLM failure, fall back to a data-only narrative (no hallucination risk)
 *
 * The prompt strictly instructs the LLM:
 *   - Only use facts provided in the prompt
 *   - Cite every claim with [commit:HASH]
 *   - Do not fabricate commit hashes
 *
 * @param facts — aggregated evolution facts (from T1)
 * @param chapters — detected evolution chapters (from T2)
 * @param llmClient — the LLM client to use for generation
 * @returns the narrative text (LLM-generated or fallback)
 */
export async function generateNarrative(
  facts: EvolutionFacts,
  chapters: Chapter[],
  llmClient: ILLMClient,
): Promise<string> {
  // Check data sufficiency
  if (!hasSufficientData(facts)) {
    return 'Insufficient data to generate evolution narrative — no commits or lineage information available.';
  }

  // Build the prompt
  const prompt = EVOLUTION_STORY_PROMPT(facts, chapters);

  try {
    // Call the LLM
    const narrative = await llmClient.generate(prompt);
    return narrative;
  } catch {
    // On LLM failure, return a factual fallback narrative
    // This contains only real data — no hallucination risk
    return buildFallbackNarrative(facts, chapters);
  }
}
