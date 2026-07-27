/**
 * Cluster Enricher
 *
 * LLM-based enrichment for community clusters.
 * Generates semantic names, keywords, and descriptions using an LLM.
 */

import { CommunityNode } from './community-processor.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ClusterEnrichment {
  name: string;
  keywords: string[];
  description: string;
}

export interface EnrichmentResult {
  enrichments: Map<string, ClusterEnrichment>;
  tokensUsed: number;
}

export interface LLMClient {
  generate: (prompt: string) => Promise<string>;
}

export interface ClusterMemberInfo {
  name: string;
  filePath: string;
  type: string; // 'Function' | 'Class' | 'Method' | 'Interface'
}

// ============================================================================
// PROMPT TEMPLATE
// ============================================================================

const buildEnrichmentPrompt = (members: ClusterMemberInfo[], heuristicLabel: string): string => {
  // Limit to first 20 members to control token usage
  const limitedMembers = members.slice(0, 20);

  const memberList = limitedMembers.map((m) => `${m.name} (${m.type})`).join(', ');

  return `Analyze this code cluster and provide a semantic name and short description.

Heuristic: "${heuristicLabel}"
Members: ${memberList}${members.length > 20 ? ` (+${members.length - 20} more)` : ''}

Reply with JSON only:
{"name": "2-4 word semantic name", "description": "One sentence describing purpose"}`;
};

// ============================================================================
// PARSE LLM RESPONSE
// ============================================================================

const parseEnrichmentResponse = (response: string, fallbackLabel: string): ClusterEnrichment => {
  try {
    // Extract JSON from response (handles markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      name: parsed.name || fallbackLabel,
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      description: parsed.description || '',
    };
  } catch {
    // Fallback if parsing fails
    return {
      name: fallbackLabel,
      keywords: [],
      description: '',
    };
  }
};

// ============================================================================
// MAIN ENRICHMENT FUNCTION
// ============================================================================

/**
 * Enrich clusters with LLM-generated names, keywords, and descriptions.
 *
 * v1.4.0: This function now dispatches to the `llm-enrichment` BullMQ queue
 * instead of making synchronous LLM calls. The returned `EnrichmentResult`
 * contains only heuristic fallbacks for empty-member communities; the actual
 * semantic enrichments are produced asynchronously by `llm-worker` and written
 * directly to Neo4j. Callers that previously read the returned enrichments to
 * update community nodes should now treat the return value as best-effort
 * heuristic-only.
 *
 * @param communities - Community nodes to enrich
 * @param memberMap - Map of communityId -> member info
 * @param llmClient - LLM client (unused in async path, kept for backward compat)
 * @param onProgress - Progress callback
 * @param projectId - Optional project ID for job dispatch (default 'unknown')
 */
export const enrichClusters = async (
  communities: CommunityNode[],
  memberMap: Map<string, ClusterMemberInfo[]>,
  llmClient: LLMClient,
  onProgress?: (current: number, total: number) => void,
  projectId?: string,
): Promise<EnrichmentResult> => {
  // v1.4.0: async dispatch. Skip empty-member communities (heuristic fallback inline).
  void llmClient;  // Unused in async path; kept for backward-compatible signature.
  const enrichments = new Map<string, ClusterEnrichment>();
  const eligible: CommunityNode[] = [];

  for (const c of communities) {
    const members = memberMap.get(c.id) || [];
    if (members.length === 0) {
      enrichments.set(c.id, { name: c.heuristicLabel, keywords: [], description: '' });
    } else {
      eligible.push(c);
    }
  }

  if (eligible.length > 0) {
    const { JobDispatcher } = await import('../resilience/job-dispatcher.js');
    const { llmEnrichmentQueue } = await import('../queue-setup.js');
    const dispatcher = new JobDispatcher();
    const effectiveProjectId = projectId ?? 'unknown';
    await dispatcher.dispatch(
      llmEnrichmentQueue,
      eligible,
      (batch) => ({ projectId: effectiveProjectId, communityIds: batch.map(c => c.id) }),
      { batchSize: 5, jobIdPrefix: `enrich-${effectiveProjectId}` },
    );
  }

  // Note: actual enrichment happens in llm-worker async.
  // The returned EnrichmentResult only contains heuristic fallbacks;
  // semantic enrichments are written to Neo4j directly by the worker.
  onProgress?.(communities.length, communities.length);
  return { enrichments, tokensUsed: 0 };
};

// ============================================================================
// BATCH ENRICHMENT (more efficient)
// ============================================================================

/**
 * Enrich multiple clusters in a single LLM call (batch mode)
 * More efficient for token usage but requires larger context window
 */
export const enrichClustersBatch = async (
  communities: CommunityNode[],
  memberMap: Map<string, ClusterMemberInfo[]>,
  llmClient: LLMClient,
  batchSize: number = 5,
  onProgress?: (current: number, total: number) => void,
): Promise<EnrichmentResult> => {
  const enrichments = new Map<string, ClusterEnrichment>();
  let tokensUsed = 0;

  // Process in batches
  for (let i = 0; i < communities.length; i += batchSize) {
    // Report progress
    onProgress?.(Math.min(i + batchSize, communities.length), communities.length);

    const batch = communities.slice(i, i + batchSize);

    const batchPrompt = batch
      .map((community, idx) => {
        const members = memberMap.get(community.id) || [];
        const limitedMembers = members.slice(0, 15);
        const memberList = limitedMembers.map((m) => `${m.name} (${m.type})`).join(', ');

        return `Cluster ${idx + 1} (id: ${community.id}):
Heuristic: "${community.heuristicLabel}"
Members: ${memberList}`;
      })
      .join('\n\n');

    const prompt = `Analyze these code clusters and generate semantic names, keywords, and descriptions.

${batchPrompt}

Output JSON array:
[
  {"id": "comm_X", "name": "...", "keywords": [...], "description": "..."},
  ...
]`;

    try {
      const response = await llmClient.generate(prompt);
      tokensUsed += prompt.length / 4 + response.length / 4;

      // Parse batch response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{
          id: string;
          name: string;
          keywords: string[];
          description: string;
        }>;

        for (const item of parsed) {
          enrichments.set(item.id, {
            name: item.name,
            keywords: item.keywords || [],
            description: item.description || '',
          });
        }
      }
    } catch (error) {
      console.warn('Batch enrichment failed, falling back to heuristics:', error);
      // Fallback for this batch
      for (const community of batch) {
        enrichments.set(community.id, {
          name: community.heuristicLabel,
          keywords: [],
          description: '',
        });
      }
    }
  }

  // Fill in any missing communities
  for (const community of communities) {
    if (!enrichments.has(community.id)) {
      enrichments.set(community.id, {
        name: community.heuristicLabel,
        keywords: [],
        description: '',
      });
    }
  }

  return { enrichments, tokensUsed };
};
