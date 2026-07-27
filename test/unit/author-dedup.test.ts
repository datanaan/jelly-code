/**
 * Tests for Author Dedup (P2-T2)
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeAuthorKey,
  emailToNameKey,
  deduplicateAuthors,
  findDuplicateGroups,
  type AuthorRecord,
} from '../../src/core/author-dedup.js';

describe('normalizeAuthorKey', () => {
  it('lowercases and strips non-alphanumeric', () => {
    expect(normalizeAuthorKey('John Doe')).toBe('j doe');
    expect(normalizeAuthorKey('Alice  Smith')).toBe('a smith');
    expect(normalizeAuthorKey('Dr. Jane M. Brown')).toBe('d brown');
  });

  it('handles hyphens correctly', () => {
    expect(normalizeAuthorKey('Jean-Claude Van Damme')).toBe('j damme');
    expect(normalizeAuthorKey('mary-ann')).toBe('m ann');
  });

  it('handles email-like names', () => {
    // john.doe@example.com → prefix "john.doe" → cleaned "johndoe"
    // Single word, returned as-is
    const result = normalizeAuthorKey('john.doe@example.com');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeAuthorKey('')).toBe('');
    expect(normalizeAuthorKey('   ')).toBe('');
  });

  it('handles single word names', () => {
    expect(normalizeAuthorKey('Bot')).toBe('bot');
    expect(normalizeAuthorKey('Admin')).toBe('admin');
  });
});

describe('emailToNameKey', () => {
  it('extracts prefix and replaces separators', () => {
    expect(emailToNameKey('john.doe@example.com')).toBe('john doe');
    expect(emailToNameKey('alice_smith@test.com')).toBe('alice smith');
  });

  it('handles simple emails', () => {
    expect(emailToNameKey('bot@github.com')).toBe('bot');
  });
});

describe('deduplicateAuthors', () => {
  it('groups same person by email match when names differ', () => {
    // "John D." is an abbreviated form of "John Doe" — same email merges them
    const authors: AuthorRecord[] = [
      { name: 'John Doe', email: 'john@example.com', commitCount: 50 },
      { name: 'John D.', email: 'john@example.com', commitCount: 30 },
    ];

    const result = deduplicateAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].canonicalName).toBe('John Doe');
    expect(result[0].aliases).toContain('John D.');
    expect(result[0].emails).toEqual(['john@example.com']);
    expect(result[0].totalCommits).toBe(80);
  });

  it('groups same person by name key when names normalize identically', () => {
    // These normalize to the same key because the middle initial is dropped
    const authors: AuthorRecord[] = [
      { name: 'Alice Smith', commitCount: 40 },
      { name: 'Alice B. Smith', commitCount: 20 },
    ];

    const result = deduplicateAuthors(authors);
    expect(result).toHaveLength(1);
    expect(result[0].canonicalName).toBe('Alice B. Smith');
    expect(result[0].totalCommits).toBe(60);
  });

  it('sorts by total commits descending', () => {
    const authors: AuthorRecord[] = [
      { name: 'Minor Contributor', commitCount: 5 },
      { name: 'Main Developer', commitCount: 200 },
    ];

    const result = deduplicateAuthors(authors);
    expect(result[0].canonicalName).toBe('Main Developer');
    expect(result[1].canonicalName).toBe('Minor Contributor');
  });

  it('handles unique authors as separate groups', () => {
    const authors: AuthorRecord[] = [
      { name: 'Alice', commitCount: 10 },
      { name: 'Bob', commitCount: 20 },
      { name: 'Charlie', commitCount: 30 },
    ];

    const result = deduplicateAuthors(authors);
    expect(result).toHaveLength(3);
  });

  it('uses email prefix when name is empty', () => {
    const authors: AuthorRecord[] = [
      { email: 'deploy-bot@github.com', commitCount: 100 },
      { email: 'ci-runner@actions.com', commitCount: 50 },
    ];

    const result = deduplicateAuthors(authors);
    expect(result).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(deduplicateAuthors([])).toEqual([]);
  });

  it('handles records with no name and no email', () => {
    const authors: AuthorRecord[] = [
      { name: '', commitCount: 5 },
    ];
    expect(deduplicateAuthors(authors)).toEqual([]);
  });
});

describe('findDuplicateGroups', () => {
  it('returns groups with aliases or multiple emails', () => {
    const authors: AuthorRecord[] = [
      { name: 'John Doe', email: 'john@example.com', commitCount: 50 },
      { name: 'John D.', email: 'john@example.com', commitCount: 30 },
      { name: 'Alice', email: 'alice@example.com', commitCount: 20 },
    ];

    const groups = findDuplicateGroups(authors);
    expect(groups).toHaveLength(1);
    expect(groups[0].candidates).toContain('John Doe');
    expect(groups[0].candidates).toContain('John D.');
  });

  it('returns empty for fully unique authors', () => {
    const authors: AuthorRecord[] = [
      { name: 'Alice', commitCount: 10 },
      { name: 'Bob', commitCount: 20 },
    ];

    expect(findDuplicateGroups(authors)).toEqual([]);
  });
});
