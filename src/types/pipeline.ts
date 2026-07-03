/**
 * Pipeline result types.
 *
 * This is the canonical definition of what the ingestion pipeline returns.
 * Moved from run-analyze.ts inline definition to a shared module.
 */

export interface PipelineResult {
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    isExported?: boolean;
    content?: string;
    description?: string;
    parameterCount?: number;
    returnType?: string;
    [key: string]: unknown;
  }>;
  relations: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    confidence: number;
    reason?: string;
    step?: number;
    [key: string]: unknown;
  }>;
  communities: Array<{
    id: string;
    label: string;
    heuristicLabel: string;
    keywords: string[];
    description: string;
    cohesion: number;
    symbolCount: number;
    [key: string]: unknown;
  }>;
  processes: Array<{
    id: string;
    label: string;
    processType: string;
    stepCount: number;
    communities: string[];
    entryPointId?: string;
    terminalId?: string;
    [key: string]: unknown;
  }>;
}
