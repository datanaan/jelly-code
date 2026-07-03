/**
 * IncrementalScheduler — Auto-trigger safety for incremental analysis.
 *
 * Periodically checks all registered projects for new commits, runs
 * incremental analysis with three layers of safety:
 *
 * Layer 1: change ratio > 5% → full rebuild
 * Layer 2: consecutive incremental > 10 → full rebuild
 * Layer 3: freshness timeout > 7 days → full rebuild
 *
 * DESIGN PRINCIPLE: auto-trigger = unattended. Safety thresholds prevent
 * silent data quality degradation.
 */

import type { StoreSet } from '../store/interfaces.js';
import type { RepoCacheManager } from '../core/repo-cache.js';
import type { TaskManager } from '../task/index.js';
import { detectChanges } from '../core/change-detector.js';
import { runIncrementalAnalyze } from '../core/run-incremental.js';
import { runAnalyze } from '../core/run-analyze.js';
import type { ChangeSet } from '../core/change-detector.js';
import { archiveOldVersions, DEFAULT_RETENTION_DAYS } from '../store/archive.js';
import type { WikiService } from '../wiki/service.js';

export class IncrementalScheduler {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private archiveTimerId: ReturnType<typeof setInterval> | null = null;
  private evolutionTimerId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private stores: StoreSet,
    private repoCache: RepoCacheManager,
    private taskManager: TaskManager,
    private wikiService?: WikiService,
  ) {}

  /**
   * Start the scheduler with a given interval in minutes.
   * The interval is floored to the nearest minute (minimum 1).
   */
  start(intervalMinutes: number): void {
    if (this.timerId) this.stop();
    const ms = Math.max(intervalMinutes, 1) * 60 * 1000;
    this.timerId = setInterval(() => {
      this.checkAllProjects().catch(err => {
        console.error(`[scheduler] checkAllProjects failed: ${err instanceof Error ? err.message : err}`);
      });
    }, ms);
    console.log(`[scheduler] Started, checking every ${intervalMinutes} minutes`);
  }

  /**
   * Start the weekly archive job for old bi-temporal edges.
   *
   * Runs every 7 days, archiving superseded edges whose valid_to is older
   * than retentionDays. Soft-archive: sets archived = true flag, does not
   * delete data. asOf queries still find archived edges.
   *
   * @param retentionDays — edges superseded more than this many days ago are archived
   */
  startArchiveJob(retentionDays: number = DEFAULT_RETENTION_DAYS): void {
    if (this.archiveTimerId) return; // already running
    const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.archiveTimerId = setInterval(() => {
      archiveOldVersions(this.stores.graph, retentionDays).then(result => {
        console.log(`[scheduler] Archive job complete: ${result.archived} edges archived`);
      }).catch(err => {
        console.error(`[scheduler] Archive job failed: ${err instanceof Error ? err.message : err}`);
      });
    }, WEEKLY_MS);
    console.log(`[scheduler] Archive job started (weekly, retention=${retentionDays} days)`);
  }

  /**
   * Start the monthly evolution story batch job.
   *
   * Runs every 30 days, generating evolution stories for "important" code
   * nodes (CHANGED_IN > 10 or EVOLVED_FROM chain > 2) across all registered
   * projects.
   *
   * Requires a WikiService instance to be passed to the scheduler constructor.
   * If no WikiService is available, this method is a no-op.
   */
  private static readonly EVOLUTION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 1 day check (safe: 86.4M < 2.1B)
  private static readonly EVOLUTION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  private lastEvolutionRun = 0;

  startEvolutionBatchJob(): void {
    if (this.evolutionTimerId) return; // already running
    if (!this.wikiService) {
      console.log('[scheduler] Evolution batch job skipped (no WikiService)');
      return;
    }
    // NOTE: Do NOT pass >2.1B ms to setInterval — JS clamps to 1ms.
    // Instead use a short polling interval with a cooldown guard.
    this.evolutionTimerId = setInterval(() => {
      if (Date.now() - this.lastEvolutionRun < IncrementalScheduler.EVOLUTION_COOLDOWN_MS) {
        return; // cooldown not elapsed
      }
      this.lastEvolutionRun = Date.now();
      this.runEvolutionBatchForAllProjects().catch(err => {
        console.error(`[scheduler] Evolution batch job failed: ${err instanceof Error ? err.message : err}`);
      });
    }, IncrementalScheduler.EVOLUTION_CHECK_INTERVAL);
    console.log('[scheduler] Evolution batch job started (monthly, poll=24h)');
  }

  /** Run evolution batch for all registered projects. */
  private async runEvolutionBatchForAllProjects(): Promise<void> {
    if (!this.wikiService) return;
    const projects = await this.stores.graph.query(
      'MATCH (p:Project) RETURN p.id AS id',
    );
    for (const project of projects as Array<Record<string, unknown>>) {
      const projectId = project.id as string;
      try {
        const result = await this.wikiService.generateAllEvolutionStories(projectId);
        console.log(
          `[scheduler] ${projectId}: evolution batch — generated=${result.generated}, skipped=${result.skipped}, errors=${result.errors.length}`,
        );
      } catch (err) {
        console.warn(`[scheduler] ${projectId}: evolution batch failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.archiveTimerId) {
      clearInterval(this.archiveTimerId);
      this.archiveTimerId = null;
    }
    if (this.evolutionTimerId) {
      clearInterval(this.evolutionTimerId);
      this.evolutionTimerId = null;
    }
  }

  /** Check all registered projects for new commits. */
  private async checkAllProjects(): Promise<void> {
    if (this.running) {
      console.log('[scheduler] Previous check still running, skipping this tick');
      return;
    }
    this.running = true;
    try {
      const projects = await this.stores.graph.query(
        'MATCH (p:Project) RETURN p.id AS id, p.gitUrl AS gitUrl, p.lastCommit AS lastCommit',
      );
      for (const project of projects as Array<Record<string, unknown>>) {
        const projectId = project.id as string;
        const gitUrl = project.gitUrl as string;
        const lastCommit = project.lastCommit as string | undefined;
        if (!gitUrl) continue;

        try {
          await this.checkProject(projectId, gitUrl, lastCommit);
        } catch (err) {
          console.warn(`[scheduler] ${projectId}: check failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Check a single project for changes. */
  private async checkProject(projectId: string, gitUrl: string, lastCommit?: string): Promise<void> {
    // Skip if manual analysis is in progress
    const currentState = this.taskManager.getState(projectId);
    if (currentState?.status === 'analyzing' || currentState?.status === 'queued') {
      console.log(`[scheduler] ${projectId}: manual analysis in progress, skipping`);
      return;
    }

    // ensureClone already fetches + resets to origin/HEAD
    const localPath = await this.repoCache.ensureClone(gitUrl, projectId);

    if (!lastCommit) {
      // No previous analysis — run full
      console.log(`[scheduler] ${projectId}: no previous analysis, running full`);
      await this.forceFullRebuild(projectId, gitUrl);
      return;
    }

    // Detect changes since last analysis
    const changeSet = await detectChanges(localPath, this.stores.graph, projectId);
    if (!changeSet) {
      console.log(`[scheduler] ${projectId}: change detection failed, running full`);
      await this.forceFullRebuild(projectId, gitUrl);
      return;
    }

    const totalChanges = changeSet.modified.length + changeSet.added.length + changeSet.deleted.length;
    if (totalChanges === 0) {
      console.log(`[scheduler] ${projectId}: no changes`);
      return;
    }

    console.log(`[scheduler] ${projectId}: ${totalChanges} changes detected`);
    await this.triggerWithSafety(projectId, gitUrl, changeSet);
  }

  /**
   * Trigger incremental analysis with safety checks.
   * Falls back to full rebuild if any safety layer triggers.
   */
  private async triggerWithSafety(
    projectId: string,
    gitUrl: string,
    changeSet: ChangeSet,
  ): Promise<void> {
    const MAX_CONSECUTIVE = parseInt(process.env.MAX_CONSECUTIVE_INCREMENTAL || '10', 10);
    const MAX_CHANGE_RATIO = parseFloat(process.env.MAX_CHANGE_RATIO || '0.05');
    const STALE_TIMEOUT_DAYS = parseInt(process.env.STALE_TIMEOUT_DAYS || '7', 10);

    // =====================
    // Layer 2: Consecutive incremental check
    // =====================
    const projectInfo = await this.stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       RETURN p.consecutiveIncremental AS ci, p.lastFullRebuildAt AS lfra,
              p.totalFiles AS tfCount`,
      { projectId },
    );
    const consecutiveIncremental = (projectInfo[0]?.ci as number) || 0;

    if (consecutiveIncremental >= MAX_CONSECUTIVE) {
      console.log(`[scheduler] ${projectId}: forced full rebuild (${consecutiveIncremental} consecutive incrementals >= ${MAX_CONSECUTIVE})`);
      await this.forceFullRebuild(projectId, gitUrl);
      return;
    }

    // =====================
    // Layer 1: Change ratio check (use cached totalFiles from Project node)
    // =====================
    const totalFiles = (projectInfo[0]?.tfCount as number) || 0;
    const tc = changeSet.modified.length + changeSet.added.length + changeSet.deleted.length;
    const changeRatio = totalFiles > 0 ? tc / totalFiles : 0;

    if (changeRatio > MAX_CHANGE_RATIO) {
      console.log(`[scheduler] ${projectId}: forced full rebuild (change ratio=${(changeRatio * 100).toFixed(1)}%, ${tc}/${totalFiles} files > ${(MAX_CHANGE_RATIO * 100).toFixed(0)}%)`);
      await this.forceFullRebuild(projectId, gitUrl);
      return;
    }

    // =====================
    // Layer 3: Freshness timeout check
    // =====================
    const freshnessInfo = await this.stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       RETURN p.communitiesFreshness AS cf, p.lastCommunityRebuildAt AS lcra,
              p.temporalFreshness AS tf, p.lastFullRebuildAt AS lfra`,
      { projectId },
    );
    const f = freshnessInfo[0] as Record<string, unknown> | undefined;

    if (f) {
      // Check community freshness timeout
      if ((f.cf === 'stale' || f.cf === 'error') && f.lcra) {
        const days = (Date.now() - new Date(f.lcra as string).getTime()) / 86400000;
        if (days > STALE_TIMEOUT_DAYS) {
          console.log(`[scheduler] ${projectId}: forced full rebuild (communities stale for ${days.toFixed(1)} days > ${STALE_TIMEOUT_DAYS})`);
          await this.forceFullRebuild(projectId, gitUrl);
          return;
        }
      }

      // Check full rebuild timeout
      if (f.lfra) {
        const days = (Date.now() - new Date(f.lfra as string).getTime()) / 86400000;
        if (days > STALE_TIMEOUT_DAYS * 2) {
          console.log(`[scheduler] ${projectId}: forced full rebuild (last full rebuild ${days.toFixed(1)} days ago > ${STALE_TIMEOUT_DAYS * 2})`);
          await this.forceFullRebuild(projectId, gitUrl);
          return;
        }
      }
    }

    // =====================
    // All checks passed → run incremental
    // =====================
    const result = await runIncrementalAnalyze(projectId, this.stores, this.repoCache, {
      precomputedChangeSet: changeSet,
    });
    console.log(`[scheduler] ${projectId}: incremental ${result.mode}, ${result.nodeCount} nodes`);
  }

  /** Force a full rebuild of a project. */
  private async forceFullRebuild(projectId: string, gitUrl: string): Promise<void> {
    await this.repoCache.ensureClone(gitUrl, projectId);
    await this.stores.graph.clearProject(projectId);
    const stats = await runAnalyze('', projectId, this.stores, {
      gitUrl,
      repoCache: this.repoCache,
    });
    await this.stores.graph.query(
      `MATCH (p:Project {id: $projectId})
       SET p.consecutiveIncremental = 0,
           p.accumulatedChanges = 0,
           p.lastFullRebuildAt = datetime()`,
      { projectId },
    );
    console.log(`[scheduler] ${projectId}: full rebuild complete, ${stats.nodeCount} nodes`);
  }
}
