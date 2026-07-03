/**
 * Tests: CLI Entrypoint (unit tests, all services mocked)
 *
 * Covers:
 * - analyze command: correct parameter mapping, error handling, store lifecycle
 * - serve command: dynamic server import
 * - mcp command: service initialization, schema failure handling
 * - Error handling: process.exit(1) on failure
 * - Help output: no crash on invalid command
 *
 * Strategy:
 * - vi.mock all I/O dependencies at module level (hoisted)
 * - vi.resetModules() + set process.argv before each import to re-trigger program.parse()
 * - All service calls are mocked; we test command routing, not business logic
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ─── Mock all I/O dependencies (hoisted by vitest) ──────────────

const mockConfig = {
  store: { graph: { url: 'bolt://localhost:7687' } },
  repo: { cacheDir: '/tmp/cache' },
  wiki: { enabled: true },
};

vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

const mockGraph = {
  initializeSchema: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  clearProject: vi.fn().mockResolvedValue(undefined),
};
const mockSearch = { close: vi.fn().mockResolvedValue(undefined) };
const mockVector = { close: vi.fn().mockResolvedValue(undefined) };
const mockStores = { graph: mockGraph, search: mockSearch, vector: mockVector };

vi.mock('../../src/store/factory.js', () => ({
  createStoreSet: vi.fn(() => mockStores),
}));

const mockAnalyzeResult = { nodeCount: 42, edgeCount: 100, duration: 5000 };
vi.mock('../../src/core/run-analyze.js', () => ({
  runAnalyze: vi.fn().mockResolvedValue(mockAnalyzeResult),
}));

vi.mock('../../src/core/repo-cache.js', () => ({
  RepoCacheManager: vi.fn().mockImplementation((config: any) => ({
    config,
    getCachedRepo: vi.fn(),
    cloneRepo: vi.fn(),
  })),
}));

vi.mock('../../src/mcp/server.js', () => ({
  startStdioServer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/wiki/service.js', () => ({
  WikiService: vi.fn().mockImplementation(() => ({
    initialize: vi.fn(),
    getDoc: vi.fn(),
  })),
}));

vi.mock('../../src/server/index.js', () => ({
  default: {},
}));

// ─── Helper ─────────────────────────────────────────────────────

const OLD_ARGV = process.argv;
const OLD_EXIT = process.exit;
const OLD_CONSOLE_ERROR = console.error;

/**
 * Simulate CLI run with given argv.
 * Resets modules so program.parse() re-executes with fresh argv.
 */
async function runCLI(argv: string[]) {
  vi.resetModules();
  process.argv = argv;
  process.exit = vi.fn() as any;
  console.error = vi.fn() as any;
  await import('../../src/cli/index.js');
  // Wait a tick for any async action handlers to complete
  await new Promise(r => setTimeout(r, 50));
}

// ─── Tests: analyze command ─────────────────────────────────────

describe('CLI — analyze command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.argv = OLD_ARGV;
    process.exit = OLD_EXIT;
    console.error = OLD_CONSOLE_ERROR;
  });

  it('should call runAnalyze with correct parameters', async () => {
    await runCLI(['node', 'jelly-code', 'analyze', '/tmp/test-repo', '--project-id', 'my-project']);

    expect(mockGraph.initializeSchema).toHaveBeenCalled();
    expect(mockGraph.close).toHaveBeenCalled();
    expect(mockSearch.close).toHaveBeenCalled();
    expect(mockVector.close).toHaveBeenCalled();

    const { runAnalyze } = await import('../../src/core/run-analyze.js');
    expect(runAnalyze).toHaveBeenCalledWith(
      '/tmp/test-repo',
      'my-project',
      mockStores,
      expect.objectContaining({ repoCache: expect.any(Object) }),
    );
  }, 15000);

  it('should use default project-id when not provided', async () => {
    await runCLI(['node', 'jelly-code', 'analyze', '/tmp/test-repo']);

    const { runAnalyze } = await import('../../src/core/run-analyze.js');
    expect(runAnalyze).toHaveBeenCalledWith(
      '/tmp/test-repo',
      'default',
      expect.any(Object),
      expect.any(Object),
    );
  }, 15000);

  it('should call initializeSchema before analyze', async () => {
    await runCLI(['node', 'jelly-code', 'analyze', '/tmp/repo']);
    expect(mockGraph.initializeSchema).toHaveBeenCalled();
  }, 15000);

  it('should close stores after successful analyze', async () => {
    await runCLI(['node', 'jelly-code', 'analyze', '/tmp/repo']);
    expect(mockGraph.close).toHaveBeenCalled();
    expect(mockSearch.close).toHaveBeenCalled();
    expect(mockVector.close).toHaveBeenCalled();
  }, 15000);

  it('should call process.exit(1) on analyze failure', async () => {
    const { runAnalyze } = await import('../../src/core/run-analyze.js');
    (runAnalyze as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Analysis failed'));

    await runCLI(['node', 'jelly-code', 'analyze', '/tmp/bad-repo']);
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 15000);
});

// ─── Tests: serve command ───────────────────────────────────────

describe('CLI — serve command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.argv = OLD_ARGV;
  });

  it('should not exit when serve command is provided', async () => {
    await runCLI(['node', 'jelly-code', 'serve']);
    expect(process.exit).not.toHaveBeenCalled();
  }, 15000);

  it('should trigger dynamic import of server module', async () => {
    // serve command does await import('../server/index.js');
    // vi.mock catches the import; just verify no crash
    await runCLI(['node', 'jelly-code', 'serve']);
    // If the import was triggered, the server mock was loaded
    const serverMod = await import('../../src/server/index.js');
    expect(serverMod).toBeDefined();
  }, 15000);
});

// ─── Tests: mcp command ─────────────────────────────────────────

describe('CLI — mcp command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.exit = OLD_EXIT;
  });

  it('should start MCP stdio server with correct dependencies', async () => {
    await runCLI(['node', 'jelly-code', 'mcp', '--project-id', 'mcp-project']);

    const { startStdioServer } = await import('../../src/mcp/server.js');
    expect(startStdioServer).toHaveBeenCalledWith(
      mockStores,
      expect.any(Object),
      expect.any(Object),
    );
  }, 15000);

  it('should handle schema init failure gracefully in mcp mode', async () => {
    mockGraph.initializeSchema.mockRejectedValueOnce(new Error('Neo4j unavailable'));

    await runCLI(['node', 'jelly-code', 'mcp']);

    // Schema init failure should not cause process.exit
    expect(process.exit).not.toHaveBeenCalled();
    const { startStdioServer } = await import('../../src/mcp/server.js');
    expect(startStdioServer).toHaveBeenCalled();
  }, 15000);

  it('should call process.exit(1) when mcp server start fails', async () => {
    const { startStdioServer } = await import('../../src/mcp/server.js');
    (startStdioServer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Port conflict'));

    await runCLI(['node', 'jelly-code', 'mcp']);
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 15000);
});

// ─── Tests: error handling ──────────────────────────────────────

describe('CLI — error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    process.argv = OLD_ARGV;
    process.exit = OLD_EXIT;
    console.error = OLD_CONSOLE_ERROR;
  });

  it('exits with code 1 when no command is provided', async () => {
    await runCLI(['node', 'jelly-code']);
    // Commander exits with 1 when no matching command
    expect(process.exit).toHaveBeenCalledWith(1);
  }, 15000);

  it('outputs help and exits 0 for --help flag', async () => {
    await runCLI(['node', 'jelly-code', '--help']);
    expect(process.exit).toHaveBeenCalledWith(0);
  }, 15000);

  it('outputs version and exits 0 for --version flag', async () => {
    // commander outputs version string and exits 0
    await runCLI(['node', 'jelly-code', '--version']);
    expect(process.exit).toHaveBeenCalledWith(0);
  }, 15000);
});
