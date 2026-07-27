/**
 * Author Deduplication
 *
 * During code analysis, the same author may appear with slightly different
 * names across commits (e.g. "John Doe" vs "john.doe" vs "John D.").
 * This module provides deterministic deduplication:
 *   1. Normalize author names to a canonical form
 *   2. Group similar names via normalized key
 *   3. Return a merged view of unique authors with their aliases
 *
 * Strategy:
 *   - Lowercase + strip non-alphanumeric (except space/hyphen)
 *   - Split first/last from email prefix
 *   - Group by normalized key (first initial + last name)
 *   - Within group, prefer the longest name as canonical
 */

export interface AuthorRecord {
  name: string;
  email?: string;
  commitCount: number;
}

export interface DedupedAuthor {
  canonicalName: string;
  aliases: string[];
  emails: string[];
  totalCommits: number;
}

/**
 * Normalize an author name to a grouping key.
 * - Lowercase
 * - Strip non-alphanumeric (keep spaces and hyphens)
 * - Collapse multiple spaces
 * - If the name looks like an email (contains @), extract the prefix first
 * - Extract first initial + last name (or last meaningful word)
 */
export function normalizeAuthorKey(name: string): string {
  // If it looks like an email, use the prefix
  const namePart = name.includes('@') ? name.split('@')[0] : name;

  const cleaned = namePart
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];

  // First initial + last name (e.g. "j doe" for "John Doe")
  // If the last part is a single character (likely an initial like "D."),
  // use the second-to-last as the last name
  const firstInitial = parts[0][0] || '';
  const lastName = parts[parts.length - 1].length >= 2
    ? parts[parts.length - 1]
    : (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]);

  return `${firstInitial} ${lastName}`;
}

/**
 * Extract email prefix (part before @) as a pseudo-name for grouping.
 */
export function emailToNameKey(email: string): string {
  const prefix = email.split('@')[0] || '';
  return prefix
    .toLowerCase()
    .replace(/[._-]/g, ' ')
    .trim();
}

/**
 * Deduplicate a list of author records.
 *
 * Algorithm:
 * 1. Build a normalized key for each author (by name, or email prefix if name is empty)
 * 2. Group by key
 * 3. Merge groups that share an email address (handles cases like "John D." vs "John Doe"
 *    where the name key differs but emails overlap)
 * 4. Pick the longest name as canonical
 * 5. Merge emails and count commits
 */
export function deduplicateAuthors(authors: AuthorRecord[]): DedupedAuthor[] {
  const groups = new Map<string, { names: Set<string>; emails: Set<string>; totalCommits: number }>();

  for (const author of authors) {
    const key = author.name
      ? normalizeAuthorKey(author.name)
      : (author.email ? emailToNameKey(author.email) : '');

    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, { names: new Set(), emails: new Set(), totalCommits: 0 });
    }

    const group = groups.get(key)!;
    if (author.name) group.names.add(author.name.trim());
    if (author.email) group.emails.add(author.email);
    group.totalCommits += author.commitCount;
  }

  // Step 2: Merge groups that share an email address
  // Build email → group key mapping
  const emailToKey = new Map<string, string>();
  const mergedKeys = new Set<string>();

  for (const [key, group] of groups) {
    for (const email of group.emails) {
      const existingKey = emailToKey.get(email);
      if (existingKey !== undefined && existingKey !== key) {
        // Merge the smaller group into the larger one
        const target = groups.get(existingKey)!;
        for (const name of group.names) target.names.add(name);
        for (const email2 of group.emails) target.emails.add(email2);
        target.totalCommits += group.totalCommits;
        mergedKeys.add(key);
        break;
      }
      emailToKey.set(email, key);
    }
  }

  // Remove merged groups
  for (const key of mergedKeys) {
    groups.delete(key);
  }

  return Array.from(groups.entries()).map(([_key, group]) => {
    // Canonical name: prefer longest, then most common
    const names = Array.from(group.names);
    const canonicalName = names.sort((a, b) => b.length - a.length)[0] || _key;

    return {
      canonicalName,
      aliases: names.filter(n => n !== canonicalName).sort(),
      emails: Array.from(group.emails).sort(),
      totalCommits: group.totalCommits,
    };
  }).sort((a, b) => b.totalCommits - a.totalCommits);
}

/**
 * Find duplicate author groups from a list of raw author records.
 * Returns groups of similar names that likely refer to the same person.
 */
export function findDuplicateGroups(authors: AuthorRecord[]): Array<{
  candidates: string[];
  emails: string[];
  totalCommits: number;
}> {
  const deduped = deduplicateAuthors(authors);
  return deduped
    .filter(d => d.aliases.length > 0 || d.emails.length > 1)
    .map(d => ({
      candidates: [d.canonicalName, ...d.aliases],
      emails: d.emails,
      totalCommits: d.totalCommits,
    }));
}
