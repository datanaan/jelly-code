import { createHash } from 'crypto';

import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  IVectorStore,
  VectorResult,
  VectorPoint,
} from '../interfaces.js';
import type { QdrantConfig } from '../../config/index.js';
import { logger } from '../../core/logger.js';

/**
 * Qdrant implementation of IVectorStore.
 *
 * Replaces LadybugDB's vector extension (QUERY_VECTOR_INDEX).
 *
 * P2-T3: Single-collection multi-tenant architecture.
 *   All projects share a single collection: jelly_code_all_embeddings
 *   Multi-tenancy is achieved via payload field `projectId` used as filter.
 *
 * Benefits:
 *   - 100 projects → 1 collection instead of 100 (100x less management overhead)
 *   - Consistent vector dimensions across all projects
 *   - Easier backup/restore (one collection to backup)
 *
 * Qdrant requires point IDs to be unsigned integers or UUIDs.
 * String IDs (e.g. "admin-api") are converted to deterministic UUIDs
 * via MD5 hash, with the original ID stored in payload.nodeId.
 */

/**
 * Convert any string to a deterministic UUID v4 format using MD5.
 * Qdrant only accepts unsigned integers or UUID strings as point IDs.
 */
function stringToUuid(str: string): string {
  const hash = createHash('md5').update(str).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Check if a string is already a valid UUID.
 */
function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Single shared collection name for all projects (multi-tenant via payload filter).
 * P2-T3: All projects share one collection instead of one per project.
 */
const SHARED_COLLECTION = 'jelly_code_all_embeddings';

/** Default vector dimension size */
const DEFAULT_VECTOR_SIZE = 384;

export class QdrantAdapter implements IVectorStore {
  private client: QdrantClient;
  /** Cached vector size; -1 means not yet initialized */
  private cachedVectorSize: number = -1;

  constructor(config: QdrantConfig) {
    this.client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      checkCompatibility: false,
    });
  }

  /**
   * Ensure the shared collection exists.
   * Only creates if not already present (checked once per process via cachedVectorSize).
   */
  private async ensureSharedCollection(vectorSize: number = DEFAULT_VECTOR_SIZE): Promise<void> {
    if (this.cachedVectorSize > 0) return;

    try {
      await this.client.getCollection(SHARED_COLLECTION);
      this.cachedVectorSize = vectorSize;
    } catch {
      // Collection doesn't exist, create it with HNSW optimization
      // M4: Add hnsw_config for multi-tenant payload filtering and HNSW tuning
      await this.client.createCollection(SHARED_COLLECTION, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine' as const,
        },
        hnsw_config: {
          payload_m: 16,           // Index payload for efficient multi-tenant filtering
          m: 16,                    // Default HNSW M parameter
          ef_construct: 100,        // Default ef_construct for build quality
          full_scan_threshold: 10000, // Fall back to full scan for small collections
        },
        optimizers_config: {
          default_segment_number: 2, // Balance between memory and search speed
          memmap_threshold_kb: 20000, // Memory-map large segments
        },
      });

      // M4: Create payload index for multi-tenant filtering (projectId)
      // This is required for efficient filtered search across tenants
      try {
        await this.client.createPayloadIndex(SHARED_COLLECTION, {
          field_name: 'projectId',
          field_schema: 'keyword',
          wait: false,
        });
        logger.info('Qdrant: projectId payload index created');
      } catch (indexErr) {
        logger.warn({ err: indexErr }, 'Qdrant: failed to create payload index (non-fatal)');
      }
      this.cachedVectorSize = vectorSize;
    }
  }

  async search(projectId: string, vector: number[], k: number): Promise<VectorResult[]> {
    try {
      const results = await this.client.search(SHARED_COLLECTION, {
        vector,
        limit: k,
        with_payload: true,
        // Filter by projectId for multi-tenant isolation
        filter: {
          must: [
            { key: 'projectId', match: { value: projectId } },
          ],
        },
      });

      return results.map(r => ({
        nodeId: (r.payload?.nodeId as string) || r.id.toString(),
        score: r.score,
        payload: (r.payload as Record<string, unknown>) || {},
      }));
    } catch (error: unknown) {
      // Collection doesn't exist yet
      if (error instanceof Error && (error.message?.includes('Not Found') || error.message?.includes("doesn't exist") || (error as any).status === 404)) {
        return [];
      }
      throw error;
    }
  }

  async upsertVectors(projectId: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    // Ensure the shared collection exists
    await this.ensureSharedCollection(points[0].vector.length);

    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.client.upsert(SHARED_COLLECTION, {
        wait: true,
        points: batch.map(p => {
          const qdrantId = (typeof p.id === 'string' && !isUuid(p.id))
            ? stringToUuid(p.id)
            : p.id;
          return {
            id: qdrantId,
            vector: p.vector,
            payload: {
              nodeId: String(p.id),
              projectId,  // Store projectId for multi-tenant filtering
              ...p.payload,
            },
          };
        }),
      });
    }
  }

  async deleteCollection(projectId: string): Promise<void> {
    // Single-collection mode: delete only points matching this projectId
    try {
      // Scroll through all points for this project and delete them in batches
      let offset: string | number | undefined;
      do {
        const result = await this.client.scroll(SHARED_COLLECTION, {
          limit: 1000,
          offset,
          filter: {
            must: [
              { key: 'projectId', match: { value: projectId } },
            ],
          },
        });
        const ids = result.points.map(p => p.id);
        if (ids.length > 0) {
          await this.client.delete(SHARED_COLLECTION, {
            wait: true,
            points: ids,
          });
        }
        // P2-T3: Scroll results may have a next_page_offset for pagination.
        // Cast is safe since we only pass offset back to scroll (Qdrant handles it).
        const nextOffset = result.next_page_offset;
        offset = typeof nextOffset === 'string' || typeof nextOffset === 'number' ? nextOffset : undefined;
      } while (offset !== undefined);
    } catch {
      // Collection doesn't exist or already cleaned up
    }
  }

  async ensureCollection(_projectId: string, _vectorSize: number = DEFAULT_VECTOR_SIZE): Promise<void> {
    // P2-T3: Single shared collection — ensure it once
    await this.ensureSharedCollection(_vectorSize);
  }

  async deleteVectorsByNodeIds(projectId: string, nodeIds: string[]): Promise<number> {
    if (nodeIds.length === 0) return 0;

    try {
      const qdrantIds = nodeIds.map(id => isUuid(id) ? id : stringToUuid(id));
      // Delete with projectId filter for safety (multi-tenant isolation)
      await this.client.delete(SHARED_COLLECTION, {
        wait: true,
        points: qdrantIds,
        filter: {
          must: [
            { key: 'projectId', match: { value: projectId } },
          ],
        },
      });
      return qdrantIds.length;
    } catch (error: unknown) {
      if (error instanceof Error && (error.message?.includes('Not Found') || error.message?.includes("doesn't exist") || (error as any).status === 404)) {
        return 0;
      }
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Qdrant client doesn't need explicit close
  }
}
