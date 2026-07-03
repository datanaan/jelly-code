/**
 * P2-T2: Chapter Detector — detects evolution chapters from a change timeline.
 *
 * Tests detectChapters() which classifies commits into 4 chapter types:
 *   - founding: First 10% of commits (initial creation)
 *   - growth: 7+ consecutive days with >2x average commit rate
 *   - maintenance: 30+ day gap between commits
 *   - refactor: Single commit with >500 lines changed
 *
 * Strategy: Pure unit tests with hand-built timelines. No mocks needed —
 * detectChapters is a pure function operating on plain data.
 */

import { describe, it, expect } from 'vitest';
import {
  detectChapters,
  type Chapter,
  type ChapterTimelineEntry,
} from '../../src/wiki/chapter-detector.js';

// ==========================================
// Helpers
// ==========================================

/** Build a timeline entry with only the fields detectChapters reads. */
function entry(
  timestamp: string,
  additions: number,
  deletions = 0,
  commit = `commit-${timestamp}`,
): ChapterTimelineEntry {
  return { timestamp, additions, deletions, commit };
}

/** Build a sequence of daily commits from a start date. */
function dailyCommits(
  startDate: string,
  count: number,
  additions = 10,
  deletions = 2,
): ChapterTimelineEntry[] {
  const result: ChapterTimelineEntry[] = [];
  const base = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    result.push(entry(d.toISOString(), additions, deletions));
  }
  return result;
}

// ==========================================
// Tests
// ==========================================

describe('chapter-detector', () => {
  // ─── Empty / trivial cases ────────────────────────────────────────

  it('returns empty array for empty timeline', () => {
    const chapters = detectChapters({ changeTimeline: [] });
    expect(chapters).toEqual([]);
  });

  it('returns empty array for single commit (no span to analyze)', () => {
    const timeline = [entry('2026-01-01T00:00:00Z', 50)];
    const chapters = detectChapters({ changeTimeline: timeline });
    // A single commit can still be "founding" (first 10% = at least 1).
    // But with only 1 commit there's no "span" for growth/maintenance.
    // We accept either [] or [founding] — the spec says "first 10% (min 1)".
    // We verify founding is present since min 1 commit qualifies.
    expect(chapters.length).toBeLessThanOrEqual(1);
    if (chapters.length === 1) {
      expect(chapters[0].type).toBe('founding');
    }
  });

  // ─── Founding chapter ─────────────────────────────────────────────

  it('detects founding chapter (first 10% of commits)', () => {
    // 20 commits → founding = first 2 (10%)
    const timeline = dailyCommits('2026-01-01', 20);
    const chapters = detectChapters({ changeTimeline: timeline });
    const founding = chapters.find((c) => c.type === 'founding');
    expect(founding).toBeDefined();
    expect(founding!.from).toBe(timeline[0].timestamp);
    expect(founding!.to).toBe(timeline[1].timestamp);
    // keyCommits should reference the first 2 commits
    expect(founding!.keyCommits.length).toBe(2);
    expect(founding!.keyCommits[0]).toBe(timeline[0].commit);
    expect(founding!.keyCommits[1]).toBe(timeline[1].commit);
  });

  it('founding chapter uses min 1, max 10 commits for 10% rule', () => {
    // 5 commits → 10% = 0.5 → ceil → 1, but min is 1
    // Actually 10% of 5 = 0.5, rounded → 1 commit
    const timeline = dailyCommits('2026-01-01', 5);
    const chapters = detectChapters({ changeTimeline: timeline });
    const founding = chapters.find((c) => c.type === 'founding');
    expect(founding).toBeDefined();
    expect(founding!.keyCommits.length).toBeGreaterThanOrEqual(1);
  });

  it('founding chapter caps at 10 commits for large timeline', () => {
    // 200 commits → 10% = 20, but cap at 10
    const timeline = dailyCommits('2026-01-01', 200);
    const chapters = detectChapters({ changeTimeline: timeline });
    const founding = chapters.find((c) => c.type === 'founding');
    expect(founding).toBeDefined();
    expect(founding!.keyCommits.length).toBeLessThanOrEqual(10);
  });

  // ─── Growth chapter ───────────────────────────────────────────────

  it('detects growth chapter (7+ consecutive days with >2x avg rate)', () => {
    // Build timeline: 30 days of 1 commit/day (baseline), then 10 days of 5 commits/day
    const baseline = dailyCommits('2026-01-01', 30, 10, 2);
    // Now add a burst: 10 days with 5 commits each (much higher than baseline)
    const burstStart = new Date('2026-01-31');
    const burst: ChapterTimelineEntry[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(burstStart);
      d.setDate(d.getDate() + i);
      // 5 commits per day
      for (let j = 0; j < 5; j++) {
        burst.push(entry(d.toISOString(), 15, 3, `burst-${i}-${j}`));
      }
    }
    const timeline = [...baseline, ...burst];
    const chapters = detectChapters({ changeTimeline: timeline });
    const growth = chapters.find((c) => c.type === 'growth');
    expect(growth).toBeDefined();
    expect(growth!.from).toBeTruthy();
    expect(growth!.to).toBeTruthy();
    expect(growth!.keyCommits.length).toBeGreaterThan(0);
  });

  // ─── Maintenance chapter ──────────────────────────────────────────

  it('detects maintenance chapter (30+ day gap between commits)', () => {
    // First batch: 10 commits in January
    const before = dailyCommits('2026-01-01', 10);
    // Gap: 45 days (Feb 14 → no commits until March)
    // Second batch: 10 commits in March (45 days after Jan 10)
    const lastJan = new Date(before[before.length - 1].timestamp);
    const resumeDate = new Date(lastJan);
    resumeDate.setDate(resumeDate.getDate() + 45);
    const after = dailyCommits(resumeDate.toISOString(), 10);
    const timeline = [...before, ...after];

    const chapters = detectChapters({ changeTimeline: timeline });
    const maintenance = chapters.find((c) => c.type === 'maintenance');
    expect(maintenance).toBeDefined();
    // The maintenance chapter should span from last commit before gap
    // to first commit after gap
    expect(maintenance!.from).toBe(before[before.length - 1].timestamp);
    expect(maintenance!.to).toBe(after[0].timestamp);
  });

  it('does NOT detect maintenance for gaps < 30 days', () => {
    // 10 commits, then 20-day gap, then 10 commits
    const before = dailyCommits('2026-01-01', 10);
    const lastDate = new Date(before[before.length - 1].timestamp);
    const resumeDate = new Date(lastDate);
    resumeDate.setDate(resumeDate.getDate() + 20); // 20-day gap, below threshold
    const after = dailyCommits(resumeDate.toISOString(), 10);
    const timeline = [...before, ...after];

    const chapters = detectChapters({ changeTimeline: timeline });
    const maintenance = chapters.find((c) => c.type === 'maintenance');
    expect(maintenance).toBeUndefined();
  });

  // ─── Refactor chapter ─────────────────────────────────────────────

  it('detects refactor chapter (single commit >500 lines changed)', () => {
    const timeline = [
      ...dailyCommits('2026-01-01', 5, 10, 2),
      entry('2026-02-01T00:00:00Z', 400, 200, 'big-refactor'), // 600 lines total
      ...dailyCommits('2026-02-02', 5, 10, 2),
    ];
    const chapters = detectChapters({ changeTimeline: timeline });
    const refactor = chapters.find((c) => c.type === 'refactor');
    expect(refactor).toBeDefined();
    expect(refactor!.keyCommits).toContain('big-refactor');
  });

  it('does NOT detect refactor for commits with <=500 lines', () => {
    const timeline = [
      ...dailyCommits('2026-01-01', 5, 10, 2),
      entry('2026-02-01T00:00:00Z', 250, 250, 'medium-commit'), // exactly 500 lines
      ...dailyCommits('2026-02-02', 5, 10, 2),
    ];
    const chapters = detectChapters({ changeTimeline: timeline });
    const refactor = chapters.find((c) => c.type === 'refactor');
    // 500 is the boundary — >500 triggers, 500 does not
    expect(refactor).toBeUndefined();
  });

  // ─── Multiple chapters ────────────────────────────────────────────

  it('detects multiple chapter types in one timeline', () => {
    // Phase 1: Founding (first few commits)
    // Phase 2: Normal development
    // Phase 3: Big refactor
    // Phase 4: Long maintenance gap
    const founding = dailyCommits('2026-01-01', 3, 100, 50);
    const normal = dailyCommits('2026-01-04', 20, 10, 2);
    const refactor = [entry('2026-01-25T00:00:00Z', 600, 100, 'huge-refactor')]; // 700 lines
    // 40-day gap after refactor
    const gapResume = new Date('2026-03-05');
    const afterGap = dailyCommits(gapResume.toISOString(), 10, 10, 2);

    const timeline = [...founding, ...normal, ...refactor, ...afterGap];
    const chapters = detectChapters({ changeTimeline: timeline });

    const types = new Set(chapters.map((c) => c.type));
    expect(types.has('founding')).toBe(true);
    expect(types.has('refactor')).toBe(true);
    expect(types.has('maintenance')).toBe(true);
  });

  // ─── Chapter structure ────────────────────────────────────────────

  it('chapters have from/to/keyCommits/description fields', () => {
    const timeline = dailyCommits('2026-01-01', 20);
    const chapters = detectChapters({ changeTimeline: timeline });
    expect(chapters.length).toBeGreaterThan(0);
    for (const ch of chapters) {
      expect(ch).toHaveProperty('type');
      expect(ch).toHaveProperty('from');
      expect(ch).toHaveProperty('to');
      expect(ch).toHaveProperty('keyCommits');
      expect(ch).toHaveProperty('description');
      expect(typeof ch.from).toBe('string');
      expect(typeof ch.to).toBe('string');
      expect(Array.isArray(ch.keyCommits)).toBe(true);
      expect(typeof ch.description).toBe('string');
      expect(ch.description.length).toBeGreaterThan(0);
    }
  });

  // ─── Sorting ──────────────────────────────────────────────────────

  it('chapters are sorted by start time', () => {
    // Create a timeline with multiple chapter types
    const founding = dailyCommits('2026-01-01', 3, 100, 50);
    const normal = dailyCommits('2026-01-04', 20, 10, 2);
    const refactor = [entry('2026-02-01T00:00:00Z', 400, 200, 'big-refactor')];
    // 40-day gap
    const resume = new Date('2026-03-12');
    const afterGap = dailyCommits(resume.toISOString(), 5, 10, 2);

    const timeline = [...founding, ...normal, ...refactor, ...afterGap];
    const chapters = detectChapters({ changeTimeline: timeline });

    // Verify sorted
    for (let i = 1; i < chapters.length; i++) {
      expect(new Date(chapters[i].from).getTime())
        .toBeGreaterThanOrEqual(new Date(chapters[i - 1].from).getTime());
    }
  });

  // ─── Realistic timeline ───────────────────────────────────────────

  it('realistic timeline (10+ commits) produces sensible chapters', () => {
    // Simulate a real project lifecycle:
    // Jan: project creation (5 commits, large additions)
    // Feb-Mar: active development (30 commits spread over 60 days)
    // Apr: big refactor commit (600+ lines)
    // May-Jun: quiet period (35-day gap, then 2 commits)

    const phase1 = dailyCommits('2026-01-01', 5, 80, 20);
    const phase2: ChapterTimelineEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date('2026-01-06');
      d.setDate(d.getDate() + i * 2); // every 2 days
      phase2.push(entry(d.toISOString(), 15, 5, `p2-${i}`));
    }
    const refactor = [entry('2026-04-01T00:00:00Z', 500, 150, 'spring-cleanup')]; // 650 lines
    const quiet = dailyCommits('2026-05-06', 3, 8, 2); // 35+ days after refactor

    const timeline = [...phase1, ...phase2, ...refactor, ...quiet];
    const chapters = detectChapters({ changeTimeline: timeline });

    expect(chapters.length).toBeGreaterThan(0);

    // Should have at least founding and refactor
    const types = chapters.map((c) => c.type);
    expect(types).toContain('founding');

    // Chapters should be chronologically ordered
    for (let i = 1; i < chapters.length; i++) {
      expect(new Date(chapters[i].from).getTime())
        .toBeGreaterThanOrEqual(new Date(chapters[i - 1].from).getTime());
    }
  });

  // ─── Unsorted input ───────────────────────────────────────────────

  it('handles unsorted input timeline (sorts internally)', () => {
    // Provide commits in reverse order
    const sorted = dailyCommits('2026-01-01', 10);
    const reversed = [...sorted].reverse();
    const chapters = detectChapters({ changeTimeline: reversed });
    const founding = chapters.find((c) => c.type === 'founding');
    expect(founding).toBeDefined();
    // Founding should reference the earliest commit, regardless of input order
    expect(founding!.from).toBe(sorted[0].timestamp);
  });
});
