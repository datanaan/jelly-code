/**
 * Typesense Collection Manager
 *
 * Manages the lifecycle of Typesense collections:
 * - TTL-based registration for auto-cleanup of stale collections
 * - Periodic scan for orphaned collections (no corresponding project in Neo4j)
 * - Collection health checks
 *
 * T7: Each project gets its own collection {projectId}_code.
 * This manager ensures we don't leak collections when projects are deleted
 * (especially in edge cases where the deletion event is missed).
 */

import type Typesense from 'typesense';
import { logger } from '../../core/logger.js';

export interface CollectionInfo {
  name: string;
  numDocuments: number;
  createdAt?: string;
  projectId: string;
}

export interface CollectionManagerConfig {
  /** How often (ms) to scan for orphaned collections. Default: 1 hour */
  scanIntervalMs: number;
  /** Max age (ms) before an unregistered collection is considered orphaned. Default: 24h */
  orphanTtlMs: number;
  /** Whether auto-cleanup is enabled. Default: true */
  autoCleanup: boolean;
}

const DEFAULT_CONFIG: CollectionManagerConfig = {
  scanIntervalMs: 60 * 60 * 1000, // 1 hour
  orphanTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  autoCleanup: true,
};

/**
 * Manager for Typesense collection lifecycle.
 * Tracks which collections are actively registered and cleans up orphans.
 */
export class CollectionManager {
  private client: Typesense.Client;
  private config: CollectionManagerConfig;
  /** Map of collection name → registration timestamp (ms) */
  private registered = new Map<string, number>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(client: Typesense.Client, config?: Partial<CollectionManagerConfig>) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a collection as actively in use.
   * Call this after ensureCollection() to mark it as active.
   */
  register(collectionName: string): void {
    this.registered.set(collectionName, Date.now());
  }

  /**
   * Unregister a collection (called when a project is deleted).
   */
  unregister(collectionName: string): void {
    this.registered.delete(collectionName);
  }

  /**
   * Check if a collection is currently registered as active.
   */
  isRegistered(collectionName: string): boolean {
    return this.registered.has(collectionName);
  }

  /**
   * Start periodic orphan collection scanning.
   * @param listActiveProjects - Function that returns the set of active project IDs
   */
  startScanning(listActiveProjects: () => Promise<Set<string>>): void {
    if (this.scanTimer) return;

    this.scanTimer = setInterval(async () => {
      try {
        await this.scanAndCleanup(listActiveProjects);
      } catch (err) {
        logger.warn({ err }, 'CollectionManager: scan cycle failed');
      }
    }, this.config.scanIntervalMs);

    // Prevent the timer from keeping the process alive
    if (this.scanTimer && typeof this.scanTimer === 'object' && 'unref' in this.scanTimer) {
      (this.scanTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Stop periodic scanning.
   */
  stopScanning(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /**
   * List all collections that match the project pattern (*_code).
   */
  async listProjectCollections(): Promise<CollectionInfo[]> {
    try {
      const collections = await this.client.collections().retrieve();
      return collections
        .filter(c => c.name.endsWith('_code'))
        .map(c => ({
          name: c.name,
          numDocuments: (c as unknown as Record<string, unknown>).num_documents as number || 0,
          projectId: c.name.replace(/_code$/, ''),
        }));
    } catch (err) {
      logger.warn({ err }, 'CollectionManager: failed to list collections');
      return [];
    }
  }

  /**
   * Scan for orphaned collections and clean them up.
   * An orphan is a collection that exists in Typesense but has no corresponding
   * active project in Neo4j and is not in our registration map.
   *
   * @returns Array of orphan collection names that were deleted
   */
  async scanAndCleanup(listActiveProjects: () => Promise<Set<string>>): Promise<string[]> {
    if (!this.config.autoCleanup) return [];

    const collections = await this.listProjectCollections();
    const activeProjects = await listActiveProjects();
    const orphans: string[] = [];

    for (const col of collections) {
      // Not orphaned if actively registered recently
      const registeredAt = this.registered.get(col.name);
      if (registeredAt && (Date.now() - registeredAt) < this.config.orphanTtlMs) {
        continue;
      }

      // Not orphaned if project still exists
      if (activeProjects.has(col.projectId)) {
        // Re-register since the project is active
        this.register(col.name);
        continue;
      }

      // This collection has no matching active project → orphan
      orphans.push(col.name);
    }

    // Delete orphaned collections
    for (const colName of orphans) {
      try {
        await this.client.collections(colName).delete();
        this.registered.delete(colName);
        logger.info({ collection: colName }, 'CollectionManager: deleted orphan collection');
      } catch (err) {
        logger.warn({ err, collection: colName }, 'CollectionManager: failed to delete orphan collection');
      }
    }

    return orphans;
  }

  /**
   * Get collection statistics for monitoring.
   */
  async getStats(): Promise<{
    totalCollections: number;
    registeredCollections: number;
    orphanCollections: number;
  }> {
    const collections = await this.listProjectCollections();
    const totalCollections = collections.length;
    const registeredCollections = this.registered.size;

    // Approximate orphans: collections not in registration map
    const registeredNames = new Set(this.registered.keys());
    const orphanCollections = collections.filter(c => !registeredNames.has(c.name)).length;

    return { totalCollections, registeredCollections, orphanCollections };
  }

  /**
   * Close the manager (stop scanning, clear state).
   */
  async close(): Promise<void> {
    this.stopScanning();
    this.registered.clear();
  }
}
