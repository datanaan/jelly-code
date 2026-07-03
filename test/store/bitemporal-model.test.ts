/**
 * Tests for BiTemporalQuery — bi-temporal data model and query builder.
 *
 * Bi-temporal model has two time axes:
 *   valid_time  (valid_from / valid_to)     — when a code fact was true in the real world
 *   transaction_time (txn_from / txn_to)     — when we recorded/overwrote this in the graph
 *
 * Backward compatibility: old edges without bi-temporal attributes are
 * treated as valid_from = epoch, valid_to = NULL (always valid).
 *
 * These are pure data tests — no I/O, no Neo4j connection.
 * Each test should complete in < 50ms.
 */

import { describe, it, expect } from 'vitest';
import {
  BiTemporalQuery,
  BiTemporalRelation,
  isCurrentlyValid,
  supersedeRelation,
  EPOCH,
  FAR_FUTURE,
} from '../../src/store/bitemporal-model.js';

describe('bitemporal-model', () => {
  // ================================================================
  // asOf(time) — point-in-time valid_time query
  // ================================================================
  describe('BiTemporalQuery.asOf', () => {
    it('produces valid_from <= $queryTime filter', () => {
      const q = BiTemporalQuery.asOf('2026-06-01T00:00:00Z');
      expect(q.cypher).toContain('valid_from <= $queryTime');
    });

    it('produces coalesce(valid_to, FAR_FUTURE) > $queryTime filter', () => {
      const q = BiTemporalQuery.asOf('2026-06-01T00:00:00Z');
      // coalesce handles NULL valid_to (currently valid) by treating as far future
      expect(q.cypher).toContain("coalesce(valid_to, '");
      expect(q.cypher).toContain(FAR_FUTURE);
      expect(q.cypher).toContain('> $queryTime');
    });

    it('sets $queryTime param to the provided timestamp', () => {
      const ts = '2026-06-15T12:30:00Z';
      const q = BiTemporalQuery.asOf(ts);
      expect(q.params.queryTime).toBe(ts);
    });

    it('coalesce uses FAR_FUTURE inline literal for backward compat', () => {
      const q = BiTemporalQuery.asOf('2026-06-01T00:00:00Z');
      // Inline literal in Cypher, not a parameter — simplifies caller code
      expect(q.cypher).toContain(`'${FAR_FUTURE}'`);
    });
  });

  // ================================================================
  // current() — currently valid facts (valid_to IS NULL)
  // ================================================================
  describe('BiTemporalQuery.current', () => {
    it('produces valid_to IS NULL filter', () => {
      const q = BiTemporalQuery.current();
      expect(q.cypher).toContain('valid_to IS NULL');
    });

    it('does not require any params', () => {
      const q = BiTemporalQuery.current();
      expect(Object.keys(q.params)).toHaveLength(0);
    });

    it('matches both legacy edges and explicit bi-temporal current edges', () => {
      // Legacy edges: valid_to was never set → NULL
      // Bi-temporal current edges: valid_to explicitly set to NULL
      // Both match `valid_to IS NULL`
      const q = BiTemporalQuery.current();
      expect(q.cypher).toBe('valid_to IS NULL');
    });
  });

  // ================================================================
  // range(from, to) — valid_time range query
  // ================================================================
  describe('BiTemporalQuery.range', () => {
    it('produces valid_from >= $fromTime filter', () => {
      const q = BiTemporalQuery.range('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z');
      expect(q.cypher).toContain('valid_from >= $fromTime');
    });

    it('produces coalesce(valid_to, FAR_FUTURE) <= $toTime filter', () => {
      const q = BiTemporalQuery.range('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z');
      expect(q.cypher).toContain("coalesce(valid_to, '");
      expect(q.cypher).toContain('<= $toTime');
    });

    it('sets $fromTime and $toTime params', () => {
      const from = '2026-01-01T00:00:00Z';
      const to = '2026-12-31T23:59:59Z';
      const q = BiTemporalQuery.range(from, to);
      expect(q.params.fromTime).toBe(from);
      expect(q.params.toTime).toBe(to);
    });
  });

  // ================================================================
  // asOfTxn(time) — transaction_time point query
  // ================================================================
  describe('BiTemporalQuery.asOfTxn', () => {
    it('produces txn_from <= $txnTime filter', () => {
      const q = BiTemporalQuery.asOfTxn('2026-06-01T00:00:00Z');
      expect(q.cypher).toContain('txn_from <= $txnTime');
    });

    it('produces coalesce(txn_to, FAR_FUTURE) > $txnTime filter', () => {
      const q = BiTemporalQuery.asOfTxn('2026-06-01T00:00:00Z');
      expect(q.cypher).toContain("coalesce(txn_to, '");
      expect(q.cypher).toContain('> $txnTime');
    });

    it('sets $txnTime param', () => {
      const ts = '2026-06-15T12:30:00Z';
      const q = BiTemporalQuery.asOfTxn(ts);
      expect(q.params.txnTime).toBe(ts);
    });
  });

  // ================================================================
  // combined valid+txn query
  // ================================================================
  describe('BiTemporalQuery.combined', () => {
    it('combines valid_time and transaction_time filters', () => {
      const q = BiTemporalQuery.combined('2026-06-01T00:00:00Z', '2026-06-15T00:00:00Z');
      // Should have both valid_time and txn_time conditions
      expect(q.cypher).toContain('valid_from');
      expect(q.cypher).toContain('txn_from');
      expect(q.cypher).toContain('$queryTime');
      expect(q.cypher).toContain('$txnTime');
    });

    it('sets both $queryTime and $txnTime params', () => {
      const valid = '2026-06-01T00:00:00Z';
      const txn = '2026-06-15T00:00:00Z';
      const q = BiTemporalQuery.combined(valid, txn);
      expect(q.params.queryTime).toBe(valid);
      expect(q.params.txnTime).toBe(txn);
    });

    it('contains all 4 coalesce clauses (valid_from, valid_to, txn_from, txn_to)', () => {
      const q = BiTemporalQuery.combined('2026-06-01T00:00:00Z', '2026-06-15T00:00:00Z');
      // Count coalesce occurrences
      const coalesceCount = (q.cypher.match(/coalesce/g) || []).length;
      expect(coalesceCount).toBe(2); // valid_to and txn_to (valid_from and txn_from are direct)
    });
  });

  // ================================================================
  // BiTemporalRelation interface compliance
  // ================================================================
  describe('BiTemporalRelation interface', () => {
    it('creates a well-formed relation object', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-06-01T00:00:00Z',
        txn_to: null,
      };
      expect(rel.valid_from).toBe('2026-01-01T00:00:00Z');
      expect(rel.valid_to).toBeNull();
      expect(rel.txn_from).toBe('2026-06-01T00:00:00Z');
      expect(rel.txn_to).toBeNull();
    });

    it('supports closed valid range (superseded relation)', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-06-15T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      expect(rel.valid_to).not.toBeNull();
    });

    it('supports closed txn range (corrected record)', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-06-15T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: '2026-06-16T00:00:00Z',
      };
      expect(rel.txn_to).not.toBeNull();
    });
  });

  // ================================================================
  // Helper: isCurrentlyValid
  // ================================================================
  describe('isCurrentlyValid', () => {
    it('returns true when valid_to is NULL', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      expect(isCurrentlyValid(rel)).toBe(true);
    });

    it('returns false when valid_to is set', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-06-15T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      expect(isCurrentlyValid(rel)).toBe(false);
    });

    it('returns true for a query time before valid_to', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-12-31T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      expect(isCurrentlyValid(rel, '2026-06-01T00:00:00Z')).toBe(true);
    });

    it('returns false for a query time after valid_to', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-06-15T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      expect(isCurrentlyValid(rel, '2026-12-01T00:00:00Z')).toBe(false);
    });

    it('returns true for query time exactly at valid_from (inclusive)', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-06-01T00:00:00Z',
        valid_to: '2026-12-31T00:00:00Z',
        txn_from: '2026-06-01T00:00:00Z',
        txn_to: null,
      };
      expect(isCurrentlyValid(rel, '2026-06-01T00:00:00Z')).toBe(true);
    });

    it('returns false for query time exactly at valid_to (exclusive)', () => {
      const rel: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: '2026-06-15T00:00:00Z',
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      // valid_to is exclusive — at exactly valid_to, the fact is no longer valid
      expect(isCurrentlyValid(rel, '2026-06-15T00:00:00Z')).toBe(false);
    });
  });

  // ================================================================
  // Helper: supersedeRelation
  // ================================================================
  describe('supersedeRelation', () => {
    it('closes valid_to on old relation and returns it', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const supersedeTime = '2026-06-15T00:00:00Z';
      const result = supersedeRelation(old, supersedeTime);
      expect(result.old.valid_to).toBe(supersedeTime);
    });

    it('returns new relation starting at supersedeTime', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const supersedeTime = '2026-06-15T00:00:00Z';
      const result = supersedeRelation(old, supersedeTime);
      expect(result.next.valid_from).toBe(supersedeTime);
      expect(result.next.valid_to).toBeNull();
    });

    it('sets txn_from on new relation to the supersede txn time', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const result = supersedeRelation(old, '2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z');
      expect(result.next.txn_from).toBe('2026-06-16T00:00:00Z');
      expect(result.next.txn_to).toBeNull();
    });

    it('preserves original valid_from on old relation', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const result = supersedeRelation(old, '2026-06-15T00:00:00Z');
      expect(result.old.valid_from).toBe('2026-01-01T00:00:00Z');
    });

    it('closes txn_to on old relation', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const result = supersedeRelation(old, '2026-06-15T00:00:00Z', '2026-06-16T00:00:00Z');
      expect(result.old.txn_to).toBe('2026-06-16T00:00:00Z');
    });

    it('defaults txnTime to current ISO time when not provided', () => {
      const old: BiTemporalRelation = {
        valid_from: '2026-01-01T00:00:00Z',
        valid_to: null,
        txn_from: '2026-01-01T00:00:00Z',
        txn_to: null,
      };
      const before = new Date().toISOString();
      const result = supersedeRelation(old, '2026-06-15T00:00:00Z');
      const after = new Date().toISOString();
      // txn_from should be between before and after
      expect(result.next.txn_from >= before).toBe(true);
      expect(result.next.txn_from <= after).toBe(true);
    });
  });

  // ================================================================
  // Constants
  // ================================================================
  describe('constants', () => {
    it('EPOCH is a valid ISO timestamp', () => {
      expect(EPOCH).toBe('1970-01-01T00:00:00Z');
    });

    it('FAR_FUTURE is 9999-12-31', () => {
      expect(FAR_FUTURE).toContain('9999-12-31');
    });
  });
});
