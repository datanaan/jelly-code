/**
 * Unit Tests: Configuration Constants
 *
 * Tests the configuration constants and environment variable defaults
 * used throughout the codebase. Imports real project code.
 */

import { describe, it, expect } from 'vitest';
import { SAFE_CYPHER_TEMPLATES, getSafeQuery } from '../../src/store/neo4j/safe-queries.js';

describe('Configuration Constants', () => {
  describe('Safe Cypher templates', () => {
    it('should have findSymbol template', () => {
      const template = getSafeQuery('findSymbol');
      expect(template).toContain('MATCH');
      expect(template).toContain('$projectId');
      expect(template).toContain('$id');
    });

    it('should have clearProject template', () => {
      const template = getSafeQuery('clearProject');
      expect(template).toContain('DETACH DELETE');
    });

    it('should have listProjects template', () => {
      const template = getSafeQuery('listProjects');
      expect(template).toContain('RETURN p.id AS id');
    });

    it('should have markStale template', () => {
      const template = getSafeQuery('markStale');
      expect(template).toContain('SET n.stale = true');
    });

    it('should route bfsTraverse through getSafeBfsTraverse', () => {
      const template = getSafeQuery('bfsTraverse', { depth: 3 });
      expect(template).toContain('[*1..3]');
      expect(template).not.toContain('$depth');
    });

    it('should throw for unknown template', () => {
      expect(() => getSafeQuery('nonexistent')).toThrow('Unknown safe query template');
    });

    it('should contain all required templates', () => {
      const required = [
        'findSymbol', 'findSymbolByFile', 'getNode', 'bfsTraverse',
        'clearProject', 'findRelated', 'listProjects', 'getConstraints',
        'getProject', 'findSymbolByName', 'findSymbolsByProject',
        'resolveLabels', 'markStale',
      ];
      for (const name of required) {
        expect(SAFE_CYPHER_TEMPLATES[name]).toBeDefined();
      }
    });

    it('should have exactly 13 templates', () => {
      expect(Object.keys(SAFE_CYPHER_TEMPLATES).length).toBe(13);
    });
  });
});
