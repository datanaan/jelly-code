/**
 * Wiki hybrid search: Typesense (keyword) + Qdrant (vector) with RRF fusion.
 *
 * Uses a dedicated `wiki_pages` collection in both Typesense and Qdrant
 * (not per-project like the code analysis collections).
 *
 * RRF fusion follows the same algorithm as jelly_search_v3.
 */

import type { ISearchStore, IVectorStore, VectorPoint } from '../store/interfaces.js';
import type { WikiPageDoc } from './models.js';

const COLLECTION_NAME = 'wiki_pages';
const VECTOR_SIZE = 1024;
const RRF_K = 60; // RRF constant (same as jelly_search_v3)

export class WikiSearch {
  constructor(
    private search: ISearchStore,
    private vector: IVectorStore,
  ) {}

  /**
   * Initialize wiki_pages collections in Typesense and Qdrant.
   * Called during startup.
   */
  async initializeCollection(): Promise<void> {
    // Typesense: use a special projectId to create the wiki_pages collection
    // ISearchStore.ensureCollection creates {projectId}_code,
    // so we use raw Typesense client approach via the search store's internal method.
    // For simplicity, we create the collection via search.ensureCollection
    // with "wiki" as projectId → "wiki_code" collection.
    // Actually, WikiSearch needs direct access. Let's use the stores' raw capabilities.
    // The ISearchStore doesn't have a direct "create wiki_pages collection" method,
    // but we can use the existing ensureCollection with a convention.

    // We use "wiki" as a special projectId. The collection will be "wiki_code"
    // in Typesense and "wiki_embeddings" in Qdrant (following existing naming).
    // Alternatively, we could query the stores directly. For now, this convention works.
    await this.search.ensureCollection('wiki');
    await this.vector.ensureCollection('wiki', VECTOR_SIZE);
  }

  /**
   * Index a wiki page in both Typesense and Qdrant.
   *
   * NOTE (ISSUE-002): We store projectId in Qdrant payload so that
   * search results can be filtered by project at the application layer.
   * Typesense doesn't get projectId because the wiki collection is shared,
   * but the search service already filters by projectId when calling
   * getSource/getEntity, so cross-project hits are safely dropped.
   */
  async indexPage(page: WikiPageDoc, embedding: number[]): Promise<void> {
    // Typesense
    await this.search.indexDocuments('wiki', [{
      id: page.id,
      name: page.title,
      content: page.content,
      filePath: `wiki/${page.pageType}/${page.id}`,  // virtual path for SearchDocument
      nodeType: page.pageType,
    }]);

    // Qdrant
    const point: VectorPoint = {
      id: page.id,
      vector: embedding,
      payload: {
        nodeId: page.id,  // original ID for Qdrant search result mapping
        projectId: page.projectId,  // ⬅ ISSUE-002: project filter for cross-tenant safety
        pageType: page.pageType,
        title: page.title,
        entityType: page.entityType || null,
        compiledAt: page.compiledAt,
      },
    };
    await this.vector.upsertVectors('wiki', [point]);
  }

  /**
   * Delete a wiki page from both stores.
   *
   * v1.3.0 fix: Previously a placeholder that did nothing. Now actually
   * deletes from both backends:
   *   - Typesense: deleteDocumentsByFilePath with the virtual filePath
   *     used during indexing (`wiki/${pageType}/${pageId}`)
   *   - Qdrant: deleteVectorsByNodeIds with the page ID
   *
   * Called by wiki_auto_fix delete-orphaned and undo-auto-derived to
   * prevent stale search results pointing to deleted Neo4j entities.
   */
  async deletePage(pageId: string, pageType: string = 'entity'): Promise<void> {
    // Typesense: delete by the virtual filePath used during indexPage
    const virtualFilePath = `wiki/${pageType}/${pageId}`;
    try {
      await this.search.deleteDocumentsByFilePath('wiki', virtualFilePath);
    } catch {
      // Non-fatal — Typesense may not have this document
    }

    // Qdrant: delete by node ID
    try {
      await this.vector.deleteVectorsByNodeIds('wiki', [pageId]);
    } catch {
      // Non-fatal — Qdrant may not have this point
    }
  }

  /**
   * Hybrid search: Typesense keyword + Qdrant vector → RRF fusion.
   */
  async searchPages(query: string, queryEmbedding: number[], limit: number = 10): Promise<WikiPageDoc[]> {
    // Parallel keyword + vector search
    const [keywordResults, vectorResults] = await Promise.all([
      this.search.search('wiki', query, { limit: 50 }),
      this.vector.search('wiki', queryEmbedding, 50),
    ]);

    // Build pageType + projectId maps from vector search payloads
    const pageTypeMap = new Map<string, string>();
    const projectIdMap = new Map<string, string>();
    for (const r of vectorResults) {
      if (r.payload?.pageType) {
        pageTypeMap.set(r.nodeId, r.payload.pageType as string);
      }
      if (r.payload?.projectId) {
        projectIdMap.set(r.nodeId, r.payload.projectId as string);
      }
    }

    // RRF fusion
    const rrfScores = new Map<string, number>();

    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i].nodeId;
      rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + i + 1));
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i].nodeId;
      rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + i + 1));
    }

    // Sort by RRF score descending
    const sorted = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    // Convert back to WikiPageDoc with correct pageType + projectId from search payload
    return sorted.map(([id]) => ({
      id,
      projectId: projectIdMap.get(id) || '',  // ⬅ ISSUE-002: project filter at app layer
      pageType: (pageTypeMap.get(id) || 'entity') as WikiPageDoc['pageType'],
      title: '',
      content: '',
      compiledAt: 0,
    }));
  }

  /**
   * Get raw keyword search results (for cases where only Typesense is needed).
   */
  async keywordSearch(query: string, limit: number = 20): Promise<Array<{ id: string; score: number }>> {
    const results = await this.search.search('wiki', query, { limit });
    return results.map(r => ({ id: r.nodeId, score: r.score }));
  }

  /**
   * Get raw vector search results (for cases where only Qdrant is needed).
   */
  async vectorSearch(embedding: number[], limit: number = 20): Promise<Array<{ id: string; score: number }>> {
    const results = await this.vector.search('wiki', embedding, limit);
    return results.map(r => ({ id: r.nodeId, score: r.score }));
  }
}
