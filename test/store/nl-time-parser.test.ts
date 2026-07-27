/**
 * Tests for parseNaturalLanguageTime — NL time phrase parser.
 *
 * Converts phrases like "3 days ago", "last week", "yesterday",
 * "2026-06-01" into ISO 8601 timestamps.
 *
 * Design choice: throw for unknown patterns (caller can catch
 * and try alternatives like git tag lookup).  For tag-based
 * queries ("before v1.0"), an optional tagResolver callback
 * is supported.
 *
 * These are pure data tests — no I/O, no network.  Each test
 * should complete in < 5ms.
 */

import { describe, it, expect } from 'vitest';
import { parseNaturalLanguageTime } from '../../src/store/nl-time-parser.js';

describe('nl-time-parser', () => {
  // Fix "now" so tests are deterministic
  const NOW = new Date('2026-06-22T12:00:00Z');

  // ================================================================
  // ISO 8601 passthrough
  // ================================================================
  describe('ISO 8601', () => {
    it('passes through full ISO 8601 timestamp unchanged', () => {
      const ts = '2026-06-01T00:00:00Z';
      expect(parseNaturalLanguageTime(ts, NOW)).toBe(ts);
    });

    it('passes through ISO 8601 with time component', () => {
      const ts = '2026-06-15T14:30:00Z';
      expect(parseNaturalLanguageTime(ts, NOW)).toBe(ts);
    });

    it('converts ISO date-only to midnight UTC', () => {
      expect(parseNaturalLanguageTime('2026-06-01', NOW)).toBe(
        '2026-06-01T00:00:00Z',
      );
    });

    it('passes through ISO 8601 with timezone offset', () => {
      const ts = '2026-06-01T08:00:00+08:00';
      // Normalized to UTC: 2026-06-01T00:00:00Z
      const result = parseNaturalLanguageTime(ts, NOW);
      // The parser normalizes offsets to UTC
      expect(result).toBe('2026-06-01T00:00:00Z');
    });
  });

  // ================================================================
  // Relative time — "N <unit> ago"
  // ================================================================
  describe('relative time (N units ago)', () => {
    it('parses "3 days ago"', () => {
      // 2026-06-22T12:00:00Z - 3 days = 2026-06-19T12:00:00Z
      expect(parseNaturalLanguageTime('3 days ago', NOW)).toBe(
        '2026-06-19T12:00:00Z',
      );
    });

    it('parses "1 day ago"', () => {
      expect(parseNaturalLanguageTime('1 day ago', NOW)).toBe(
        '2026-06-21T12:00:00Z',
      );
    });

    it('parses "1 week ago"', () => {
      // 7 days before NOW
      expect(parseNaturalLanguageTime('1 week ago', NOW)).toBe(
        '2026-06-15T12:00:00Z',
      );
    });

    it('parses "2 weeks ago"', () => {
      expect(parseNaturalLanguageTime('2 weeks ago', NOW)).toBe(
        '2026-06-08T12:00:00Z',
      );
    });

    it('parses "2 months ago" as ~60 days', () => {
      // Approximate: 60 days
      const result = parseNaturalLanguageTime('2 months ago', NOW);
      // Check it's approximately 60 days before NOW
      const resultMs = new Date(result).getTime();
      const nowMs = NOW.getTime();
      const diffDays = (nowMs - resultMs) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(59);
      expect(diffDays).toBeLessThanOrEqual(61);
    });

    it('parses "5 hours ago"', () => {
      expect(parseNaturalLanguageTime('5 hours ago', NOW)).toBe(
        '2026-06-22T07:00:00Z',
      );
    });

    it('parses "30 minutes ago"', () => {
      expect(parseNaturalLanguageTime('30 minutes ago', NOW)).toBe(
        '2026-06-22T11:30:00Z',
      );
    });
  });

  // ================================================================
  // Common phrases
  // ================================================================
  describe('common phrases', () => {
    it('parses "yesterday" as 1 day before now', () => {
      expect(parseNaturalLanguageTime('yesterday', NOW)).toBe(
        '2026-06-21T12:00:00Z',
      );
    });

    it('parses "last week" as 7 days before now', () => {
      expect(parseNaturalLanguageTime('last week', NOW)).toBe(
        '2026-06-15T12:00:00Z',
      );
    });

    it('parses "today" as same instant (normalized to UTC)', () => {
      expect(parseNaturalLanguageTime('today', NOW)).toBe(
        '2026-06-22T12:00:00Z',
      );
    });

    it('parses "now" as same instant', () => {
      expect(parseNaturalLanguageTime('now', NOW)).toBe(
        '2026-06-22T12:00:00Z',
      );
    });
  });

  // ================================================================
  // Case insensitivity
  // ================================================================
  describe('case insensitivity', () => {
    it('handles "3 Days Ago" (Title Case)', () => {
      expect(parseNaturalLanguageTime('3 Days Ago', NOW)).toBe(
        '2026-06-19T12:00:00Z',
      );
    });

    it('handles "YESTERDAY" (all caps)', () => {
      expect(parseNaturalLanguageTime('YESTERDAY', NOW)).toBe(
        '2026-06-21T12:00:00Z',
      );
    });

    it('handles "  3 days ago  " (extra whitespace)', () => {
      expect(parseNaturalLanguageTime('  3 days ago  ', NOW)).toBe(
        '2026-06-19T12:00:00Z',
      );
    });
  });

  // ================================================================
  // Numeric / epoch
  // ================================================================
  describe('numeric epoch', () => {
    it('parses epoch milliseconds (13 digits)', () => {
      // 2026-06-22T12:00:00Z in epoch ms
      const epochMs = NOW.getTime();
      const result = parseNaturalLanguageTime(String(epochMs), NOW);
      expect(result).toBe('2026-06-22T12:00:00Z');
    });

    it('parses epoch seconds (10 digits) by detecting length', () => {
      // 2026-06-22T12:00:00Z in epoch seconds
      const epochSec = Math.floor(NOW.getTime() / 1000);
      const result = parseNaturalLanguageTime(String(epochSec), NOW);
      expect(result).toBe('2026-06-22T12:00:00Z');
    });
  });

  // ================================================================
  // Tag-based — "before v1.0" with optional tagResolver
  // ================================================================
  describe('tag-based (before vX.Y)', () => {
    it('throws without tagResolver for "before v1.0"', () => {
      expect(() => parseNaturalLanguageTime('before v1.0', NOW)).toThrow(
        /tag|resolver|before/i,
      );
    });

    it('uses tagResolver when provided', () => {
      const resolver = (tag: string): string => {
        if (tag === 'v1.0') return '2026-01-15T10:00:00Z';
        throw new Error(`unknown tag: ${tag}`);
      };
      expect(parseNaturalLanguageTime('before v1.0', NOW, resolver)).toBe(
        '2026-01-15T10:00:00Z',
      );
    });

    it('passes tag name (not prefix) to resolver', () => {
      let receivedTag = '';
      const resolver = (tag: string): string => {
        receivedTag = tag;
        return '2026-01-15T10:00:00Z';
      };
      parseNaturalLanguageTime('after v2.5.0', NOW, resolver);
      expect(receivedTag).toBe('v2.5.0');
    });

    it('supports "after <tag>" direction', () => {
      const resolver = (tag: string): string => {
        if (tag === 'v1.0') return '2026-01-15T10:00:00Z';
        throw new Error(`unknown tag: ${tag}`);
      };
      // "after v1.0" should also resolve via the tag resolver
      expect(parseNaturalLanguageTime('after v1.0', NOW, resolver)).toBe(
        '2026-01-15T10:00:00Z',
      );
    });
  });

  // ================================================================
  // v1.3.0 Phase 3 T3-5: "since <ISO date>" prefix support
  // ================================================================
  describe('date prefix (since/after/before ISO date) — v1.3.0 T3-5', () => {
    it('parses "since 2026-07-01" as ISO date', () => {
      expect(parseNaturalLanguageTime('since 2026-07-01', NOW)).toBe(
        '2026-07-01T00:00:00Z',
      );
    });

    it('parses "after 2026-06-15"', () => {
      expect(parseNaturalLanguageTime('after 2026-06-15', NOW)).toBe(
        '2026-06-15T00:00:00Z',
      );
    });

    it('parses "before 2026-12-31"', () => {
      expect(parseNaturalLanguageTime('before 2026-12-31', NOW)).toBe(
        '2026-12-31T00:00:00Z',
      );
    });

    it('parses "from 2026-01-01"', () => {
      expect(parseNaturalLanguageTime('from 2026-01-01', NOW)).toBe(
        '2026-01-01T00:00:00Z',
      );
    });

    it('parses "since" with full ISO datetime', () => {
      expect(parseNaturalLanguageTime('since 2026-07-01T08:00:00Z', NOW)).toBe(
        '2026-07-01T08:00:00Z',
      );
    });

    it('is case-insensitive for prefix', () => {
      expect(parseNaturalLanguageTime('SINCE 2026-07-01', NOW)).toBe(
        '2026-07-01T00:00:00Z',
      );
    });
  });

  // ================================================================
  // Error handling
  // ================================================================
  describe('error handling', () => {
    it('throws for empty string', () => {
      expect(() => parseNaturalLanguageTime('', NOW)).toThrow();
    });

    it('throws for whitespace-only input', () => {
      expect(() => parseNaturalLanguageTime('   ', NOW)).toThrow();
    });

    it('throws for completely unknown phrase', () => {
      expect(() => parseNaturalLanguageTime('banana phone', NOW)).toThrow(
        /unable to parse|unknown/i,
      );
    });

    it('throws for invalid date-like string', () => {
      expect(() => parseNaturalLanguageTime('2026-13-45', NOW)).toThrow();
    });
  });

  // ================================================================
  // Default "now" — when caller doesn't pass now param
  // ================================================================
  describe('default now', () => {
    it('works without explicit now param (uses real time)', () => {
      const before = Date.now();
      const result = parseNaturalLanguageTime('now');
      const after = Date.now();
      const resultMs = new Date(result).getTime();
      // Result should be between before and after (within tolerance)
      expect(resultMs).toBeGreaterThanOrEqual(before - 1000);
      expect(resultMs).toBeLessThanOrEqual(after + 1000);
    });
  });
});
