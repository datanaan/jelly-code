/**
 * Type declarations for the ingestion pipeline module.
 *
 * The ingestion code is excluded from TypeScript compilation due to
 * strict mode incompatibilities from the jelly-code source. This declaration
 * file provides the types needed by the main project.
 *
 * IMPORTANT: Do not add any `import` statements here — they cause TypeScript
 * to follow the dependency chain into the excluded .ts files.
 * All types are declared inline to keep this file self-contained.
 *
 * At runtime, tsx handles the actual .ts files directly.
 */

export interface PipelineOptions {
  /** Maximum number of worker threads for parallel parsing */
  maxWorkers?: number;
  /** Languages to exclude from parsing */
  excludeLanguages?: string[];
  /** Whether to include test files */
  includeTests?: boolean;
  /** Custom file filter */
  fileFilter?: (filePath: string) => boolean;
}

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

/**
 * Run the full ingestion pipeline on a repository.
 *
 * @param repoPath - Absolute path to the repository
 * @param onProgress - Callback for progress updates
 * @param options - Optional pipeline configuration
 * @returns Pipeline result with nodes, relations, communities, processes
 */
export declare function runPipelineFromRepo(
  repoPath: string,
  onProgress: (progress: { phase: string; percent: number; message: string }) => void,
  options?: PipelineOptions,
): Promise<PipelineResult>;
