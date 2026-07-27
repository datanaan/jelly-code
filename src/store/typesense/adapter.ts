import Typesense from 'typesense';
import type {
  ISearchStore,
  SearchResult,
  SearchDocument,
  SearchOptions,
} from '../interfaces.js';
import type { TypesenseConfig } from '../../config/index.js';

/**
 * Typesense implementation of ISearchStore.
 *
 * Replaces LadybugDB's FTS extension (QUERY_FTS_INDEX).
 * Each project gets its own collection: {projectId}_code
 */
export class TypesenseAdapter implements ISearchStore {
  private client: Typesense.Client;

  constructor(config: TypesenseConfig) {
    this.client = new Typesense.Client({
      nodes: [{
        host: config.host,
        port: config.port,
        protocol: config.protocol || 'http',
      }],
      apiKey: config.apiKey,
      connectionTimeoutSeconds: 10,
    });
  }

  async search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const collectionName = `${projectId}_code`;

    try {
      const searchParams: Record<string, unknown> = {
        q: query,
        query_by: 'name,content',
        per_page: options?.limit || 20,
      };

      // Add type filter if specified
      if (options?.filterByTypes?.length) {
        searchParams.filter_by = `nodeType:[${options.filterByTypes.join(',')}]`;
      }

      const results = await this.client.collections(collectionName).documents().search(searchParams as any);

      return (results.hits || []).map(hit => ({
        nodeId: (hit.document as Record<string, unknown>).id as string,
        nodeType: (hit.document as Record<string, unknown>).nodeType as string,
        filePath: (hit.document as Record<string, unknown>).filePath as string,
        name: (hit.document as Record<string, unknown>).name as string,
        score: ((hit as unknown) as Record<string, unknown>).text_match_score as number || 0,
      }));
    } catch (error: unknown) {
      // Collection doesn't exist yet
      if (error instanceof Error && error.message?.includes('Not found')) {
        return [];
      }
      throw error;
    }
  }

  async indexDocuments(projectId: string, docs: SearchDocument[]): Promise<void> {
    if (docs.length === 0) return;
    const collectionName = `${projectId}_code`;

    // Ensure collection exists
    await this.ensureCollection(projectId);

    // Upsert in batches of 100
    const batchSize = 100;
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      await this.client.collections(collectionName).documents().import(batch, {
        action: 'upsert',
      });
    }
  }

  async deleteCollection(projectId: string): Promise<void> {
    const collectionName = `${projectId}_code`;
    try {
      await this.client.collections(collectionName).delete();
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes('Not found')) {
        return; // Already deleted
      }
      throw error;
    }
  }

  async ensureCollection(projectId: string): Promise<void> {
    const collectionName = `${projectId}_code`;
    try {
      await this.client.collections(collectionName).retrieve();
    } catch {
      // Collection doesn't exist, create it
      await this.client.collections().create({
        name: collectionName,
        fields: [
          { name: 'id', type: 'string' },
          { name: 'name', type: 'string', sort: true },
          { name: 'content', type: 'string' },
          { name: 'filePath', type: 'string', sort: true },
          { name: 'nodeType', type: 'string', facet: true },
        ],
        default_sorting_field: 'name',
      });
    }
  }

  async deleteDocumentsByFilePath(projectId: string, filePath: string): Promise<number> {
    const collectionName = `${projectId}_code`;
    try {
      const result = await this.client.collections(collectionName)
        .documents()
        .delete({ filter_by: `filePath:${filePath}` });
      return (result as unknown as Record<string, unknown>).num_deleted as number ?? 0;
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes('Not found')) {
        return 0;
      }
      throw error;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.collections().retrieve();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Typesense client doesn't need explicit close
  }
}
