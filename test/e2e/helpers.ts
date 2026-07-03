/**
 * Shared E2E Test Helpers
 *
 * Extracts common patterns from p0a-p2 E2E test files:
 *   - RUN_E2E/skipE2E gate variables (unified across all 5 files)
 *   - createMockLLM() factory (p0c & p2 identical code)
 *   - buildStoreSet() factory (p0c & p2 identical code)
 *   - makeTempDir() / writeFixtureFile() (p0a & p0b common pattern)
 */

import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IGraphStore, StoreSet } from '../../src/store/interfaces.js';
import type { ILLMClient } from '../../src/llm/interface.js';
import type { CompileOutput } from '../../src/wiki/models.js';

// ─── E2E Gate ─────────────────────────────────────────────────────
// All E2E test files use the same pattern:
//   describe.skipIf(skipE2E)('...', () => { ... })
// Run with: RUN_E2E=1 npx vitest run

export const RUN_E2E = process.env.RUN_E2E === '1' || process.env.RUN_E2E === 'true';
export const skipE2E = !RUN_E2E;

// ─── Mock LLM Factory ─────────────────────────────────────────────
//
// p0c and p2 each had identical createMockLLM() functions, differing
// only in which method they customise (generate vs generateJSON).
// This unified version supports both via a config object.
//
// Usage:
//   const llm = createMockLLM({ generateJSONResponse: myCompileOutput });
//   const llm = createMockLLM({ generateResponse: 'narrative text' });
//   const llm = createMockLLM(); // defaults: generate='mocked answer', JSON=stub

const STUB_COMPILE_OUTPUT: CompileOutput = {
  title: 'x',
  summary: '',
  keyPoints: [],
  entities: [],
  existingUpdates: [],
  contradictions: [],
};

export function createMockLLM(options?: {
  generateResponse?: string;
  generateJSONResponse?: CompileOutput;
}): ILLMClient {
  const generateResponse = options?.generateResponse ?? 'mocked answer';
  const generateJSONResponse = options?.generateJSONResponse ?? STUB_COMPILE_OUTPUT;

  return {
    generate: vi.fn(async (_prompt: string) => generateResponse),
    generateJSON: vi.fn(async <T>(_prompt: string): Promise<T> => {
      return generateJSONResponse as unknown as T;
    }),
  };
}

// ─── StoreSet Builder ─────────────────────────────────────────────
//
// Builds a StoreSet with real Neo4j graph store but mocked search/vector.
// Used by p0c, p2, and any future E2E test that needs a real graph store.

export function buildStoreSet(graph: IGraphStore, llm: ILLMClient): StoreSet {
  return {
    graph,
    search: {
      search: vi.fn(async () => []),
      indexDocuments: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      ensureCollection: vi.fn(async () => {}),
      deleteDocumentsByFilePath: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    } as never,
    vector: {
      search: vi.fn(async () => []),
      upsertVectors: vi.fn(async () => {}),
      deleteCollection: vi.fn(async () => {}),
      ensureCollection: vi.fn(async () => {}),
      deleteVectorsByNodeIds: vi.fn(async () => 0),
      close: vi.fn(async () => {}),
    } as never,
    llm,
    async close() {
      await graph.close();
    },
  };
}

// ─── Temp Directory Helpers ───────────────────────────────────────
//
// p0a and p0b each have inline make-temp-dir + write-file logic.
// This shared version avoids the code duplication.

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `jelly-${prefix}-`));
}

export function writeFixtureFile(baseDir: string, relPath: string, content: string | Buffer): void {
  const full = join(baseDir, relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}
