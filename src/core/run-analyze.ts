/**
 * Code Analysis Runner
 *
 * Orchestrates the full code analysis pipeline:
 * 1. Parse source code (Tree-sitter, 14 languages) via ingestion pipeline
 * 2. Write to three backends:
 *    - Neo4j (graph traversal — nodes + relations + communities + processes)
 *    - Typesense (full-text search)
 *    - Qdrant (vector search)
 *
 * The ingestion pipeline is loaded dynamically at runtime because it's
 * excluded from TypeScript compilation (strict mode incompatibilities
 * from the ingestion pipeline). tsx handles the .ts files directly.
 */

import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { StoreSet, CodeNode, Relation, SearchDocument } from '../store/interfaces.js';
import { EPOCH } from '../store/bitemporal-model.js';
import type { PipelineResult } from '../types/pipeline.js';
import { BM25Search } from './search/bm25-index.js';
import { EmbeddingPipeline } from './embeddings/embedding-pipeline.js';
import type { RepoCacheManager } from './repo-cache.js';

// Searchable node types for Typesense indexing
const SEARCHABLE_TYPES = new Set(['Function', 'Class', 'Method', 'Interface', 'File']);

// Absolute path to the ingestion pipeline source (.ts), resolved from the compiled
// dist/ output.  The pipeline is excluded from tsc (strict mode incompatibilities
// ingestion pipeline is in .ts) so we must load the .ts file directly at runtime via tsx.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(__dirname, '..', '..', 'src', 'core', 'ingestion', 'pipeline.ts');

/**
 * Raw output from runPipelineFromRepo — returns a graph object, not the flat
 * arrays that runAnalyze expects.  We convert it below.
 */
interface RawPipelineOutput {
  graph: {
    nodes: Array<{ id: string; label: string; properties: Record<string, unknown> }>;
    relationships: Array<{
      id: string; sourceId: string; targetId: string; type: string;
      confidence: number; reason: string; step?: number;
    }>;
  };
  totalFileCount?: number;
  communityResult?: {
    communities: Array<{
      id: string; label: string; heuristicLabel: string; keywords: string[];
      description: string; cohesion: number; symbolCount: number;
    }>;
    memberships?: Array<unknown>;
    stats?: { totalCommunities: number; modularity: number };
  };
  processResult?: {
    processes: Array<{
      id: string; label: string; processType: string; stepCount: number;
      communities: string[]; entryPointId?: string;
    }>;
    stats?: { totalProcesses: number };
  };
}

function convertPipelineOutput(raw: RawPipelineOutput): PipelineResult {
  const nodes = (raw.graph.nodes || []).map(n => ({
    id: n.id,
    type: n.label,
    name: (n.properties?.name as string) || n.id,
    filePath: (n.properties?.filePath as string) || '',
    ...n.properties,
  }));

  const relations = (raw.graph.relationships || []).map(r => ({
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    confidence: r.confidence,
    reason: r.reason,
    step: r.step,
  }));

  const communities = raw.communityResult?.communities || [];
  const processes = raw.processResult?.processes || [];

  return { nodes, relations, communities, processes };
}

/**
 * Default pipeline runner that loads the ingestion pipeline at runtime.
 *
 * The ingestion module is excluded from tsc compilation due to strict mode
 * issues in the pipeline source code. We use Function() to prevent TypeScript
 * from statically analyzing the import path. At runtime, tsx resolves and
 * executes the .ts files directly.
 *
 * The pipeline returns { graph, communityResult, processResult } — we convert
 * it to the PipelineResult format that runAnalyze expects.
 */
export const defaultPipelineRunner = async (
  repoPath: string,
  onProgress?: (phase: string, percent: number) => void,
  options?: Record<string, unknown>,
): Promise<PipelineResult> => {
  // Dynamic import via string to avoid TypeScript static analysis
  // (pipeline.ts is excluded from tsc compilation due to strict mode
  // incompatibilities in pipeline source code)
  const mod = await import(/* @vite-ignore */ PIPELINE_PATH);
  const raw = await mod.runPipelineFromRepo(repoPath, (progress: { phase: string; percent: number; message: string }) => {
    console.log(`[analyze] ${progress.phase}: ${progress.percent}% — ${progress.message}`);
    if (onProgress) onProgress(progress.phase, progress.percent);
  }, options) as RawPipelineOutput;
  return convertPipelineOutput(raw);
};

export interface RunAnalyzeOptions {
  /** Maximum number of worker threads for parallel parsing */
  maxWorkers?: number;
  /** Whether to include test files in the analysis */
  includeTests?: boolean;
  /** Languages to exclude from parsing */
  excludeLanguages?: string[];
  /** Custom pipeline runner (for testing or custom pipelines) */
  pipelineRunner?: (repoPath: string, onProgress?: (phase: string, percent: number) => void, options?: Record<string, unknown>) => Promise<PipelineResult>;
  /** Git URL to clone before analysis (alternative to repoPath). Cloned to temp dir, cleaned up after. */
  gitUrl?: string;
  /** RepoCacheManager for persistent clone caching (Phase 1). When provided with gitUrl, uses persistent clone instead of temp dir. */
  repoCache?: RepoCacheManager;
  /** Progress callback — called during analysis phases (e.g., "parsing", "indexing", "temporal") */
  onProgress?: (phase: string, percent: number) => void;
}

export async function runAnalyze(
  repoPath: string,
  projectId: string,
  stores: StoreSet,
  options?: RunAnalyzeOptions,
): Promise<{
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
}> {
  const gitUrl = options?.gitUrl;
  const repoCache = options?.repoCache;
  let tempDir: string | undefined;
  let effectivePath = repoPath;
  let localPath: string | undefined;
  let lastCommit: string | undefined;

  // If gitUrl provided, clone or use cached clone
  if (gitUrl) {
    // Validate gitUrl to prevent command injection via execSync
    const GIT_URL_RE = /^(https?|git|ssh):\/\/[^\s"'`\\;|&$()]+$/;
    if (!GIT_URL_RE.test(gitUrl)) {
      throw new Error(`Invalid gitUrl: contains disallowed characters (possible injection)`);
    }

    if (repoCache) {
      // Phase 1: persistent clone cache
      localPath = await repoCache.ensureClone(gitUrl, projectId);
      effectivePath = localPath;
    } else {
      // Legacy: temp directory clone
      tempDir = mkdtempSync(join(tmpdir(), 'jelly-code-'));
      console.log(`[analyze] Cloning ${gitUrl} → ${tempDir}`);
      execSync(`git clone --depth 1 "${gitUrl}" "${tempDir}"`, {
        stdio: 'pipe',
        timeout: 300_000, // 5 min clone timeout
      });
      effectivePath = tempDir;
    }
  }

  console.log(`[analyze] Starting analysis: ${effectivePath} → project ${projectId}`);

  try {
    // ========================================
    // Step 1: Run the parsing pipeline
    // ========================================
    const pipelineRunner = options?.pipelineRunner ?? defaultPipelineRunner;
    const result = await pipelineRunner(effectivePath, options?.onProgress);

    console.log(`[analyze] Pipeline extracted: ${result.nodes.length} nodes, ${result.relations.length} relations`);

    options?.onProgress?.('indexing', 50);

    // Get HEAD commit if using persistent clone
    if (localPath) {
      try {
        lastCommit = execSync('git rev-parse HEAD', { cwd: localPath, encoding: 'utf-8' }).trim();
      } catch {
        // Non-fatal
      }
    }

    // ========================================
    // Step 2+: Write pipeline result to all stores
    // ========================================
    const stats = await writePipelineResultToStores(
      result, projectId, stores,
      gitUrl, localPath, lastCommit,
    );

    console.log(`[analyze] Analysis complete: project ${projectId}`);

    // ========================================
    // Step 5: Temporal analysis (optional, requires git history)
    // ========================================
    if (process.env.ENABLE_TEMPORAL !== 'false') {
      await runTemporalStep(effectivePath, projectId, stores, options?.onProgress);
    }

    options?.onProgress?.('complete', 100);

    return stats;
  } finally {
    // Clean up temp directory if we cloned (legacy path only)
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
        console.log(`[analyze] Cleaned up temp dir: ${tempDir}`);
      } catch {
        console.warn(`[analyze] Failed to clean up temp dir: ${tempDir}`);
      }
    }
  }
}

/**
 * Write pipeline result to all three stores (Neo4j, Typesense, Qdrant).
 * Shared between runAnalyze and runIncrementalAnalyze.
 */
export async function writePipelineResultToStores(
  result: PipelineResult,
  projectId: string,
  stores: StoreSet,
  gitUrl?: string,
  localPath?: string,
  lastCommit?: string,
): Promise<{
  nodeCount: number;
  relationCount: number;
  communityCount: number;
  processCount: number;
}> {
  // ========================================
  // Step 2: Add projectId and write to Neo4j
  // ========================================
  const nodes: CodeNode[] = result.nodes.map(n => ({
    ...n,
    projectId,
  }));

  // P1-T4: Bi-temporal attributes on edges.
  //
  // Full analysis stamps every CODE_RELATION edge with:
  //   valid_from = commit timestamp (or EPOCH if no git context)
  //   valid_to   = NULL (currently valid)
  //   txn_from   = now (when we indexed this)
  //   txn_to     = NULL (current view)
  //
  // This ensures edges created by full analysis are bi-temporal from
  // the start, enabling time-travel queries and proper supersede in
  // incremental mode (P1-T3). Legacy edges (pre-P1-T4) are handled
  // via coalesce in read queries — no forced migration needed.
  const nowIso = new Date().toISOString();
  const validFrom = lastCommit ? nowIso : EPOCH;

  const relations: Relation[] = result.relations.map(r => ({
    id: `${r.sourceId}-${r.type}-${r.targetId}`,
    ...r,
    projectId,
    valid_from: validFrom,
    valid_to: null,
    txn_from: nowIso,
    txn_to: null,
  }));

  // Write nodes (batched)
  await stores.graph.batchCreateNodes(nodes);
  console.log(`[analyze] Neo4j: ${nodes.length} nodes written`);

  // Write relations (batched)
  await stores.graph.batchCreateRelations(relations);
  console.log(`[analyze] Neo4j: ${relations.length} relations written`);

  // Write communities as nodes
  const communityNodes: CodeNode[] = result.communities.map(c => ({
    id: c.id,
    type: 'Community',
    projectId,
    name: c.label,
    filePath: '',
    heuristicLabel: c.heuristicLabel,
    keywords: c.keywords,
    description: c.description,
    cohesion: c.cohesion,
    symbolCount: c.symbolCount,
  }));
  await stores.graph.batchCreateNodes(communityNodes);

  // Write processes as nodes
  const processNodes: CodeNode[] = result.processes.map(p => ({
    id: p.id,
    type: 'Process',
    projectId,
    name: p.label,
    filePath: '',
    label: p.label,
    processType: p.processType,
    stepCount: p.stepCount,
    communities: p.communities,
    entryPointId: p.entryPointId,
  }));
  await stores.graph.batchCreateNodes(processNodes);

  // Create/update Project node with source URL, commit tracking, and freshness metadata
  const setExtra: string[] = [];
  const uniqueFileCount = new Set(nodes.map(n => n.filePath)).size;
  const params: Record<string, unknown> = {
    projectId,
    nodeCount: nodes.length,
    relationCount: relations.length,
    totalFiles: uniqueFileCount,
  };
  if (gitUrl) { setExtra.push('p.gitUrl = $gitUrl'); params.gitUrl = gitUrl; }
  if (localPath) { setExtra.push('p.localPath = $localPath'); params.localPath = localPath; }
  if (lastCommit) { setExtra.push('p.lastCommit = $lastCommit'); params.lastCommit = lastCommit; }
  if (uniqueFileCount > 0) { setExtra.push('p.totalFiles = $totalFiles'); }

  // Freshness fields: full analysis sets all to fresh
  setExtra.push(
    "p.symbolsFreshness = 'fresh'",
    "p.communitiesFreshness = 'fresh'",
    "p.temporalFreshness = 'fresh'",
    'p.lastFullRebuildAt = datetime()',
    'p.consecutiveIncremental = 0',
    'p.accumulatedChanges = 0',
    'p.fallbackCount = 0',
    'p.totalIncrementalAttempts = 0',
  );

  await stores.graph.query(
    `MERGE (p:Project {id: $projectId})
     SET p.analyzedAt = datetime(), p.nodeCount = $nodeCount, p.relationCount = $relationCount
         ${setExtra.length ? ', ' + setExtra.join(', ') : ''}`,
    params,
  );

  // ========================================
  // Step 3: Write to Typesense (full-text search)
  // ========================================
  await stores.search.ensureCollection(projectId);

  const searchableDocs: SearchDocument[] = nodes
    .filter(n => SEARCHABLE_TYPES.has(n.type))
    .map(n => ({
      id: n.id,
      name: n.name,
      content: (n.content || '').substring(0, 5000),  // Limit content size
      filePath: n.filePath,
      nodeType: n.type,
    }));

  if (searchableDocs.length > 0) {
    await stores.search.indexDocuments(projectId, searchableDocs);
    console.log(`[analyze] Typesense: ${searchableDocs.length} documents indexed`);
  }

  // ========================================
  // Step 4: Write to Qdrant (vector search)
  // ========================================
  const embeddableNodes = nodes.filter(n =>
    ['Function', 'Class', 'Method', 'Interface'].includes(n.type) &&
    (n.content || n.description)
  );

  if (embeddableNodes.length > 0) {
    const embeddingPipeline = new EmbeddingPipeline(stores.vector);
    await embeddingPipeline.indexEmbeddings(projectId, embeddableNodes);
    console.log(`[analyze] Qdrant: ${embeddableNodes.length} vectors indexed`);
  }

  return {
    nodeCount: nodes.length,
    relationCount: relations.length,
    communityCount: result.communities.length,
    processCount: result.processes.length,
  };
}

/**
 * Step 5: Temporal analysis — extract git history, build commit/author/ownership data.
 *
 * Uses dynamic imports because the temporal modules are optional and may not
 * be needed in all deployments. Failure is non-fatal: the main analysis still
 * succeeds.
 */
export async function runTemporalStep(
  repoPath: string,
  projectId: string,
  stores: StoreSet,
  onProgress?: (phase: string, percent: number) => void,
  since?: string,
): Promise<void> {
  try {
    const { extractGitLog } = await import('../temporal/git-extractor.js');
    const { detectRenames } = await import('../temporal/rename-detector.js');
    const { mapFileChangesToNodes } = await import('../temporal/commit-parser.js');
    const {
      writeCommits,
      writeAuthors,
      writeChangedInRelations,
      writeAuthoredByRelations,
      writeEvolvedFromRelations,
    } = await import('../temporal/temporal-writer.js');
    type CommitData = import('../temporal/types.js').CommitData;
    type AuthorInfo = import('../temporal/types.js').AuthorInfo;
    type ChangedInRelation = import('../temporal/types.js').ChangedInRelation;
    type AuthoredByRelation = import('../temporal/types.js').AuthoredByRelation;
    type FileChange = import('../temporal/types.js').FileChange;

    await onProgress?.('temporal', 0);

    // Extract git log — pass since for incremental mode (full history for full analysis)
    const gitOptions = since ? { since } : {};
    const { commits, isGitRepo } = extractGitLog(repoPath, gitOptions);
    if (!isGitRepo) {
      console.log('[analyze] Not a git repository, skipping temporal analysis');
      await onProgress?.('temporal', 100);
      return;
    }

    if (commits.length === 0) {
      console.log('[analyze] No commits found, skipping temporal analysis');
      await onProgress?.('temporal', 100);
      return;
    }

    await onProgress?.('temporal', 30);

    // Extract authors from commits
    const authorMap = new Map<string, { name: string; email: string; commits: Set<string>; days: Set<string> }>();
    for (const commit of commits) {
      const key = commit.authorEmail;
      if (!authorMap.has(key)) {
        authorMap.set(key, { name: commit.author, email: commit.authorEmail, commits: new Set(), days: new Set() });
      }
      const a = authorMap.get(key)!;
      a.commits.add(commit.hash);
      a.days.add(commit.timestamp.substring(0, 10));
    }

    const authors: AuthorInfo[] = Array.from(authorMap.entries()).map(([, data]) => ({
      name: data.name,
      email: data.email,
      commitCount: data.commits.size,
      activeDays: data.days.size,
    }));

    await onProgress?.('temporal', 50);

    // Map file changes to graph nodes.
    // Pre-load ALL file→nodeId mappings in one batch to avoid N sequential full-table scans.
    const allFilePaths = commits.flatMap(c => c.changedFiles.map(f => f.filePath));
    const fileToNodeMap = await stores.graph.findNodeIdsByFilePaths(projectId, allFilePaths);

    const allChangedInRelations: ChangedInRelation[] = [];
    let totalUnmapped = 0;

    for (const commit of commits) {
      if (commit.changedFiles.length === 0) continue;

      const mapped: ChangedInRelation[] = [];
      const unmapped: FileChange[] = [];

      for (const change of commit.changedFiles) {
        const nodeIds = fileToNodeMap.get(change.filePath);
        if (!nodeIds || nodeIds.length === 0) {
          unmapped.push(change);
        } else {
          for (const nodeId of nodeIds) {
            mapped.push({
              nodeId,
              commitHash: '',
              changeType: change.changeType,
              additions: change.additions ?? 0,
              deletions: change.deletions ?? 0,
              timestamp: '',
            });
          }
        }
      }

      totalUnmapped += unmapped.length;

      // Fill commitHash and timestamp from the parent commit
      for (const rel of mapped) {
        rel.commitHash = commit.hash;
        rel.timestamp = commit.timestamp;
        allChangedInRelations.push(rel);
      }
    }

    await onProgress?.('temporal', 70);

    // Build authored-by relations (aggregated ownership per node+author)
    const authoredByMap = new Map<string, { nodeId: string; authorEmail: string; changeCount: number; lastChangeAt: string }>();
    for (const change of allChangedInRelations) {
      // Find the commit to get the author
      const commit = commits.find(c => c.hash === change.commitHash);
      if (!commit) continue;
      const key = `${change.nodeId}\0${commit.authorEmail}`;
      const existing = authoredByMap.get(key);
      if (existing) {
        existing.changeCount++;
        if (change.timestamp > existing.lastChangeAt) existing.lastChangeAt = change.timestamp;
      } else {
        authoredByMap.set(key, {
          nodeId: change.nodeId,
          authorEmail: commit.authorEmail,
          changeCount: 1,
          lastChangeAt: change.timestamp,
        });
      }
    }

    // Calculate ownership percentages
    const nodeTotalChanges = new Map<string, number>();
    for (const data of authoredByMap.values()) {
      nodeTotalChanges.set(data.nodeId, (nodeTotalChanges.get(data.nodeId) || 0) + data.changeCount);
    }

    const authoredByRelations: AuthoredByRelation[] = Array.from(authoredByMap.values()).map(data => ({
      nodeId: data.nodeId,
      authorEmail: data.authorEmail,
      projectId,
      changeCount: data.changeCount,
      lastChangeAt: data.lastChangeAt,
      ownership: nodeTotalChanges.get(data.nodeId)! > 0
        ? data.changeCount / nodeTotalChanges.get(data.nodeId)!
        : 0,
    }));

    // Detect renames (pass since for incremental mode)
    const renames = await detectRenames(repoPath, since);

    await onProgress?.('temporal', 90);

    // Write everything to Neo4j
    await writeCommits(commits, projectId, stores.graph);
    await writeAuthors(authors, stores.graph);
    await writeChangedInRelations(allChangedInRelations, projectId, stores.graph);
    await writeAuthoredByRelations(authoredByRelations, stores.graph);
    await writeEvolvedFromRelations(renames, projectId, stores.graph);

    console.log(
      `[analyze] Temporal: ${commits.length} commits, ${authors.length} authors, ` +
      `${allChangedInRelations.length} changes, ${renames.length} renames` +
      (totalUnmapped > 0 ? ` (${totalUnmapped} unmapped)` : ''),
    );

    // ========================================
    // Step 5e: Evolution coupling computation
    // ========================================
    await onProgress?.('computing_coupling', 0);

    const { buildCoOccurrenceMatrix } = await import('../coupling/co-occurrence.js');
    const { calculateCouplingMetrics, filterNoisyCouplings } = await import('../coupling/coupling-calculator.js');
    const { writeCoChangedRelations } = await import('../coupling/coupling-writer.js');

    // Reuse the fileToNodeMap already pre-loaded above (Step 5d)
    // No additional queries needed.

    // Build commitsTouchingNode: count commits touching each node
    const commitsTouchingNode = new Map<string, Set<string>>();
    for (const rel of allChangedInRelations) {
      if (!commitsTouchingNode.has(rel.nodeId)) {
        commitsTouchingNode.set(rel.nodeId, new Set());
      }
      commitsTouchingNode.get(rel.nodeId)!.add(rel.commitHash);
    }
    const commitsTouchingNodeCounts = new Map<string, number>();
    for (const [nodeId, commitSet] of commitsTouchingNode) {
      commitsTouchingNodeCounts.set(nodeId, commitSet.size);
    }

    const coOccurrence = buildCoOccurrenceMatrix(commits, fileToNodeMap);
    const metrics = calculateCouplingMetrics(coOccurrence, commitsTouchingNodeCounts, commits.length);
    const filtered = filterNoisyCouplings(metrics);
    await writeCoChangedRelations(filtered, projectId, stores.graph, commits.length);

    console.log(
      `[analyze] Coupling: ${coOccurrence.length} pairs, ${filtered.length} after filtering`,
    );

    await onProgress?.('computing_coupling', 100);

    await onProgress?.('temporal', 100);
  } catch (err) {
    console.warn('[analyze] Temporal analysis failed (non-fatal):', err);
    // Temporal failure is non-fatal — analysis still succeeds
    await onProgress?.('temporal', 100);
  }
}
