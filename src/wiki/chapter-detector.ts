/**
 * P2-T2: Chapter Detector — detects evolution chapters from a change timeline.
 *
 * Analyzes a change timeline (from EvolutionFacts.changeTimeline or similar)
 * and classifies periods into 4 chapter types:
 *   - founding: First 10% of commits (initial creation)
 *   - growth: 7+ consecutive days with >2x average commit rate
 *   - maintenance: 30+ day gap between consecutive commits
 *   - refactor: Single commit with >500 lines changed (additions + deletions)
 *
 * Design:
 *   - Pure function, no side effects, no IGraphStore dependency
 *   - Input: { changeTimeline: ChapterTimelineEntry[] }
 *   - Output: Chapter[] sorted chronologically by `from`
 *   - The timeline is sorted internally; callers may pass unsorted input
 */

// ─── Types ────────────────────────────────────────────────────────

/** The chapter types detectable from a change timeline. */
export type ChapterType = 'founding' | 'growth' | 'maintenance' | 'refactor';

/**
 * A single entry in the change timeline.
 * Matches ChangeTimelineFact from evolution-facts-query.ts but with
 * optional additions/deletions/commit fields for chapter analysis.
 */
export interface ChapterTimelineEntry {
  /** Timestamp of the change (ISO 8601). */
  timestamp: string;
  /** Lines added in this commit (used for refactor detection). */
  additions?: number;
  /** Lines deleted in this commit (used for refactor detection). */
  deletions?: number;
  /** Commit hash (used for keyCommits references). */
  commit?: string;
}

/**
 * A detected chapter in the code evolution story.
 */
export interface Chapter {
  /** The type of chapter detected. */
  type: ChapterType;
  /** Start timestamp of the chapter (ISO 8601). */
  from: string;
  /** End timestamp of the chapter (ISO 8601). */
  to: string;
  /** Commit hashes that are key to this chapter. */
  keyCommits: string[];
  /** Human-readable description of what happened in this chapter. */
  description: string;
}

/** Input shape for detectChapters — accepts the changeTimeline array. */
export interface ChapterDetectionInput {
  changeTimeline: ChapterTimelineEntry[];
}

// ─── Constants ────────────────────────────────────────────────────

/** Founding chapter: first 10% of commits, minimum 1, maximum 10. */
const FOUNDING_PERCENTAGE = 0.10;
const FOUNDING_MIN = 1;
const FOUNDING_MAX = 10;

/** Growth chapter: at least N consecutive days with >2x average rate. */
const GROWTH_MIN_DAYS = 7;
const GROWTH_RATE_MULTIPLIER = 2;

/** Maintenance chapter: gap between commits must exceed this many days. */
const MAINTENANCE_GAP_DAYS = 30;

/** Refactor chapter: single commit with total lines changed > this threshold. */
const REFACTOR_LINE_THRESHOLD = 500;

/** Milliseconds per day (for date math). */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Implementation ───────────────────────────────────────────────

/**
 * Detect evolution chapters from a change timeline.
 *
 * Algorithm:
 *   1. Sort timeline by timestamp (ascending)
 *   2. Detect founding chapter (first 10% of commits)
 *   3. Detect growth chapters (7+ consecutive high-activity days)
 *   4. Detect maintenance chapters (30+ day gaps)
 *   5. Detect refactor chapters (single commit >500 lines)
 *   6. Sort all chapters by start time
 *
 * @param input — object containing the changeTimeline array
 * @returns array of detected chapters, sorted chronologically
 */
export function detectChapters(input: ChapterDetectionInput): Chapter[] {
  const { changeTimeline } = input;

  if (changeTimeline.length === 0) {
    return [];
  }

  // Sort by timestamp ascending (copy to avoid mutating input)
  const sorted = [...changeTimeline].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const chapters: Chapter[] = [];

  // 1. Founding chapter
  const foundingChapter = detectFounding(sorted);
  if (foundingChapter) {
    chapters.push(foundingChapter);
  }

  // 2. Growth chapters
  const growthChapters = detectGrowth(sorted);
  chapters.push(...growthChapters);

  // 3. Maintenance chapters
  const maintenanceChapters = detectMaintenance(sorted);
  chapters.push(...maintenanceChapters);

  // 4. Refactor chapters
  const refactorChapters = detectRefactor(sorted);
  chapters.push(...refactorChapters);

  // Sort all chapters by start time
  chapters.sort(
    (a, b) => new Date(a.from).getTime() - new Date(b.from).getTime(),
  );

  return chapters;
}

// ─── Individual Detectors ─────────────────────────────────────────

/**
 * Detect the founding chapter: first 10% of commits (min 1, max 10).
 */
function detectFounding(
  sorted: ChapterTimelineEntry[],
): Chapter | null {
  const total = sorted.length;
  if (total === 0) return null;

  const count = Math.min(
    Math.max(Math.ceil(total * FOUNDING_PERCENTAGE), FOUNDING_MIN),
    FOUNDING_MAX,
  );
  const foundingCommits = sorted.slice(0, count);

  return {
    type: 'founding',
    from: foundingCommits[0].timestamp,
    to: foundingCommits[foundingCommits.length - 1].timestamp,
    keyCommits: foundingCommits
      .map((c) => c.commit)
      .filter((c): c is string => c !== undefined),
    description: `Initial creation — first ${count} commit${count > 1 ? 's' : ''} establishing the codebase.`,
  };
}

/**
 * Detect growth chapters: 7+ consecutive days with commit rate >2x average.
 *
 * Strategy:
 *   - Calculate the overall average daily commit rate
 *   - Use a sliding window to find sustained periods of high activity
 *   - A "day" groups commits by calendar date
 */
function detectGrowth(
  sorted: ChapterTimelineEntry[],
): Chapter[] {
  const chapters: Chapter[] = [];
  if (sorted.length < GROWTH_MIN_DAYS) return chapters;

  // Group commits by calendar day
  const dayMap = new Map<string, ChapterTimelineEntry[]>();
  for (const entry of sorted) {
    const dayKey = entry.timestamp.substring(0, 10); // YYYY-MM-DD
    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, []);
    }
    dayMap.get(dayKey)!.push(entry);
  }

  // Get sorted unique days
  const days = Array.from(dayMap.keys()).sort();
  if (days.length === 0) return chapters;

  // Calculate overall average commits per day
  const totalCommits = sorted.length;
  const totalSpan = Math.max(
    1,
    Math.round(
      (new Date(days[days.length - 1]).getTime() - new Date(days[0]).getTime()) /
        MS_PER_DAY,
    ) + 1,
  );
  const avgRate = totalCommits / totalSpan;

  // Find windows of 7+ consecutive days with rate >2x average
  let windowStart = 0;
  while (windowStart < days.length) {
    let windowEnd = windowStart;
    let windowCommits = 0;

    // Expand window while days are consecutive and rate is high
    while (windowEnd < days.length) {
      // Check if day is consecutive with previous
      if (windowEnd > windowStart) {
        const prev = new Date(days[windowEnd - 1]).getTime();
        const curr = new Date(days[windowEnd]).getTime();
        if (curr - prev > MS_PER_DAY * 1.5) {
          // Not consecutive — break
          break;
        }
      }

      const dayEntries = dayMap.get(days[windowEnd])!;
      const dayRate = dayEntries.length;

      // Check if this day's rate exceeds 2x average
      if (dayRate <= avgRate * GROWTH_RATE_MULTIPLIER) {
        break; // Day doesn't meet threshold
      }

      windowCommits += dayEntries.length;
      windowEnd++;
    }

    // Check if window is long enough (7+ consecutive days)
    const windowLength = windowEnd - windowStart;
    if (windowLength >= GROWTH_MIN_DAYS) {
      const windowDays = days.slice(windowStart, windowEnd);
      const windowEntries = windowDays.flatMap((d) => dayMap.get(d)!);

      chapters.push({
        type: 'growth',
        from: windowEntries[0].timestamp,
        to: windowEntries[windowEntries.length - 1].timestamp,
        keyCommits: windowEntries
          .map((e) => e.commit)
          .filter((c): c is string => c !== undefined),
        description: `Sustained growth — ${windowLength} consecutive days of high activity (${windowCommits} commits, >${(avgRate * GROWTH_RATE_MULTIPLIER).toFixed(1)}/day threshold).`,
      });
    }

    // Move past this window
    windowStart = windowEnd > windowStart ? windowEnd : windowStart + 1;
  }

  return chapters;
}

/**
 * Detect maintenance chapters: gaps >30 days between consecutive commits.
 */
function detectMaintenance(
  sorted: ChapterTimelineEntry[],
): Chapter[] {
  const chapters: Chapter[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].timestamp).getTime();
    const curr = new Date(sorted[i].timestamp).getTime();
    const gapDays = (curr - prev) / MS_PER_DAY;

    if (gapDays > MAINTENANCE_GAP_DAYS) {
      const before = sorted[i - 1];
      const after = sorted[i];

      chapters.push({
        type: 'maintenance',
        from: before.timestamp,
        to: after.timestamp,
        keyCommits: [
          ...(before.commit ? [before.commit] : []),
          ...(after.commit ? [after.commit] : []),
        ],
        description: `Maintenance lull — ${Math.round(gapDays)}-day gap between commits (${new Date(before.timestamp).toISOString().substring(0, 10)} → ${new Date(after.timestamp).toISOString().substring(0, 10)}).`,
      });
    }
  }

  return chapters;
}

/**
 * Detect refactor chapters: single commits with >500 lines changed.
 */
function detectRefactor(
  sorted: ChapterTimelineEntry[],
): Chapter[] {
  const chapters: Chapter[] = [];

  for (const entry of sorted) {
    const additions = entry.additions ?? 0;
    const deletions = entry.deletions ?? 0;
    const totalLines = additions + deletions;

    if (totalLines > REFACTOR_LINE_THRESHOLD) {
      chapters.push({
        type: 'refactor',
        from: entry.timestamp,
        to: entry.timestamp,
        keyCommits: entry.commit ? [entry.commit] : [],
        description: `Major refactor — ${totalLines} lines changed in a single commit (${additions} additions, ${deletions} deletions).`,
      });
    }
  }

  return chapters;
}
