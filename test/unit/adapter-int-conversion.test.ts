/**
 * Unit Test: Neo4j adapter int conversion
 *
 * Tests the `query()` method's number-to-neo4j.int conversion logic
 * and write query auto-detection in Neo4jAdapter.
 *
 * Pure mock — no real Neo4j connection needed.
 *
 * NOTE: vi.mock factory MUST return an object — cannot reference
 * outer-scope variables due to hoisting. Use vi.hoisted() if needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock neo4j-driver — factory must be a plain function, no outer references
vi.mock('neo4j-driver', () => {
  const mockInt = vi.fn((val: number) => ({ low: Math.floor(val), high: 0, toNumber: () => Math.floor(val) }));
  return {
    default: {
      int: mockInt,
      auth: { basic: vi.fn() },
      driver: vi.fn(() => ({
        session: vi.fn(() => ({
          executeWrite: vi.fn().mockResolvedValue({ records: [] }),
          executeRead: vi.fn().mockResolvedValue({ records: [] }),
          close: vi.fn(),
        })),
        close: vi.fn(),
      })),
      session: { WRITE: 'WRITE', READ: 'READ' },
    },
  };
});

import { Neo4jAdapter } from '../../src/store/neo4j/adapter.js';
import type { Neo4jConfig } from '../../src/config/index.js';
// Import the mocked neo4j-driver (default export from mock)
import mockNeo4j from 'neo4j-driver';
const mockInt = (mockNeo4j as any).int as ReturnType<typeof vi.fn>;

function createAdapter(config?: Partial<Neo4jConfig>): Neo4jAdapter {
  return new Neo4jAdapter({
    uri: 'bolt://localhost:7687',
    user: 'neo4j',
    password: 'test',
    database: 'neo4j',
    ...config,
  } as Neo4jConfig);
}

describe('Neo4jAdapter query() int conversion', () => {
  let adapter: Neo4jAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = createAdapter();
  });

  it('should convert integer number parameters to neo4j.int', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n) WHERE n.limit = $limit RETURN n',
      { limit: 42, name: 'test' },
    );

    expect(driverMock.session).toHaveBeenCalledWith({ defaultAccessMode: 'READ' });
    expect(sessionMock.executeRead).toHaveBeenCalled();
    // Verify neo4j.int was called for the number param
    expect(mockInt).toHaveBeenCalledWith(42);
  });

  it('should convert float to floored neo4j.int', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n) WHERE n.score = $score RETURN n',
      { score: 3.14, projectId: 'proj-x' },
    );

    // Math.floor(3.14) = 3
    expect(mockInt).toHaveBeenCalledWith(3);
  });

  it('should not convert string parameters', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n {id: $id}) RETURN n',
      { id: 'abc-123', projectId: 'proj-x' },
    );

    // String params should NOT be passed to neo4j.int
    const intCalls = mockInt.mock.calls.filter(c => typeof c[0] === 'number');
    // There should be 0 int calls for number params (id and projectId are strings)
    expect(intCalls).toHaveLength(0);
    expect(sessionMock.executeRead).toHaveBeenCalled();
  });

  it('should not convert boolean or null parameters', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n) WHERE n.isExported = $exported AND n.optional = $opt RETURN n',
      { exported: true, opt: null, projectId: 'proj-x' },
    );

    // boolean and null should NOT trigger neo4j.int
    const intCalls = mockInt.mock.calls.filter(c => typeof c[0] === 'number');
    expect(intCalls).toHaveLength(0);
    expect(sessionMock.executeRead).toHaveBeenCalled();
  });

  it('should detect MERGE write queries and route to WRITE session', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MERGE (n:Function {id: $id, projectId: $projectId})',
      { id: 'fn-1', projectId: 'proj-x' },
    );

    expect(driverMock.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
    expect(sessionMock.executeWrite).toHaveBeenCalled();
    // id is a string, projectId is a string — no number conversion needed
  });

  it('should detect CREATE write queries and route to WRITE session', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'CREATE (n:File {id: $id}) RETURN n',
      { id: 'file-1' },
    );

    expect(driverMock.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
    expect(sessionMock.executeWrite).toHaveBeenCalled();
  });

  it('should detect DELETE/DETACH write queries and route to WRITE session', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n {id: $id}) DETACH DELETE n',
      { id: 'fn-old' },
    );

    expect(driverMock.session).toHaveBeenCalledWith({ defaultAccessMode: 'WRITE' });
    expect(sessionMock.executeWrite).toHaveBeenCalled();
  });

  it('should route read-only MATCH queries to READ session', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n:Function) WHERE n.projectId = $pid RETURN n',
      { pid: 'proj-x' },
    );

    expect(driverMock.session).toHaveBeenCalledWith({ defaultAccessMode: 'READ' });
    expect(sessionMock.executeRead).toHaveBeenCalled();
  });

  it('should handle large integer parameters with Math.floor', async () => {
    const sessionMock = {
      executeWrite: vi.fn().mockResolvedValue({ records: [] }),
      executeRead: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn(),
    };
    const driverMock = vi.mocked((adapter as any).driver);
    driverMock.session = vi.fn().mockReturnValue(sessionMock);

    await adapter.query(
      'MATCH (n) WHERE n.limit = $limit RETURN n',
      { limit: 999999999, projectId: 'proj-x' },
    );

    expect(mockInt).toHaveBeenCalledWith(999999999);
  });
});
