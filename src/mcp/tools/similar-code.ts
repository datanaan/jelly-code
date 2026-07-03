/**
 * MCP Tool: similar_code
 *
 * Semantic code similarity search using vector embeddings.
 * Uses the embedding pipeline to find similar code symbols via Qdrant vector search.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StoreSet } from '../../store/interfaces.js';
import { EmbeddingPipeline } from '../../core/embeddings/embedding-pipeline.js';
import { generateEmbeddingText } from '../../core/embeddings/text-generator.js';

export function registerSimilarCode(server: McpServer, stores: StoreSet): void {
  server.registerTool(
    'similar_code',
    {
      description:
        'Find code symbols similar to a given symbol using semantic (vector) search. Requires the symbol to have been embedded during indexing.',
      inputSchema: {
        projectId: z.string().describe('Project ID to search in'),
        nodeId: z.string().describe('Node ID of the symbol to find similar code for'),
        k: z.number().optional().default(5).describe('Number of similar results to return'),
      },
    },
    async ({ projectId, nodeId, k }) => {
      try {
        // 1. Get the source node
        const node = await stores.graph.getNode(projectId, nodeId);
        if (!node) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Node not found', nodeId }),
              },
            ],
            isError: true,
          };
        }

        // 2. Generate embedding text from the node
        const embeddingText = generateEmbeddingText({
          id: nodeId,
          name: node.name,
          label: node.type,
          filePath: node.filePath || '',
          content: node.content || node.description || `${node.type}: ${node.name}`,
        });

        if (!embeddingText) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  info: 'Could not generate embedding text for this node type.',
                  nodeId,
                  nodeName: node.name,
                  nodeType: node.type,
                  hint: 'Similarity search works best with Function, Class, Method, and Interface nodes.',
                }),
              },
            ],
          };
        }

        // 3. Perform semantic search via embedding pipeline
        const pipeline = new EmbeddingPipeline(stores.vector);
        let results;
        try {
          results = await pipeline.semanticSearch(projectId, embeddingText, k + 1);
        } catch {
          // Embedding pipeline not available (Qdrant down, model not loaded, etc.)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  info: 'Semantic similarity search requires the embedding pipeline.',
                  nodeId,
                  nodeName: node.name,
                  nodeType: node.type,
                  hint: 'Ensure Qdrant is running and the project was indexed with embeddings enabled. Use search_code for keyword-based search.',
                }),
              },
            ],
          };
        }

        // 4. Filter out the query node itself and format results
        const similar = results
          .filter((r) => r.nodeId !== nodeId)
          .slice(0, k)
          .map((r) => ({
            nodeId: r.nodeId,
            name: (r.payload?.name as string) || r.nodeId,
            type: (r.payload?.type as string) || '',
            filePath: (r.payload?.filePath as string) || '',
            score: Math.round(r.score * 1000) / 1000,
          }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                sourceNode: {
                  id: nodeId,
                  name: node.name,
                  type: node.type,
                },
                similar,
                total: similar.length,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: String(error), nodeId }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
