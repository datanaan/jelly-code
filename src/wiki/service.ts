/**
 * WikiService — core business logic for the Jelly Code Wiki.
 *
 * Orchestrates WikiGraph (Neo4j), WikiSearch (Typesense + Qdrant),
 * and ILLMClient (Ollama) to provide:
 * - ingest: compile a raw document into structured wiki entities
 * - batchIngest: ingest a directory of documents
 * - query: hybrid search + LLM synthesis
 * - getIndex / status / getEntity / listEntities / fuzzyMatch / lint / syncToJelly
 *
 * ISSUE-002 FIX: Every public method now accepts projectId for multi-tenant
 * isolation. Wiki data is no longer shared across projects.
 */

import { readFile } from 'fs/promises';
import { basename, dirname, resolve, join, extname } from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { WikiGraph } from './graph.js';
import { WikiSearch } from './search.js';
import type { StoreSet, IGraphStore } from '../store/interfaces.js';
import type { ILLMClient } from '../llm/interface.js';
import { COMPILE_PROMPT, MERGE_PROMPT, SYNTHESIZE_PROMPT } from '../llm/prompts.js';
import { embedText, embeddingToArray, isEmbedderReady, initEmbedder } from '../core/embeddings/embedder.js';
import { discoverDocs } from './doc-discovery.js';
import { generateSignature, type CodeSignature } from './code-signature.js';
import { checkEntityFreshness } from './entity-freshness.js';
import { gatherEvolutionFacts } from './evolution-facts-query.js';
import { detectChapters } from './chapter-detector.js';
import { generateNarrative, validateNarrative } from './evolution-narrator.js';
import type {
  WikiSource,
  WikiEntity,
  WikiTopic,
  WikiLogEntry,
  WikiPageDoc,
  CompileOutput,
  IngestResult,
  BatchIngestResult,
  WikiStatus,
  WikiIndex,
  LintIssue,
  EntityType,
} from './models.js';

/** Re-export LintIssue for backward compatibility (moved to models.ts in P0c-T2) */
export type { LintIssue } from './models.js';

/** Configuration for the wiki service */
export interface WikiConfig {
  staleDays: number;
  autoWriteBack: boolean;
  /** P2-T8: Max LLM calls per batch (cost control). 0 = unlimited. Default: 50 */
  maxLlmCallsPerBatch: number;
  /** P2-T8: Max tokens per LLM call. 0 = unlimited. Default: 4096 */
  maxTokensPerCall: number;
  /** P2-T8: Skip evolution stories for nodes with changedInCount below this threshold. Default: 10 */
  importanceThreshold: number;
  /** P2-T8: Skip evolution stories for nodes with evolvedFromDepth below this threshold. Default: 2 */
  evolutionDepthThreshold: number;
}

export interface WikiTaskInfo {
  projectId: string;
  sourcePath: string;
  status: 'compiling' | 'indexing' | 'done' | 'error';
  startedAt: string;
  completedAt?: string;
  result?: IngestResult | BatchIngestResult | WikiTopic;
  error?: string;
}

export class WikiService {
  private graph: WikiGraph;
  private search: WikiSearch;
  private llm: ILLMClient;
  private config: WikiConfig;
  private activeTasks = new Map<string, WikiTaskInfo>();
  /** Processing key set for concurrent-control: prevents duplicate fire-and-forget tasks */
  private processingKeys = new Set<string>();
  /** Hard cap on activeTasks to prevent OOM (P0 idempotency fix) */
  private maxActiveTasks = 1000;
  /**
   * Direct reference to the underlying IGraphStore for code node lookups
   * (codeSignature binding in P0c-T3). WikiGraph wraps IGraphStore but only
   * exposes wiki-specific operations; we keep this reference for findSymbol().
   */
  private codeStore: IGraphStore;

  constructor(stores: StoreSet, wikiConfig: WikiConfig) {
    this.graph = new WikiGraph(stores.graph);
    this.search = new WikiSearch(stores.search, stores.vector);
    this.llm = stores.llm;
    this.config = wikiConfig;
    this.codeStore = stores.graph;

    // Periodic cleanup of completed/errored tasks (every 5 minutes)
    setInterval(() => this.cleanupOldTasks(), 5 * 60 * 1000);
  }

  /**
   * Remove tasks that have been in 'done' or 'error' state for more than 1 hour.
   * Prevents activeTasks Map from growing unboundedly (P0 idempotency fix).
   *
   * Collects keys first to avoid mutation-during-iteration confusion,
   * even though Map.delete() during for...of is safe per ECMAScript spec.
   */
  private cleanupOldTasks(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const toDelete: string[] = [];
    for (const [id, task] of this.activeTasks) {
      if (task.status === 'done' || task.status === 'error') {
        const completedAt = task.completedAt ? new Date(task.completedAt).getTime() : 0;
        if (completedAt > 0 && completedAt < cutoff) {
          toDelete.push(id);
        }
      }
    }
    for (const id of toDelete) {
      this.activeTasks.delete(id);
    }
  }

  /**
   * Track a new task in activeTasks, enforcing the hard cap.
   * Evicts the oldest completed/errored task when the map exceeds maxActiveTasks.
   */
  private trackTask(taskId: string, task: WikiTaskInfo): void {
    if (this.activeTasks.size >= this.maxActiveTasks) {
      // Find the oldest completed/errored task and evict it
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, t] of this.activeTasks) {
        if (t.status === 'done' || t.status === 'error') {
          const ts = t.completedAt ? new Date(t.completedAt).getTime() : 0;
          if (ts < oldestTime) {
            oldestTime = ts;
            oldestId = id;
          }
        }
      }
      if (oldestId) this.activeTasks.delete(oldestId);
    }
    this.activeTasks.set(taskId, task);
  }

  /**
   * Acquire a processing key for concurrent-control.
   * Returns true if the key was acquired (not already processing).
   */
  private tryAcquireProcessing(key: string): boolean {
    if (this.processingKeys.has(key)) return false;
    this.processingKeys.add(key);
    return true;
  }

  /**
   * Release a processing key (always called in finally block).
   */
  private releaseProcessing(key: string): void {
    this.processingKeys.delete(key);
  }

  /**
   * v1.3.0 Phase 2: Expose WikiGraph for tools that need direct graph access
   * (e.g., wiki_auto_fix querying cross-domain edges, deleting orphaned entities).
   */
  getGraph(): WikiGraph {
    return this.graph;
  }

  /**
   * v1.3.0 Phase 3 T3-3: Public wrapper for indexEntityPage.
   * Allows WikiDerivationEngine to write search index via WikiService
   * (D9 fix — not direct TS/Qdrant manipulation).
   */
  async indexEntity(
    projectId: string,
    entityId: string,
    name: string,
    details: string,
    compiledAt: string,
  ): Promise<void> {
    await this.indexEntityPage(projectId, entityId, name, details, compiledAt);
  }

  /**
   * v1.3.0 review fix (P0-1): Delete a WikiEntity from the search index.
   * Symmetric counterpart to indexEntity — called when entities are deleted
   * from Neo4j (e.g., wiki_auto_fix delete-orphaned, undo-auto-derived).
   *
   * Without this, Typesense/Qdrant retain stale documents that point to
   * deleted Neo4j entities, causing agents to find non-existent wiki pages.
   */
  async deleteEntityFromIndex(entityId: string): Promise<void> {
    await this.search.deletePage(entityId, 'entity');
  }

  /**
   * Get all active (and recently completed) tasks.
   * Optionally filtered by projectId.
   */
  getActiveTasks(projectId?: string): Map<string, WikiTaskInfo> {
    if (!projectId) return this.activeTasks;
    const filtered = new Map<string, WikiTaskInfo>();
    for (const [id, task] of this.activeTasks) {
      if (task.projectId === projectId) filtered.set(id, task);
    }
    return filtered;
  }

  /**
   * Fire-and-forget ingest — returns a task ID immediately.
   * The actual ingest runs via setImmediate in the background.
   * Concurrent-control: same projectId+sourcePath is blocked while a task is in-flight.
   *
   * @returns taskId string on success, or **null** if a task for the same
   *          (projectId, sourcePath) is already in progress. Callers must
   *          handle null — typically by returning status="already_running".
   */
  startIngest(projectId: string, sourcePath: string, content?: string): string | null {
    const processingKey = `${projectId}:ingest:${sourcePath}`;
    if (!this.tryAcquireProcessing(processingKey)) return null;

    const taskId = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: WikiTaskInfo = {
      projectId,
      sourcePath,
      status: 'compiling',
      startedAt: new Date().toISOString(),
    };
    this.trackTask(taskId, task);

    setImmediate(async () => {
      try {
        const result = await this.ingest(projectId, sourcePath, content);
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
      } finally {
        this.releaseProcessing(processingKey);
      }
    });

    return taskId;
  }

  /**
   * Fire-and-forget batch content ingest — returns a task ID immediately.
   * Concurrent-control: same projectId is blocked while a task is in-flight.
   *
   * @returns taskId string on success, or **null** if a batch for this
   *          projectId is already in progress. Callers must handle null.
   */
  startBatchIngestContent(projectId: string, files: Array<{ source_path: string; content: string }>): string | null {
    const processingKey = `${projectId}:batch-content`;
    if (!this.tryAcquireProcessing(processingKey)) return null;

    const taskId = `batch-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: WikiTaskInfo = {
      projectId,
      sourcePath: `${files.length} files (content-based)`,
      status: 'compiling',
      startedAt: new Date().toISOString(),
    };
    this.trackTask(taskId, task);

    setImmediate(async () => {
      try {
        const result = await this.batchIngestContent(projectId, files);
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
      } finally {
        this.releaseProcessing(processingKey);
      }
    });

    return taskId;
  }

  /**
   * Fire-and-forget batch ingest — returns a task ID immediately.
   */
  startBatchIngest(projectId: string, dir: string, pattern?: string): string | null {
    const processingKey = `${projectId}:batch:${dir}`;
    if (!this.tryAcquireProcessing(processingKey)) return null;

    const taskId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: WikiTaskInfo = {
      projectId,
      sourcePath: dir,
      status: 'compiling',
      startedAt: new Date().toISOString(),
    };
    this.trackTask(taskId, task);

    setImmediate(async () => {
      try {
        const result = await this.batchIngest(projectId, dir, pattern);
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
      } finally {
        this.releaseProcessing(processingKey);
      }
    });

    return taskId;
  }

  /**
   * Derive batch-ingest parameters { dir, pattern } from document discovery.
   *
   * Walks the repository using discoverDocs (T2's filesystem walker + T1's
   * classifier), then analyzes the discovered files to determine:
   *
   * - **dir**: The common parent directory of the majority of docs. If a
   *   `docs/` (or `doc/`, `documentation/`) subdirectory exists and contains
   *   docs, that directory is used. Otherwise, the repo root is used.
   *
   * - **pattern**: A glob pattern matching the file extensions present among
   *   the discovered docs. If all docs share the same extension (e.g., .md),
   *   the pattern is a single-extension glob. If multiple extensions are
   *   present (e.g., .md and .rst), a brace-expansion pattern is used.
   *
   * If no documents are discovered, returns the repo root with the default
   * .md pattern -- batchIngest will simply find zero files.
   *
   * @param projectId - Project identifier (unused in discovery but required
   *   for API consistency with other methods)
   * @param repoPath - Absolute path to the repository root
   * @returns { dir, pattern } suitable for passing to batchIngest
   */
  async deriveBatchParams(
    projectId: string,
    repoPath: string,
  ): Promise<{ dir: string; pattern: string }> {
    const absRepo = resolve(repoPath);
    const docs = await discoverDocs(absRepo);

    // No docs discovered → safe defaults
    if (docs.length === 0) {
      return { dir: absRepo, pattern: '**/*.md' };
    }

    // --- Derive dir ---
    // Check if a docs/ directory exists and has docs inside it.
    const docSubdirs = ['docs', 'doc', 'documentation'];
    let targetDir = absRepo;

    for (const sub of docSubdirs) {
      const subPath = join(absRepo, sub);
      const docsInSub = docs.filter((d) => d.path.startsWith(sub + '/') || d.path.startsWith(sub + '\\'));
      if (docsInSub.length > 0) {
        targetDir = subPath;
        break;
      }
    }

    // If no docs/ subdir found, check if the majority of docs share a
    // common parent directory. If that parent is the repo root, use absRepo.
    if (targetDir === absRepo) {
      // Check if docs are scattered or all at root level
      const dirCounts = new Map<string, number>();
      for (const doc of docs) {
        const docDir = dirname(doc.path);
        const count = dirCounts.get(docDir) ?? 0;
        dirCounts.set(docDir, count + 1);
      }
      // If all docs are in the same non-root directory, use it
      if (dirCounts.size === 1) {
        const [onlyDir] = dirCounts.keys();
        if (onlyDir !== '.') {
          targetDir = join(absRepo, onlyDir);
        }
      }
    }

    // --- Derive pattern ---
    // Collect all unique extensions from discovered docs
    const extensions = new Set<string>();
    for (const doc of docs) {
      const ext = extname(doc.path).toLowerCase();
      if (ext) {
        extensions.add(ext);
      }
    }

    let pattern: string;
    if (extensions.size === 0) {
      pattern = '**/*.md'; // default fallback
    } else if (extensions.size === 1) {
      const [ext] = extensions;
      pattern = `**/*${ext}`;
    } else {
      // Multiple extensions → brace expansion pattern
      const sortedExts = [...extensions].sort();
      pattern = `**/*.{${sortedExts.map((e) => e.slice(1)).join(',')}}`;
    }

    return { dir: targetDir, pattern };
  }

  /**
   * Fire-and-forget auto-discover: discover docs, derive batch params, then
   * run batchIngest in the background.
   *
   * This is the one-shot orchestration that ties T2's discoverDocs to the
   * existing batchIngest pipeline:
   *
   * 1. discoverDocs(repoPath) → list of documents
   * 2. deriveBatchParams(projectId, repoPath) → { dir, pattern }
   * 3. batchIngest(projectId, dir, pattern) → BatchIngestResult
   *
   * Returns a taskId immediately; the actual ingestion runs via setImmediate.
   *
   * @param projectId - Project identifier for multi-tenant isolation
   * @param repoPath - Absolute path to the repository root
   * @returns taskId string on success, or **null** if auto-discovery for
   *          this repository is already in progress. Callers must handle null.
   */
  startAutoDiscover(projectId: string, repoPath: string): string | null {
    const processingKey = `${projectId}:discover:${repoPath}`;
    if (!this.tryAcquireProcessing(processingKey)) return null;

    const taskId = `auto-discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: WikiTaskInfo = {
      projectId,
      sourcePath: repoPath,
      status: 'compiling',
      startedAt: new Date().toISOString(),
    };
    this.trackTask(taskId, task);

    setImmediate(async () => {
      try {
        const { dir, pattern } = await this.deriveBatchParams(projectId, repoPath);
        const result = await this.batchIngest(projectId, dir, pattern);
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
      } finally {
        this.releaseProcessing(processingKey);
      }
    });

    return taskId;
  }

  // ==========================================
  // Ingest
  // ==========================================

  /**
   * Ingest a single source file.
   *
   * Flow: read file (or use provided content) -> check content hash (skip LLM if unchanged) ->
   *       get existing entities -> LLM compile -> create/update Source+Entities ->
   *       build relations -> log
   */
  async ingest(projectId: string, sourcePath: string, content?: string): Promise<IngestResult> {
    const absPath = resolve(sourcePath);
    const fileContent = content ?? await readFile(absPath, 'utf-8');

    // Compute content hash for idempotency check
    const contentHash = createHash('sha256').update(fileContent).digest('hex');
    const sourceId = this.sourceIdFromPath(absPath);

    // Check if the same content was already compiled (skip LLM if unchanged)
    const existingSource = await this.graph.query(
      'MATCH (s:WikiSource {id: $id, projectId: $pid}) RETURN s.content_hash AS hash, s.llm_output_hash AS llmHash',
      { id: sourceId, pid: projectId },
    );
    if (existingSource.length > 0) {
      const storedHash = (existingSource[0] as Record<string, unknown>).hash as string | undefined;
      if (storedHash === contentHash) {
        // Content unchanged — skip LLM entirely
        return {
          source: { id: sourceId, projectId, title: '', sourcePath: absPath, summary: '', keyPoints: [], compiledAt: '' },
          entitiesCreated: 0,
          entitiesUpdated: 0,
          contradictions: 0,
          skipped: true,
        };
      }
    }

    // Get existing entity names for dedup (scoped by projectId)
    const existingEntities = await this.graph.listEntities(projectId);
    const existingNames = existingEntities.map(e => e.name);

    // LLM compile
    const prompt = COMPILE_PROMPT(fileContent, existingNames);
    const raw = await this.llm.generateJSON<CompileOutput>(prompt);

    // Defensive: ensure all required fields exist (LLM may omit some)
    const compileOutput: CompileOutput = {
      title: raw?.title ?? basename(absPath),
      summary: raw?.summary ?? '',
      keyPoints: raw?.keyPoints ?? [],
      entities: raw?.entities ?? [],
      existingUpdates: raw?.existingUpdates ?? (raw as unknown as Record<string, unknown>)?.existing_updates ?? [],
      contradictions: raw?.contradictions ?? [],
    };

    const now = new Date().toISOString();

    // Compute a structural fingerprint of LLM output for idempotent write check (P2).
    // Uses a subset of semantically meaningful fields rather than full-text hash,
    // because LLM output "jitter" (e.g. whitespace, rephrasing) produces different
    // hashes for functionally identical outputs.
    const outputFingerprint = JSON.stringify({
      title: compileOutput.title,
      summary: compileOutput.summary,
      keyPoints: compileOutput.keyPoints,
      entities: compileOutput.entities.map(e => ({
        name: e.name,
        type: e.type,
        definition: e.definition,
      })),
      existingUpdates: compileOutput.existingUpdates.map(e => ({
        entityName: e.entityName,
        newInfo: e.newInfo,
      })),
    });
    const llmOutputHash = createHash('sha256').update(outputFingerprint).digest('hex');

    // Check if LLM output is unchanged — skip writes if nothing changed
    const existingLlmHash = existingSource.length > 0
      ? (existingSource[0] as Record<string, unknown>).llmHash as string | undefined
      : undefined;
    if (existingLlmHash === llmOutputHash) {
      return {
        source: { id: sourceId, projectId, title: '', sourcePath: absPath, summary: '', keyPoints: [], compiledAt: '' },
        entitiesCreated: 0,
        entitiesUpdated: 0,
        contradictions: 0,
        skipped: true,
      };
    }

    // Create or update Source (scoped by projectId)
    const source: WikiSource = {
      id: sourceId,
      projectId,
      title: compileOutput.title,
      sourcePath: absPath,
      summary: compileOutput.summary,
      keyPoints: compileOutput.keyPoints,
      compiledAt: now,
      contentHash,
      llmOutputHash,
    };
    await this.graph.createSource(source);

    // Process extracted entities
    let entitiesCreated = 0;
    let entitiesUpdated = 0;

    for (const extracted of compileOutput.entities) {
      if (!extracted?.name) continue; // skip malformed entities
      const entityId = extracted.name.toLowerCase().replace(/\s+/g, '-');

      // Check if entity already exists (scoped by projectId)
      const existing = await this.graph.findEntityByName(projectId, extracted.name);
      if (existing) {
        // Merge new details — wrapped in try/catch to handle Neo4j update failures
        try {
          const mergedDetails = await this.mergeEntityDetails(
            extracted.name,
            existing.details ?? '',
            extracted.details ?? '',
          );
          await this.graph.updateEntity(projectId, existing.id, {
            details: mergedDetails,
            lastUpdated: now,
          });

          // Update search index
          await this.indexEntityPage(projectId, existing.id, existing.name, mergedDetails, now);

          entitiesUpdated++;
        } catch (updateErr) {
          // Entity update failed (e.g., Neo4j parameter mismatch) — skip, entity retains existing data
        }
      } else {
        // Create new entity (scoped by projectId)
        // P0c-T3: Bind codeSignature from describes links (null if unbound)
        // v1.3.0 Phase 1 T1-3: Also capture codeNodeId for cross-domain edges
        const binding = await this.bindCodeSignature(projectId, extracted.links ?? []);
        const entity: WikiEntity = {
          id: entityId,
          projectId,
          name: extracted.name,
          entityType: extracted.type ?? 'concept',
          definition: extracted.definition ?? '',
          details: extracted.details ?? '',
          firstCompiled: now,
          lastUpdated: now,
          codeSignature: binding?.signature ?? null,
          // v1.3.0 Phase 1 T1-5: mark provenance for ingest/batchIngest path.
          // Future auto-derive (Phase 3) will set provenance='auto-derived'.
          provenance: 'manual',
        };
        await this.graph.createEntity(entity);

        // v1.3.0 Phase 1 T1-3: Write cross-domain edges (DESCRIBES + DOCUMENTED_BY)
        // Supplement to codeSignature property — enables O(1) graph traversal
        // and bi-temporal tracking of wiki↔code relationships.
        if (binding) {
          try {
            await this.graph.createCrossDomainEdges(
              projectId, entityId, binding.codeNodeId,
            );
          } catch {
            // Cross-domain edge write failed — non-fatal, property binding still works
          }
        }

        // Index in search
        await this.indexEntityPage(projectId, entityId, extracted.name, extracted.details ?? '', now);

        entitiesCreated++;
      }

      // Create EXTRACTS relation (source -> entity) — scoped by projectId
      await this.graph.createExtractsRelation(projectId, sourceId, entityId, `Extracted from ${basename(absPath)}`);

      // Create SOURCED_FROM relation (entity -> source) — scoped by projectId
      await this.graph.createSourcedFromRelation(projectId, entityId, sourceId, 'full-document');

      // Create LINKS_TO relations — scoped by projectId
      for (const link of extracted.links ?? []) {
        const targetId = link.target.toLowerCase().replace(/\s+/g, '-');
        try {
          await this.graph.createLinksToRelation(projectId, entityId, targetId, link.relationship);
        } catch {
          // Target entity may not exist yet; skip silently
        }
      }
    }

    // Process existing updates
    for (const update of compileOutput.existingUpdates) {
      if (!update?.entityName) continue;
      try {
        const existing = await this.graph.findEntityByName(projectId, update.entityName);
        if (existing) {
          const mergedDetails = await this.mergeEntityDetails(
            update.entityName,
            existing.details ?? '',
            update.newInfo ?? '',
          );
          await this.graph.updateEntity(projectId, existing.id, {
            details: mergedDetails,
            lastUpdated: now,
          });
          entitiesUpdated++;
        }
      } catch {
        // Entity update failed — skip, retain existing data
      }
    }

    // Index source page in search
    await this.indexSourcePage(projectId, sourceId, compileOutput.title, compileOutput.summary, now);

    // Log
    await this.logAction(projectId, 'ingest', `Compiled ${basename(absPath)}`, `Created ${entitiesCreated} entities, updated ${entitiesUpdated}, contradictions: ${compileOutput.contradictions.length}`, 1 + entitiesCreated + entitiesUpdated);

    return {
      source,
      entitiesCreated,
      entitiesUpdated,
      contradictions: compileOutput.contradictions.length,
    };
  }

  /**
   * Batch ingest all files matching a glob pattern in a directory.
   */
  async batchIngest(projectId: string, dir: string, pattern: string = '**/*.md'): Promise<BatchIngestResult> {
    const absDir = resolve(dir);
    const files = await glob(pattern, { cwd: absDir, absolute: true });

    const results: IngestResult[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const result = await this.ingest(projectId, file);
        results.push(result);
      } catch (err) {
        errors.push({
          path: file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log
    await this.logAction(
      projectId,
      'batch_ingest',
      `Batch ingested ${absDir}`,
      `Compiled: ${results.length}, Errors: ${errors.length}`,
      results.reduce((sum, r) => sum + 1 + r.entitiesCreated + r.entitiesUpdated, 0),
    );

    return {
      results,
      totalCompiled: results.length,
      errors,
    };
  }

  /**
   * Batch ingest files provided as content (no filesystem access needed).
   * Each file is an object with source_path (used as identifier) and content.
   */
  async batchIngestContent(projectId: string, files: Array<{ source_path: string; content: string }>): Promise<BatchIngestResult> {
    const results: IngestResult[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const result = await this.ingest(projectId, file.source_path, file.content);
        results.push(result);
      } catch (err) {
        errors.push({
          path: file.source_path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Log
    await this.logAction(
      projectId,
      'batch_ingest_content',
      `Batch ingested ${files.length} files (content-based)`,
      `Compiled: ${results.length}, Errors: ${errors.length}`,
      results.reduce((sum, r) => sum + 1 + r.entitiesCreated + r.entitiesUpdated, 0),
    );

    return {
      results,
      totalCompiled: results.length,
      errors,
    };
  }

  // ==========================================
  // Query
  // ==========================================

  /**
   * Query the wiki: hybrid search + LLM synthesis.
   *
   * If writeBack is true (or config.autoWriteBack), saves the answer as a Topic.
   */
  async query(projectId: string, question: string, writeBack?: boolean): Promise<string> {
    // Generate embedding for the question
    const queryEmbedding = await this.generateEmbedding(question);

    // Hybrid search (still global "wiki" collection; project filter applied in context building)
    const searchResults = await this.search.searchPages(question, queryEmbedding, 10);

    // Build context from search results — scoped by projectId
    const contextPages = await this.buildContextFromResults(projectId, searchResults);

    // LLM synthesize
    const prompt = SYNTHESIZE_PROMPT(question, contextPages);
    const answer = await this.llm.generate(prompt);

    // Optional write-back as Topic (de-duplicated by projectId + question)
    const shouldWriteBack = writeBack ?? this.config.autoWriteBack;
    if (shouldWriteBack && answer.trim()) {
      const now = new Date().toISOString();

      // Check if a Topic with the same projectId + title already exists
      const existing = await this.graph.query(
        'MATCH (t:WikiTopic {projectId: $pid, title: $q}) RETURN t.id AS id',
        { pid: projectId, q: question },
      );

      if (existing.length > 0) {
        // Update existing Topic content
        const existingId = (existing[0] as Record<string, unknown>).id as string;
        await this.graph.query(
          'MATCH (t:WikiTopic {id: $id}) SET t.content = $content, t.compiled_at = $now',
          { id: existingId, content: answer, now },
        );
        await this.indexTopicPage(projectId, existingId, question, answer, now);
        await this.logAction(projectId, 'query', `Queried: ${question}`, `Topic updated: ${existingId}`, 1);
      } else {
        // Create new Topic
        const topicId = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const topic: WikiTopic = {
          id: topicId,
          projectId,
          title: question,
          content: answer,
          compiledAt: now,
        };
        await this.graph.createTopic(topic);
        await this.indexTopicPage(projectId, topicId, question, answer, now);
        await this.logAction(projectId, 'query', `Queried: ${question}`, `Topic written: ${topicId}`, 1);
      }
    } else {
      await this.logAction(projectId, 'query', `Queried: ${question}`, 'Answer generated (no write-back)', 0);
    }

    return answer;
  }

  // ==========================================
  // Index & Status
  // ==========================================

  /**
   * Return the aggregated WikiIndex (knowledge map), scoped by projectId.
   */
  async getIndex(projectId: string): Promise<WikiIndex> {
    return this.graph.getIndex(projectId);
  }

  /**
   * List compiled sources and classify files in a directory as compiled/uncompiled.
   */
  async status(projectId: string, dir?: string): Promise<WikiStatus> {
    const sources = await this.graph.listSources(projectId);
    const compiledPathSet = new Set<string>();

    const compiled: WikiStatus['compiled'] = [];
    for (const s of sources) {
      compiled.push({ path: s.sourcePath, sourceId: s.id, compiledAt: s.compiledAt });
      compiledPathSet.add(s.sourcePath);
    }

    const uncompiled: WikiStatus['uncompiled'] = [];

    if (dir) {
      const absDir = resolve(dir);
      const files = await glob('**/*.md', { cwd: absDir, absolute: true });

      for (const file of files) {
        if (!compiledPathSet.has(file)) {
          uncompiled.push({ path: file });
        }
      }
    }

    return {
      compiled,
      uncompiled,
      total: compiled.length + uncompiled.length,
    };
  }

  // ==========================================
  // Entity Access (all scoped by projectId)
  // ==========================================

  /**
   * Direct entity lookup.
   */
  async getEntity(projectId: string, entityId: string): Promise<WikiEntity | null> {
    return this.graph.getEntity(projectId, entityId);
  }

  /**
   * P2-T5: Direct topic lookup by ID, scoped by projectId.
   *
   * Used by GET /api/wiki/evolution-story/:topicId to retrieve
   * a stored evolution narrative.
   */
  async getTopic(projectId: string, topicId: string): Promise<WikiTopic | null> {
    return this.graph.getTopic(projectId, topicId);
  }

  /**
   * List all entities, optionally filtered by type.
   */
  async listEntities(projectId: string, type?: EntityType): Promise<WikiEntity[]> {
    return this.graph.listEntities(projectId, type);
  }

  /**
   * Fuzzy match: substring match against entity names and definitions.
   * Used as a fallback when hybrid search returns no results.
   */
  async fuzzyMatch(projectId: string, question: string): Promise<Array<{ entity: WikiEntity; score: number }>> {
    const entities = await this.graph.listEntities(projectId);
    const lowerQuestion = question.toLowerCase();
    const results: Array<{ entity: WikiEntity; score: number }> = [];

    for (const entity of entities) {
      let score = 0;

      const lowerName = entity.name.toLowerCase();
      const lowerDef = entity.definition.toLowerCase();

      // Exact name match
      if (lowerName === lowerQuestion) {
        score = 1.0;
      }
      // Name contains question or question contains name
      else if (lowerName.includes(lowerQuestion) || lowerQuestion.includes(lowerName)) {
        score = 0.8;
      }
      // Definition contains question words
      else {
        const words = lowerQuestion.split(/\s+/).filter(w => w.length > 2);
        let matchCount = 0;
        for (const word of words) {
          if (lowerDef.includes(word)) matchCount++;
        }
        if (words.length > 0) {
          score = (matchCount / words.length) * 0.5;
        }
      }

      if (score > 0) {
        results.push({ entity, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 10);
  }

  // ==========================================
  // Reindex
  // ==========================================

  /**
   * Re-index all wiki entities and sources from Neo4j into Typesense + Qdrant.
   * Used when search stores are empty or corrupted (e.g., after Qdrant ID format fix).
   */
  async reindex(projectId: string): Promise<{ entities: number; sources: number; topics: number; errors: number }> {
    const [entities, sources, topics] = await Promise.all([
      this.graph.listEntities(projectId),
      this.graph.listSources(projectId),
      this.graph.listTopics(projectId),
    ]);

    let entityErrors = 0;
    let sourceErrors = 0;
    let topicErrors = 0;

    // Re-index entities
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      try {
        const embedding = await this.generateEmbedding(`${entity.name}: ${entity.details}`);
        const page: WikiPageDoc = {
          id: entity.id,
          projectId,
          pageType: 'entity',
          title: entity.name,
          content: entity.details,
          compiledAt: new Date(entity.lastUpdated).getTime() / 1000,
        };
        await this.search.indexPage(page, embedding);
      } catch (err) {
        entityErrors++;
        console.warn(`[Wiki] Reindex entity "${entity.id}" failed:`, err instanceof Error ? err.message : err);
      }

      if ((i + 1) % 50 === 0) {
        console.log(`[Wiki] Reindex entities: ${i + 1}/${entities.length}`);
      }
    }

    // Re-index sources
    for (const source of sources) {
      try {
        const embedding = await this.generateEmbedding(`${source.title}: ${source.summary}`);
        const page: WikiPageDoc = {
          id: source.id,
          projectId,
          pageType: 'source',
          title: source.title,
          content: source.summary,
          compiledAt: new Date(source.compiledAt).getTime() / 1000,
        };
        await this.search.indexPage(page, embedding);
      } catch (err) {
        sourceErrors++;
        console.warn(`[Wiki] Reindex source "${source.id}" failed:`, err instanceof Error ? err.message : err);
      }
    }

    // Re-index topics
    for (const topic of topics) {
      try {
        const embedding = await this.generateEmbedding(`${topic.title}: ${topic.content}`);
        const page: WikiPageDoc = {
          id: topic.id,
          projectId,
          pageType: 'topic',
          title: topic.title,
          content: topic.content,
          compiledAt: new Date(topic.compiledAt).getTime() / 1000,
        };
        await this.search.indexPage(page, embedding);
      } catch (err) {
        topicErrors++;
        console.warn(`[Wiki] Reindex topic "${topic.id}" failed:`, err instanceof Error ? err.message : err);
      }
    }

    await this.logAction(
      projectId,
      'reindex',
      'Re-indexed all wiki pages into search stores',
      `Entities: ${entities.length} (${entityErrors} errors), Sources: ${sources.length} (${sourceErrors} errors), Topics: ${topics.length} (${topicErrors} errors)`,
      entities.length + sources.length + topics.length,
    );

    return {
      entities: entities.length,
      sources: sources.length,
      topics: topics.length,
      errors: entityErrors + sourceErrors + topicErrors,
    };
  }

  // ==========================================
  // Lint
  // ==========================================

  /**
   * Check for orphans, missing refs, stale entities, and contradictions.
   */
  async lint(projectId: string): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    const entities = await this.graph.listEntities(projectId);
    const sources = await this.graph.listSources(projectId);
    const now = Date.now();
    const staleThresholdMs = this.config.staleDays * 24 * 60 * 60 * 1000;

    const entityIds = new Set(entities.map(e => e.id));

    for (const entity of entities) {
      // Check stale
      const lastUpdated = new Date(entity.lastUpdated).getTime();
      if (now - lastUpdated > staleThresholdMs) {
        issues.push({
          type: 'stale',
          entityId: entity.id,
          entityName: entity.name,
          description: `Entity "${entity.name}" last updated ${this.daysSince(entity.lastUpdated)} days ago (threshold: ${this.config.staleDays})`,
          severity: 'warning',
        });
      }

      // Check for orphan (no incoming/outgoing LINKS_TO within this project)
      const outgoingLinks = await this.graph.getOutgoingLinks(projectId, entity.id);
      const incomingLinks = await this.graph.getIncomingLinks(projectId, entity.id);
      if (outgoingLinks.length === 0 && incomingLinks.length === 0) {
        // Check if it's a new entity (created today) — might not be linked yet
        const ageMs = now - new Date(entity.firstCompiled).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) {
          issues.push({
            type: 'orphan',
            entityId: entity.id,
            entityName: entity.name,
            description: `Entity "${entity.name}" has no links to/from other entities`,
            severity: 'warning',
          });
        }
      }

      // Check for missing refs in LINKS_TO targets
      for (const targetId of outgoingLinks) {
        if (!entityIds.has(targetId)) {
          issues.push({
            type: 'missing_ref',
            entityId: entity.id,
            entityName: entity.name,
            description: `Entity "${entity.name}" links to non-existent entity "${targetId}"`,
            severity: 'error',
          });
        }
      }

      // P0c-T4: Check entity freshness (code signature staleness)
      // Uses checkEntityFreshness 4-state machine to detect unbound/stale/orphaned
      const freshnessResult = await checkEntityFreshness(
        projectId,
        entity,
        this.codeStore,
      );
      if (freshnessResult.issue) {
        issues.push(freshnessResult.issue);
      }
    }

    // Check for sources with no extracted entities
    for (const source of sources) {
      // Sources that are too old and have no entities
      const sourceAge = now - new Date(source.compiledAt).getTime();
      if (sourceAge > staleThresholdMs) {
        issues.push({
          type: 'stale',
          entityId: source.id,
          entityName: source.title,
          description: `Source "${source.title}" compiled ${this.daysSince(source.compiledAt)} days ago`,
          severity: 'warning',
        });
      }
    }

    return issues;
  }

  // ==========================================
  // Freshness (P0c-T5)
  // ==========================================

  /**
   * Get entity freshness report for a project.
   *
   * Calls checkEntityFreshness for each wiki entity and returns a structured
   * report with 4-state classification: fresh, stale, orphaned, unbound.
   *
   * @param projectId - The project to query
   * @returns FreshnessReport with items array and summary counts
   */
  async getFreshness(projectId: string): Promise<{
    items: Array<{
      entityId: string;
      entityName: string;
      status: import('./entity-freshness.js').EntityFreshnessState;
      issue: import('./models.js').LintIssue | null;
    }>;
    summary: Record<import('./entity-freshness.js').EntityFreshnessState, number>;
  }> {
    const entities = await this.graph.listEntities(projectId);

    type FreshnessState = import('./entity-freshness.js').EntityFreshnessState;
    const summary: Record<FreshnessState, number> = {
      fresh: 0,
      stale: 0,
      orphaned: 0,
      unbound: 0,
    };

    const items: Array<{
      entityId: string;
      entityName: string;
      status: FreshnessState;
      issue: import('./models.js').LintIssue | null;
    }> = [];

    for (const entity of entities) {
      const result = await checkEntityFreshness(projectId, entity, this.codeStore);
      summary[result.state]++;
      items.push({
        entityId: entity.id,
        entityName: entity.name,
        status: result.state,
        issue: result.issue ?? null,
      });
    }

    return { items, summary };
  }

  // ==========================================
  // Sync to Jelly
  // ==========================================

  /**
   * Render entities/topics as Markdown and sync to Jelly KB.
   * Placeholder implementation — actual Jelly KB API integration in future plan.
   */
  async syncToJelly(projectId: string, kbId: string): Promise<{ pagesSynced: number; errors: string[] }> {
    const errors: string[] = [];
    let pagesSynced = 0;

    const entities = await this.graph.listEntities(projectId);
    const topics = await this.graph.listTopics(projectId);

    // Render entities as Markdown
    for (const entity of entities) {
      const markdown = this.renderEntityMarkdown(entity);
      void markdown; // placeholder — would call Jelly KB API
      pagesSynced++;
    }

    // Render topics as Markdown
    for (const topic of topics) {
      const markdown = this.renderTopicMarkdown(topic);
      void markdown; // placeholder — would call Jelly KB API
      pagesSynced++;
    }

    await this.logAction(
      projectId,
      'sync',
      `Synced to Jelly KB ${kbId}`,
      `Pages synced: ${pagesSynced}`,
      pagesSynced,
    );

    return { pagesSynced, errors };
  }

  // ==========================================
  // Evolution Story (P2-T4)
  // ==========================================

  /**
   * Generate and store a code evolution story as a WikiTopic.
   *
   * Orchestrates P2-T1 through T3:
   *   1. T1: gatherEvolutionFacts — collects 5 graph data sources
   *   2. T2: detectChapters — classifies timeline into phases
   *   3. T3: generateNarrative — LLM narrative + validateNarrative
   *   4. T4: Store the result as WikiTopic with topicType='evolution'
   *
   * If data is insufficient (no commits, no lineage), returns a topic
   * with an explanatory message instead of calling the LLM.
   *
   * @param projectId - Project scope for isolation
   * @param nodeId - The code symbol to generate an evolution story for
   * @returns WikiTopic with topicType='evolution'
   */
  async generateEvolutionStory(projectId: string, nodeId: string): Promise<WikiTopic> {
    // Step 1: Gather evolution facts (T1)
    const facts = await gatherEvolutionFacts(projectId, nodeId, this.codeStore);

    // Check data sufficiency before further processing
    const hasSufficientData =
      facts.changedIn.length > 0 || facts.evolvedFrom.length > 0;

    // Step 2 + 3: If insufficient data, skip chapter detection + narrative
    let narrative: string;
    if (!hasSufficientData) {
      narrative = 'Insufficient data to generate evolution narrative — no commits or lineage information available.';
    } else {
      // Step 2: Detect chapters from timeline (T2)
      const chapters = detectChapters({
        changeTimeline: facts.changeTimeline.map((t) => ({
          timestamp: t.timestamp,
        })),
      });

      // Step 3: Generate narrative via LLM (T3)
      narrative = await generateNarrative(facts, chapters, this.llm);

      // Step 3b: Validate narrative for fabricated commits (T3 anti-hallucination)
      const issues = validateNarrative(narrative, facts);
      if (issues.length > 0) {
        // Log validation issues — do not discard the narrative, but flag
        // for debugging. The narrative may still contain useful information.
        console.warn(
          `[Wiki] Evolution story for ${nodeId}: ${issues.length} validation issue(s) detected`,
          issues.map((i) => i.type).join(', '),
        );
      }
    }

    // Step 4: Store as WikiTopic with topicType='evolution'
    const topicId = `topic-evolution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const topic: WikiTopic = {
      id: topicId,
      projectId,
      title: `${nodeId} 演化史`,
      content: narrative,
      compiledAt: now,
      topicType: 'evolution',
    };
    await this.graph.createTopic(topic);

    // Index topic in search
    await this.indexTopicPage(projectId, topicId, topic.title, narrative, now);

    // Log
    await this.logAction(
      projectId,
      'query',
      `Generated evolution story for ${nodeId}`,
      `Topic written: ${topicId}`,
      1,
    );

    return topic;
  }

  /**
   * P2-T5: Fire-and-forget evolution story generation — returns a task ID immediately.
   *
   * The actual generation runs via setImmediate in the background, matching
   * the pattern of startIngest / startBatchIngest / startAutoDiscover.
   *
   * The caller can poll GET /api/wiki/status for task status, then use
   * GET /api/wiki/evolution-story/:topicId once the topic is stored.
   *
   * @param projectId - Project scope for isolation
   * @param nodeId - The code symbol to generate an evolution story for
   * @returns taskId string on success, or **null** if generation for this
   *          symbol is already in progress. Callers must handle null.
   */
  startEvolutionStoryGeneration(projectId: string, nodeId: string): string | null {
    const processingKey = `${projectId}:evo:${nodeId}`;
    if (!this.tryAcquireProcessing(processingKey)) return null;

    const taskId = `evo-story-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const task: WikiTaskInfo = {
      projectId,
      sourcePath: nodeId,
      status: 'compiling',
      startedAt: new Date().toISOString(),
    };
    this.trackTask(taskId, task);

    setImmediate(async () => {
      try {
        const result = await this.generateEvolutionStory(projectId, nodeId);
        task.status = 'done';
        task.result = result;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        task.status = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = new Date().toISOString();
      } finally {
        this.releaseProcessing(processingKey);
      }
    });

    return taskId;
  }

  // ==========================================
  // Batch Evolution Story (P2-T7)
  // ==========================================

  /**
   * P2-T7: Batch generate evolution stories for "important" code nodes.
   *
   * Importance criteria (either triggers generation):
   *   - CHANGED_IN count > 10 (actively developed)
   *   - EVOLVED_FROM chain length > 2 (significantly renamed/refactored)
   *
   * For each qualifying node, calls generateEvolutionStory. Individual
   * failures are collected in errors[] — batch does not abort.
   *
   * @param projectId - Project scope for isolation
   * @returns Summary { generated, skipped, errors }
   */
  async generateAllEvolutionStories(
    projectId: string,
  ): Promise<{ generated: number; skipped: number; errors: string[] }> {
    // P2-T8: Cost control — use config thresholds
    const maxCalls = this.config.maxLlmCallsPerBatch > 0 ? this.config.maxLlmCallsPerBatch : Infinity;
    const importanceThreshold = this.config.importanceThreshold;
    const evolutionDepthThreshold = this.config.evolutionDepthThreshold;

    // Step 1: List all CodeNodes for this project
    const nodeRows = await this.codeStore.query(
      `MATCH (n {projectId: $projectId}) RETURN n.id AS nodeId, n.name AS name`,
      { projectId },
    );

    const nodes = (nodeRows as Array<Record<string, unknown>>).map(r => ({
      nodeId: (r.nodeId as string) ?? '',
      name: (r.name as string) ?? '',
    })).filter(n => n.nodeId);

    let generated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const node of nodes) {
      // P2-T8: Cost control gate — stop if we've hit the LLM call budget
      if (generated >= maxCalls) {
        skipped += nodes.length - (generated + skipped + errors.length);
        break;
      }

      try {
        // Step 2: Check importance via lightweight count queries
        // (avoid double-calling gatherEvolutionFacts, which generateEvolutionStory will call internally)

        // Count CHANGED_IN edges for this node
        const changedInRows = await this.codeStore.query(
          `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'CHANGED_IN'}]->(c:Commit)
           RETURN count(r) AS cnt`,
          { projectId, nodeId: node.nodeId },
        );
        const changedInCount = Number(
          (changedInRows[0] as Record<string, unknown>)?.cnt ?? 0,
        );

        // Count EVOLVED_FROM chain length (iterative, max 10)
        let evolvedFromDepth = 0;
        let currentId = node.nodeId;
        for (let depth = 0; depth < 10; depth++) {
          const evoRows = await this.codeStore.query(
            `MATCH (n {id: $nodeId, projectId: $projectId})-[r:CODE_RELATION {type: 'EVOLVED_FROM'}]->(prev)
             RETURN prev.id AS prevId LIMIT 1`,
            { projectId, nodeId: currentId },
          );
          if (evoRows.length === 0) break;
          evolvedFromDepth++;
          currentId = (evoRows[0] as Record<string, unknown>).prevId as string;
          if (!currentId) break;
        }

        // Step 3: Check importance criteria (P2-T8: configurable thresholds)
        const isImportant = changedInCount > importanceThreshold || evolvedFromDepth > evolutionDepthThreshold;

        if (!isImportant) {
          skipped++;
          continue;
        }

        // Step 4: Generate evolution story
        await this.generateEvolutionStory(projectId, node.nodeId);
        generated++;
      } catch (err) {
        errors.push(
          `${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Log batch result
    await this.logAction(
      projectId,
      'query',
      `Batch evolution stories for ${projectId}`,
      `Generated: ${generated}, Skipped: ${skipped}, Errors: ${errors.length}`,
      generated,
    );

    return { generated, skipped, errors };
  }

  // ==========================================
  // Private helpers
  // ==========================================

  /**
   * P0c-T3: Bind a CodeSignature to a wiki entity by looking up code nodes
   * referenced in "describes" links.
   *
   * v1.3.0 Phase 1 T1-3: Also returns the matched codeNodeId so the caller
   * can create DESCRIBES/DOCUMENTED_BY cross-domain edges after the entity
   * is persisted.
   *
   * For each link with relationship === 'describes':
   * 1. Extract the target symbol name (strip any "fn:"/"class:" prefix)
   * 2. Query the graph store (findSymbol) for the code node
   * 3. If found with `content`, generate a CodeSignature via generateSignature()
   * 4. Return the first successful signature + the codeNodeId
   *
   * If no describes link exists, or all lookups fail, returns `null` (explicit
   * unbound per P0c-T2 semantics: null = intentionally unbound, undefined = pre-P0c).
   *
   * @param projectId - Project scope for the code lookup
   * @param links - ExtractedEntity links array
   * @returns `{ signature, codeNodeId }` on success, null if unbound or lookup failed
   */
  private async bindCodeSignature(
    projectId: string,
    links: Array<{ target: string; relationship: string }>,
  ): Promise<{ signature: CodeSignature; codeNodeId: string } | null> {
    const describesLinks = links.filter((l) => l.relationship === 'describes');

    // No describes link → explicitly unbound
    if (describesLinks.length === 0) {
      return null;
    }

    for (const link of describesLinks) {
      // Strip common prefixes (fn:, class:, iface:, module:) from target
      const symbolName = link.target.replace(/^(fn|class|iface|module):/, '');

      try {
        const nodes = await this.codeStore.findSymbol(projectId, symbolName);
        const codeNode = nodes.find((n) => n.content);
        if (!codeNode || !codeNode.content) continue;

        // Generate signature from the code node's source content
        // Use the code node's name if available (more precise than extracted name)
        try {
          const signature = generateSignature(codeNode.content, codeNode.name ?? symbolName);
          return { signature, codeNodeId: codeNode.id };
        } catch {
          // generateSignature failed (e.g., unparseable source) — try next link
          continue;
        }
      } catch {
        // findSymbol failed (e.g., Neo4j error) — try next link
        continue;
      }
    }

    // All describes links were attempted but none yielded a valid signature
    return null;
  }

  /**
   * Generate an embedding vector from text.
   * Uses the existing embedding pipeline from core/embeddings.
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    // Auto-init embedder if not ready. This handles the case where
    // Wiki indexing is the first consumer of embedding (no prior
    // EmbeddingPipeline call that would have triggered initEmbedder).
    if (!isEmbedderReady()) {
      try {
        await initEmbedder();
      } catch {
        // Non-fatal: if embedder fails to initialize (e.g. no ONNX binary),
        // Wiki search degrades to keyword-only, core functionality unaffected.
        return [];
      }
    }
    const vec = await embedText(text);
    return embeddingToArray(vec);
  }

  /**
   * Merge entity details using LLM.
   */
  private async mergeEntityDetails(
    entityName: string,
    existingDetails: string,
    newInfo: string,
  ): Promise<string> {
    // If existing is empty, just use new
    if (!existingDetails.trim()) return newInfo;

    // If new info is a subset of existing, skip
    if (existingDetails.includes(newInfo.trim())) return existingDetails;

    const prompt = MERGE_PROMPT(entityName, existingDetails, newInfo);
    return this.llm.generate(prompt);
  }

  /**
   * Build context string from search results for LLM synthesis.
   * Filters out search hits that don't belong to the requested projectId.
   */
  private async buildContextFromResults(projectId: string, results: WikiPageDoc[]): Promise<string> {
    if (results.length === 0) return '(no relevant wiki pages found)';

    const parts: string[] = [];
    for (const page of results) {
      // Try entity lookup first (most common) — scoped by projectId
      const entity = await this.graph.getEntity(projectId, page.id);
      if (entity) {
        parts.push(`## Entity: ${entity.name} (${entity.entityType})\n${entity.definition}\n\n${entity.details}`);
        continue;
      }

      // Try source lookup — scoped by projectId
      const source = await this.graph.getSource(projectId, page.id);
      if (source) {
        parts.push(`## Source: ${source.title}\n${source.summary}\n\nKey Points: ${(source.keyPoints || []).join(', ')}`);
        continue;
      }

      // For topics, use page content from search result (only if same project)
      if (page.projectId === projectId && page.content) {
        parts.push(`## Topic: ${page.title || page.id}\n${page.content}`);
      }
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : '(no detailed content available)';
  }

  /**
   * Index an entity page in the search stores.
   */
  private async indexEntityPage(
    projectId: string,
    entityId: string,
    name: string,
    details: string,
    compiledAt: string,
  ): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(`${name}: ${details}`);
      const page: WikiPageDoc = {
        id: entityId,
        projectId,
        pageType: 'entity',
        title: name,
        content: details,
        compiledAt: new Date(compiledAt).getTime() / 1000,
      };
      await this.search.indexPage(page, embedding);
    } catch (err) {
      console.warn(`[Wiki] Failed to index entity "${entityId}" in search stores:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Index a source page in the search stores.
   */
  private async indexSourcePage(
    projectId: string,
    sourceId: string,
    title: string,
    summary: string,
    compiledAt: string,
  ): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(`${title}: ${summary}`);
      const page: WikiPageDoc = {
        id: sourceId,
        projectId,
        pageType: 'source',
        title,
        content: summary,
        compiledAt: new Date(compiledAt).getTime() / 1000,
      };
      await this.search.indexPage(page, embedding);
    } catch (err) {
      console.warn(`[Wiki] Failed to index source "${sourceId}" in search stores:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Index a topic page in the search stores.
   */
  private async indexTopicPage(
    projectId: string,
    topicId: string,
    title: string,
    content: string,
    compiledAt: string,
  ): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(`${title}: ${content}`);
      const page: WikiPageDoc = {
        id: topicId,
        projectId,
        pageType: 'topic',
        title,
        content,
        compiledAt: new Date(compiledAt).getTime() / 1000,
      };
      await this.search.indexPage(page, embedding);
    } catch (err) {
      console.warn(`[Wiki] Failed to index topic "${topicId}" in search stores:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Generate a source ID from a file path.
   * Uses MD5 hash of the full path to avoid collisions between files with the same basename.
   */
  private sourceIdFromPath(absPath: string): string {
    const hash = createHash('md5').update(absPath).digest('hex').slice(0, 12);
    const name = basename(absPath, '.md').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30);
    return `source-${name}-${hash}`;
  }

  /**
   * Log a wiki action.
   */
  /** Track log cleanup state per project to avoid redundant count queries */
  private _logCleanupCounters = new Map<string, number>();

  private async logAction(
    projectId: string,
    action: WikiLogEntry['action'],
    description: string,
    details: string,
    pageCount: number,
  ): Promise<void> {
    const entry: WikiLogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      action,
      description,
      details,
      pageCount,
      createdAt: new Date().toISOString(),
    };
    await this.graph.appendLog(entry);

    // Rate-limited cleanup: only check log count every 10 writes per project.
    // The MATCH count(l) query is a full label scan on every log write, so
    // throttling it avoids unnecessary Neo4j overhead on batch operations.
    const counter = (this._logCleanupCounters.get(projectId) ?? 0) + 1;
    this._logCleanupCounters.set(projectId, counter);
    if (counter % 10 !== 0) return;

    // Async cleanup: keep at most 500 log entries per project (P1 TTL)
    setImmediate(async () => {
      try {
        const result = await this.graph.query(
          'MATCH (l:WikiLogEntry {projectId: $pid}) RETURN count(l) AS cnt',
          { pid: projectId },
        );
        const count = Number((result[0] as Record<string, unknown>)?.cnt ?? 0);
        if (count > 500) {
          const excess = count - 500;
          await this.graph.query(
            `MATCH (l:WikiLogEntry {projectId: $pid})
             WITH l ORDER BY l.created_at ASC LIMIT $excess
             DELETE l`,
            { pid: projectId, excess },
          );
        }
      } catch {
        // Non-fatal: log cleanup failure should not affect the caller
      }
    });
  }

  /**
   * Render a WikiEntity as Markdown for sync.
   */
  private renderEntityMarkdown(entity: WikiEntity): string {
    return `# ${entity.name}

**Type**: ${entity.entityType}
**Definition**: ${entity.definition}

${entity.details}

*First compiled: ${entity.firstCompiled}*
*Last updated: ${entity.lastUpdated}*
`;
  }

  /**
   * Render a WikiTopic as Markdown for sync.
   */
  private renderTopicMarkdown(topic: WikiTopic): string {
    return `# ${topic.title}

${topic.content}

*Compiled: ${topic.compiledAt}*
`;
  }

  /**
   * Calculate days since a given ISO date string.
   */
  private daysSince(isoDate: string): number {
    const then = new Date(isoDate).getTime();
    const now = Date.now();
    return Math.floor((now - then) / (24 * 60 * 60 * 1000));
  }
}
