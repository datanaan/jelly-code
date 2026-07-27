/**
 * Natural language time parser — converts human-readable time phrases
 * into ISO 8601 timestamps.
 *
 * Supported input categories:
 *
 *   1. ISO 8601 passthrough
 *      "2026-06-01T00:00:00Z"     → "2026-06-01T00:00:00Z"
 *      "2026-06-01"               → "2026-06-01T00:00:00Z"
 *      "2026-06-01T08:00:00+08:00" → "2026-06-01T00:00:00Z" (normalized)
 *
 *   2. Relative time — "N <unit> ago"
 *      "3 days ago"               → now - 3 days
 *      "1 week ago"               → now - 7 days
 *      "5 hours ago"              → now - 5 hours
 *      "30 minutes ago"           → now - 30 minutes
 *      "2 months ago"             → now - 60 days (approximate)
 *
 *   3. Common phrases
 *      "yesterday"                → now - 1 day
 *      "last week"                → now - 7 days
 *      "today"                    → now
 *      "now"                      → now
 *
 *   4. Numeric epoch
 *      1749892800000 (13 digits)  → epoch milliseconds → ISO
 *      1749892800    (10 digits)  → epoch seconds → ISO
 *
 *   5. Tag-based ("before v1.0", "after v2.5.0")
 *      Requires an optional tagResolver callback that maps a version tag
 *      string to an ISO 8601 timestamp.  Without a resolver, throws.
 *
 * Design choices:
 *   - **Throw for unknown patterns** — callers can catch and try
 *     alternative resolution strategies (e.g., git log, LLM).
 *   - **Synchronous** — no I/O.  The tagResolver callback is also
 *     synchronous; if async tag lookup is needed, the caller resolves
 *     the tag first and passes the ISO timestamp to this parser.
 *   - **Approximate months** — "2 months ago" is treated as 60 days,
 *     not calendar months.  This avoids locale/calendar complexity.
 *   - **UTC normalization** — all outputs use 'Z' suffix.
 */

// ─── Types ───────────────────────────────────────────────────────

/**
 * Optional resolver for version-tag-based queries ("before v1.0").
 * Receives the tag name (e.g., "v1.0") and must return an ISO 8601
 * timestamp string.  Throw inside the resolver to indicate unknown tag.
 */
export type TagResolver = (tag: string) => string;

// ─── Public API ──────────────────────────────────────────────────

/**
 * Parse a natural language time phrase into an ISO 8601 timestamp.
 *
 * @param input - The time phrase (e.g., "3 days ago", "2026-06-01").
 * @param now   - Reference point for relative phrases. Defaults to
 *                `new Date()` at call time.
 * @param tagResolver - Optional callback to resolve version-tag queries.
 * @returns ISO 8601 timestamp string (UTC, 'Z' suffix).
 * @throws Error if the input is empty, whitespace-only, or cannot
 *         be parsed.
 */
export function parseNaturalLanguageTime(
  input: string,
  now: Date = new Date(),
  tagResolver?: TagResolver,
): string {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw new Error(
      'parseNaturalLanguageTime: input is empty or whitespace-only',
    );
  }

  // Try each parser in order.  First match wins.
  const result =
    tryIso8601(trimmed) ??
    tryEpochNumber(trimmed) ??
    tryRelativeTime(trimmed, now) ??
    tryCommonPhrase(trimmed, now) ??
    trySinceDatePrefix(trimmed) ??
    tryTagBased(trimmed, now, tagResolver);

  if (result === null) {
    throw new Error(
      `parseNaturalLanguageTime: unable to parse "${trimmed}" — ` +
        'not a recognized ISO date, relative phrase, epoch number, ' +
        'common phrase, or tag reference',
    );
  }

  return result;
}

// ─── Internal parsers ────────────────────────────────────────────

/**
 * Try ISO 8601 date or datetime.
 * Returns null if the string is not a valid ISO date.
 */
function tryIso8601(input: string): string | null {
  // Strict ISO 8601 check: must start with YYYY-MM-DD
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;
  if (!isoDatePattern.test(input)) return null;

  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    // Reject invalid dates like 2026-13-45
    return null;
  }

  // Date-only input → midnight UTC
  if (!input.includes('T')) {
    return input + 'T00:00:00Z';
  }

  // Full datetime → normalize to UTC ISO string
  return toIsoUtc(parsed);
}

/**
 * Try numeric epoch (milliseconds or seconds).
 * Returns null if not a plain integer.
 */
function tryEpochNumber(input: string): string | null {
  // Must be a pure integer string
  if (!/^\d+$/.test(input)) return null;

  const num = parseInt(input, 10);

  // 13+ digits → milliseconds. 10 digits → seconds.
  // We use digit count as heuristic (2026 epoch seconds ≈ 1.75 billion ≈ 10 digits).
  let ms: number;
  if (input.length >= 13) {
    ms = num;
  } else if (input.length >= 10) {
    ms = num * 1000;
  } else {
    // Less than 10 digits is unlikely to be a meaningful epoch
    return null;
  }

  return toIsoUtc(new Date(ms));
}

/**
 * Try "N <unit>(s) ago" pattern.
 * Supported units: minute(s), hour(s), day(s), week(s), month(s).
 * Months are approximate (30 days each).
 */
function tryRelativeTime(input: string, now: Date): string | null {
  const match = input.match(
    /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i,
  );
  if (!match) return null;

  const count = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  // Compute in milliseconds for simplicity and determinism
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  let deltaMs: number;
  switch (unit) {
    case 'minute':
      deltaMs = count * minuteMs;
      break;
    case 'hour':
      deltaMs = count * hourMs;
      break;
    case 'day':
      deltaMs = count * dayMs;
      break;
    case 'week':
      deltaMs = count * 7 * dayMs;
      break;
    case 'month':
      deltaMs = count * 30 * dayMs;
      break;
    default:
      return null;
  }

  return toIsoUtc(new Date(now.getTime() - deltaMs));
}

/**
 * Try common English time phrases.
 */
function tryCommonPhrase(input: string, now: Date): string | null {
  const lower = input.toLowerCase();

  const dayMs = 24 * 60 * 60 * 1000;

  switch (lower) {
    case 'now':
    case 'today':
      return toIsoUtc(now);
    case 'yesterday':
      return toIsoUtc(new Date(now.getTime() - dayMs));
    case 'last week':
      return toIsoUtc(new Date(now.getTime() - 7 * dayMs));
    case 'last month':
      return toIsoUtc(new Date(now.getTime() - 30 * dayMs));
    case 'last year':
      return toIsoUtc(new Date(now.getTime() - 365 * dayMs));
    default:
      return null;
  }
}

/**
 * v1.3.0 Phase 3 T3-5: Try "since/after/before <ISO date>" patterns.
 *
 *   "since 2026-07-01"        → "2026-07-01T00:00:00Z"
 *   "after 2026-06-15"        → "2026-06-15T00:00:00Z"
 *   "before 2026-12-31"       → "2026-12-31T00:00:00Z"
 *
 * The directional prefix is semantically meaningful for query intent
 * (before vs after filtering), but both resolve to the same timestamp.
 * The caller's query logic handles the direction.
 *
 * Unlike tryTagBased (which handles version tags like "v1.0"), this
 * handles ISO dates directly without needing a tagResolver.
 */
function trySinceDatePrefix(input: string): string | null {
  const match = input.match(
    /^(since|after|before|from)\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?)$/i,
  );
  if (!match) return null;

  const dateStr = match[2];
  // Reuse tryIso8601 for validation + normalization
  return tryIso8601(dateStr);
}

/**
 * Try tag-based phrases: "before <tag>", "after <tag>", "since <tag>",
 * "at <tag>".
 *
 * A tag is expected to look like a version: v1.0, v2.5.0, 1.0, etc.
 * The phrase "before v1.0" means "the timestamp of tag v1.0".
 * (Directional words like "before" vs "after" are semantically meaningful
 * for query intent, but both resolve to the same tag timestamp.  The
 * caller's query logic handles the before/after filtering.)
 *
 * Requires a tagResolver.  Throws if no resolver is provided.
 */
function tryTagBased(
  input: string,
  _now: Date,
  tagResolver?: TagResolver,
): string | null {
  const match = input.match(
    /^(before|after|since|at)\s+(v?\d+(?:\.\d+)*(?:[-\w.]+)?)$/i,
  );
  if (!match) return null;

  // "before v1.0" without a resolver → throw
  if (!tagResolver) {
    throw new Error(
      `parseNaturalLanguageTime: tag-based query "${input}" requires a ` +
        'tagResolver callback. Pass one as the third argument: ' +
        'parseNaturalLanguageTime(input, now, resolver)',
    );
  }

  const tag = match[2];
  return tagResolver(tag);
}

// ─── Utilities ───────────────────────────────────────────────────

/**
 * Convert a Date to a UTC ISO 8601 string with 'Z' suffix.
 * Uses toISOString() then strips the milliseconds component
 * to produce clean "YYYY-MM-DDTHH:MM:SSZ" output.
 */
function toIsoUtc(date: Date): string {
  // toISOString() always returns "YYYY-MM-DDTHH:MM:SS.mmmZ"
  // Strip the ".mmm" milliseconds component for cleaner output.
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
