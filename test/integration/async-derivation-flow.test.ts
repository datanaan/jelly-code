/**
 * Integration: runAnalyze with async derivation dispatch.
 * Verifies: main pipeline returns immediately, WikiEntity appears after worker consumes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createStoreSet } from '../../src/store/factory.js';
import { runAnalyze } from '../../src/core/run-analyze.js';
import { WikiService } from '../../src/wiki/service.js';
import { createLLMDerivationHandler } from '../../src/worker/llm-worker.js';
import { createMockLLM } from '../e2e/helpers.js';
import { Worker } from 'bullmq';
import { getRedisConnection } from '../../src/core/redis-connection.js';
import { llmDerivationQueue } from '../../src/core/queue-setup.js';
import { skipE2E, makeTempDir, writeFixtureFile } from '../e2e/helpers.js';
import { rmSync } from 'fs';

describe.skipIf(skipE2E)('Integration: async derivation flow', () => {
  let stores: ReturnType<typeof createStoreSet>;
  let wikiService: WikiService;
  let worker: Worker;
  let fixtureDir: string;
  const pid = `integ-async-${Date.now()}`;

  beforeAll(async () => {
    const config = loadConfig();
    stores = createStoreSet(config);
    wikiService = new WikiService(stores, config.wiki);
    await stores.graph.initializeSchema();

    fixtureDir = makeTempDir('integ-async-');
    writeFixtureFile(fixtureDir, 'src/a.ts', `export function fnA() {}`);
    writeFixtureFile(fixtureDir, 'src/b.ts', `export function fnB() {}`);

    const { execSync } = await import('child_process');
    execSync('git init && git add -A && git commit -m init', { cwd: fixtureDir });

    const mockLlm = createMockLLM({ generateResponse: 'mock-def' });
    worker = new Worker('llm-derivation', createLLMDerivationHandler({
      stores, wikiService, pool: mockLlm, rules: { enabled: true, rules: [], maxEntitiesPerProject: 100 },
    }), { connection: getRedisConnection() });
  }, 60_000);

  afterAll(async () => {
    await worker.close();
    try { await stores.graph.query('MATCH (n) WHERE n.projectId=$pid DETACH DELETE n', { pid }); } catch {}
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
    await stores.close();
  });

  it('main pipeline returns fast; WikiEntity appears within 10s', async () => {
    const start = Date.now();
    await runAnalyze(fixtureDir, pid, stores, { wikiService });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60_000);  // well under old 16-min scenario

    // Poll for WikiEntity
    let count = 0;
    for (let i = 0; i < 20; i++) {
      const rows = await stores.graph.query(
        `MATCH (e:WikiEntity {provenance:'auto-derived'}) WHERE e.projectId=$pid RETURN count(e) AS c`,
        { pid },
      );
      count = Number(rows[0]?.c || 0);
      if (count > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(count).toBeGreaterThan(0);
  }, 90_000);
});
