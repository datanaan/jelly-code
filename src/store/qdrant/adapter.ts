import { createHash } from 'crypto';

import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  IVectorStore,
  VectorResult,
  VectorPoint,
} from '../interfaces.js';
import type { QdrantConfig } from '../../config/index.js';

/**
 * Qdrant implementation of IVectorStore.
 *
 * Replaces LadybugDB's vector extension (QUERY_VECTOR_INDEX).
 * Each project gets its own collection: {projectId}_embeddings
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

export class QdrantAdapter implements IVectorStore {
  private client: QdrantClient;

  constructor(config: QdrantConfig) {
    this.client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      checkCompatibility: false,
    });
  }

  async search(projectId: string, vector: number[], k: number): Promise<VectorResult[]> {
    const collectionName = `${projectId}_embeddings`;

    try {
      const results = await this.client.search(collectionName, {
        vector,
        limit: k,
        with_payload: true,
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
    const collectionName = `${projectId}_embeddings`;

    // Ensure collection exists (with default vector size if not yet created)
    // The vector size will be set on first ensureCollection call
    await this.ensureCollection(projectId, points[0].vector.length);

    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.client.upsert(collectionName, {
        wait: true,
        points: batch.map(p => {
          // Qdrant requires UUID or unsigned int IDs.
          // Convert string IDs to deterministic UUIDs, store original in payload.
          const qdrantId = (typeof p.id === 'string' && !isUuid(p.id))
            ? stringToUuid(p.id)
            : p.id;
          return {
            id: qdrantId,
            vector: p.vector,
            payload: {
              nodeId: String(p.id),  // always store original ID
              ...p.payload,
            },
          };
        }),
      });
    }
  }

  async deleteCollection(projectId: string): Promise<void> {
    const collectionName = `${projectId}_embeddings`;
    try {
      await this.client.deleteCollection(collectionName);
    } catch {
      // Already deleted or doesn't exist
    }
  }

  async ensureCollection(projectId: string, vectorSize: number = 384): Promise<void> {
    const collectionName = `${projectId}_embeddings`;
    try {
      await this.client.getCollection(collectionName);
    } catch {
      // Collection doesn't exist, create it
      await this.client.createCollection(collectionName, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine' as const,
        },
      });
    }
  }

  async deleteVectorsByNodeIds(projectId: string, nodeIds: string[]): Promise<number> {
    if (nodeIds.length === 0) return 0;
    const collectionName = `${projectId}_embeddings`;

    try {
      const qdrantIds = nodeIds.map(id => isUuid(id) ? id : stringToUuid(id));
      await this.client.delete(collectionName, { wait: true, points: qdrantIds });
      return qdrantIds.length;
    } catch (error: unknown) {
      // Collection doesn't exist — nothing to delete
      if (error instanceof Error && (error.message?.includes('Not Found') || error.message?.includes("doesn't exist") || (error as any).status === 404)) {
        return 0;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    // Qdrant client doesn't need explicit close
  }
}
