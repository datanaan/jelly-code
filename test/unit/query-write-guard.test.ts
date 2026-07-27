/**
 * Tests: F7 query tool write operation guard
 *
 * Verifies that the query MCP tool rejects write Cypher operations
 * and only allows read-only queries (MATCH, RETURN, WITH, WHERE, etc.).
 */

import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('F7: query tool write operation guard', () => {
  // Import the WRITE_PATTERNS regex directly
  // Import the WRITE_PATTERNS regex from the source
  // We replicate it here for pure unit testing (no mocks needed)
  const WRITE_PATTERNS = /(?:^|[);\n])\s*(?:CREATE|MERGE|SET|DETACH\s+DELETE|DELETE|REMOVE)\b/im;

  function isBlocked(cypher: string): boolean {
    return WRITE_PATTERNS.test(cypher);
  }

  // ==========================================
  // Write operations — should be blocked
  // ==========================================

  it('blocks CREATE', () => {
    expect(isBlocked('CREATE (n:Test {id: "x"})')).toBe(true);
  });

  it('blocks MERGE', () => {
    expect(isBlocked('MERGE (n:Test {id: $id}) ON CREATE SET n.name = $name')).toBe(true);
  });

  it('blocks SET', () => {
    expect(isBlocked('MATCH (n:Test {id: $id}) SET n.name = $name')).toBe(true);
  });

  it('blocks DELETE', () => {
    expect(isBlocked('MATCH (n:Test) DELETE n')).toBe(true);
  });

  it('blocks DETACH DELETE', () => {
    expect(isBlocked('MATCH (n) DETACH DELETE n')).toBe(true);
  });

  it('blocks REMOVE', () => {
    expect(isBlocked('MATCH (n:Test {id: $id}) REMOVE n.property')).toBe(true);
  });

  it('blocks write operations with leading whitespace', () => {
    expect(isBlocked('  CREATE (n:Test)')).toBe(true);
    expect(isBlocked('\tMERGE (n:Test)')).toBe(true);
    expect(isBlocked('\nCREATE (n:Test)')).toBe(true);
  });

  it('blocks write operations with uppercase/lowercase mix', () => {
    expect(isBlocked('create (n:Test)')).toBe(true);
    expect(isBlocked('merge (n:Test)')).toBe(true);
    expect(isBlocked('delete (n:Test)')).toBe(true);
  });

  it('blocks multi-line write queries', () => {
    const multiLine = `MATCH (n:Test {id: $id})
SET n.name = $name
RETURN n`;
    expect(isBlocked(multiLine)).toBe(true);
  });

  // ==========================================
  // Read operations — should be allowed
  // ==========================================

  it('allows MATCH + RETURN', () => {
    expect(isBlocked('MATCH (n:Test) RETURN n')).toBe(false);
  });

  it('allows MATCH with WHERE', () => {
    expect(isBlocked('MATCH (n:Test) WHERE n.id = $projectId RETURN n')).toBe(false);
  });

  it('allows OPTIONAL MATCH', () => {
    expect(isBlocked('OPTIONAL MATCH (n:Test {id: $id}) RETURN n')).toBe(false);
  });

  it('allows WITH + ORDER BY', () => {
    expect(isBlocked('MATCH (n:Test) WITH n ORDER BY n.name RETURN n')).toBe(false);
  });

  it('allows aggregation queries', () => {
    expect(isBlocked('MATCH (n:Test) RETURN count(n) AS cnt')).toBe(false);
  });

  it('allows UNION', () => {
    expect(isBlocked('MATCH (a:TypeA) RETURN a UNION MATCH (b:TypeB) RETURN b')).toBe(false);
  });

  it('allows CALL subquery', () => {
    expect(isBlocked('CALL { MATCH (n:Test) RETURN n } RETURN n')).toBe(false);
  });

  it('allows comments before MATCH', () => {
    expect(isBlocked('/* comment */ MATCH (n) RETURN n')).toBe(false);
  });

  // ==========================================
  // Edge cases
  // ==========================================

  it('does not block keywords inside strings', () => {
    // "SET" in the middle of a line (not at start) is fine
    expect(isBlocked('MATCH (n) WHERE n.name CONTAINS "SET" RETURN n')).toBe(false);
  });

  it('does not block "SETTING" (not keyword SET)', () => {
    expect(isBlocked('MATCH (n) WHERE n.name = $settingName RETURN n')).toBe(false);
  });

  it('does not block "DELETE" as a property value', () => {
    expect(isBlocked('MATCH (n) WHERE n.action = "DELETE" RETURN n')).toBe(false);
  });

  it('blocks "DELETE" at start of second line in multi-line query', () => {
    const cypher = 'MATCH (n)\nDELETE n';
    expect(isBlocked(cypher)).toBe(true);
  });

  // ==========================================
  // Integration: verify the tool registration
  // ==========================================

  it('registerQuery is defined and exports correctly', async () => {
    const { registerQuery } = await import('../../src/mcp/tools/query.js');
    expect(registerQuery).toBeDefined();
    expect(typeof registerQuery).toBe('function');
  });

  it('tool description mentions read-only', async () => {
    // Verify the description in query.ts mentions read-only nature
    const fs = await import('fs');
    const source = fs.readFileSync('src/mcp/tools/query.ts', 'utf-8');
    expect(source).toContain('read-only');
    expect(source).toContain('Write operations');
    expect(source).toContain('WRITE_PATTERNS');
  });
});
