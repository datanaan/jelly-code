/**
 * Embedding Pipeline Module
 *
 * Orchestrates embedding generation and semantic search using IVectorStore.
 * Replaces LadybugDB's QUERY_VECTOR_INDEX with Qdrant vector search.
 *
 * Embedder initialization is handled by the shared embedder module
 * (@huggingface/transformers local inference or HTTP endpoint).
 */

import type { IVectorStore, VectorResult, VectorPoint } from '../../store/interfaces.js';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
  isEmbedderReady,
  getEmbeddingDimensions,
} from './embedder.js';
import { generateBatchEmbeddingTexts } from './text-generator.js';
import type { EmbeddableNode } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';

const isDev = process.env.NODE_ENV === 'development';

export class EmbeddingPipeline {
  constructor(private vectorStore: IVectorStore) {}

  /**
   * Perform semantic search using vector similarity.
   * Replaces LadybugDB's CALL QUERY_VECTOR_INDEX with Qdrant search.
   */
  async semanticSearch(projectId: string, query: string, k: number): Promise<VectorResult[]> {
    if (!isEmbedderReady()) {
      await initEmbedder(undefined, DEFAULT_EMBEDDING_CONFIG);
    }

    // 1. Generate query vector using local model
    const queryEmbedding = await embedText(query);
    const queryVector = embeddingToArray(queryEmbedding);

    // 2. Search via vectorStore (Qdrant)
    return this.vectorStore.search(projectId, queryVector, k);
  }

  /**
   * Generate embeddings for code nodes and upsert them into the vector store.
   * Replaces LadybugDB's CodeEmbedding table + CREATE_VECTOR_INDEX.
   */
  async indexEmbeddings(
    projectId: string,
    nodes: Array<{
      id: string;
      name: string;
      content?: string;
      description?: string;
      type: string;
      filePath: string;
    }>,
  ): Promise<void> {
    if (nodes.length === 0) return;

    // Ensure the vector store collection exists with the correct dimensions
    // for the active embedding mode (local=384, http-pool/legacy=CODE_EMBEDDING_DIMS)
    const dims = getEmbeddingDimensions();
    await this.vectorStore.ensureCollection(projectId, dims);

    // Ensure embedder is ready
    if (!isEmbedderReady()) {
      await initEmbedder(undefined, DEFAULT_EMBEDDING_CONFIG);
    }

    const batchSize = DEFAULT_EMBEDDING_CONFIG.batchSize;
    const totalBatches = Math.ceil(nodes.length / batchSize);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, nodes.length);
      const batch = nodes.slice(start, end);

      // Generate embedding texts from node metadata
      const embeddableNodes: EmbeddableNode[] = batch.map((node) => ({
        id: node.id,
        name: node.name,
        label: node.type,
        filePath: node.filePath,
        content: node.content ?? node.description ?? '',
      }));

      const texts = generateBatchEmbeddingTexts(embeddableNodes, DEFAULT_EMBEDDING_CONFIG);

      // Generate vectors using local model
      const embeddings = await embedBatch(texts);

      // Build vector points for upsert
      const points: VectorPoint[] = batch.map((node, i) => ({
        id: node.id,
        vector: embeddingToArray(embeddings[i]),
        payload: {
          name: node.name,
          type: node.type,
          filePath: node.filePath,
        },
      }));

      // Upsert to vector store (Qdrant)
      await this.vectorStore.upsertVectors(projectId, points);

      if (isDev) {
        console.log(
          `Indexed batch ${batchIndex + 1}/${totalBatches} (${end}/${nodes.length} nodes)`,
        );
      }
    }

    if (isDev) {
      console.log(`Embedding pipeline complete: ${nodes.length} nodes indexed`);
    }
  }
}
