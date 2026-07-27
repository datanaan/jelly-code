/**
 * Storage abstraction interfaces for jelly_code_project.
 * 
 * All business logic depends on these interfaces, not on specific
 * database implementations. This allows swapping backends
 * (LadybugDB → Neo4j+Typesense+Qdrant) without changing business code.
 */

// === Core Types ===

export interface CodeNode {
  id: string;
  type: string;  // File, Function, Class, Interface, Method, etc.
  projectId: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  isExported?: boolean;
  content?: string;
  description?: string;
  parameterCount?: number;
  returnType?: string;
  keywords?: string[];
  heuristicLabel?: string;
  label?: string;
  processType?: string;
  stepCount?: number;
  communities?: string[];
  entryPointId?: string;
  terminalId?: string;
  enrichedBy?: string;
  cohesion?: number;
  symbolCount?: number;
  level?: number;
  responseKeys?: string[];
  errorKeys?: string[];
  middleware?: string[];
  [key: string]: unknown;
}

export interface Relation {
  id: string;
  type: string;  // CALLS, IMPORTS, EXTENDS, IMPLEMENTS, CONTAINS, DEFINES, etc.
  projectId: string;
  sourceId: string;
  targetId: string;
  confidence: number;
  reason?: string;
  step?: number;
  [key: string]: unknown;
}

export interface SearchResult {
  nodeId: string;
  nodeType: string;
  filePath: string;
  name: string;
  score: number;
}

export interface VectorResult {
  nodeId: string;
  score: number;
  payload?: Record<string, unknown>;
}

export interface BFSResult {
  visited: CodeNode[];
  edges: Relation[];
  depths: Map<string, number>;
}

export interface ProcessInfo {
  id: string;
  label: string;
  processType: string;
  stepCount: number;
  communities: string[];
  entryPointId?: string;
}

export interface CommunityInfo {
  id: string;
  label: string;
  heuristicLabel: string;
  keywords: string[];
  description: string;
  cohesion: number;
  symbolCount: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  repoUrl: string;
  createdAt: string;
  status: string;
}

// === IGraphStore — Graph Traversal ===

export interface IGraphStore {
  /** Initialize schema (constraints, indexes) */
  initializeSchema(): Promise<void>;

  /** Find symbols by name, optionally filtered by type */
  findSymbol(projectId: string, name: string, types?: string[]): Promise<CodeNode[]>;

  /** Find all symbols in a file */
  findSymbolByFile(projectId: string, filePath: string): Promise<CodeNode[]>;

  /** Get a single node by ID */
  getNode(projectId: string, nodeId: string): Promise<CodeNode | null>;

  /** Get relations pointing TO a node (who depends on me) */
  getInboundRelations(projectId: string, nodeId: string, types?: string[]): Promise<Relation[]>;

  /** Get relations pointing FROM a node (who do I depend on) */
  getOutboundRelations(projectId: string, nodeId: string, types?: string[]): Promise<Relation[]>;

  /** BFS traversal from seed nodes (blast radius analysis) */
  bfsTraverse(projectId: string, seedIds: string[], relTypes: string[], maxDepth: number): Promise<BFSResult>;

  /** Find execution processes a node participates in */
  findProcessesByNode(projectId: string, nodeId: string): Promise<ProcessInfo[]>;

  /** Find the entry point of a process */
  findEntryPoint(projectId: string, processId: string): Promise<CodeNode | null>;

  /** Find the community a node belongs to */
  findCommunityByNode(projectId: string, nodeId: string): Promise<CommunityInfo | null>;

  /** Batch create nodes (for indexing) */
  batchCreateNodes(nodes: CodeNode[]): Promise<void>;

  /** Batch create relations (for indexing) */
  batchCreateRelations(relations: Relation[]): Promise<void>;

  /** Find all node IDs for a given file path */
  findNodeIdsByFilePath(projectId: string, filePath: string): Promise<string[]>;

  /** Batch find node IDs for multiple file paths. Returns Map<filePath, nodeId[]> */
  findNodeIdsByFilePaths(projectId: string, filePaths: string[]): Promise<Map<string, string[]>>;

  /** Delete all nodes for a given file path (DETACH DELETE to remove relations too) */
  deleteNodesByFilePath(projectId: string, filePath: string): Promise<string[]>;

  /** Delete nodes by their IDs (DETACH DELETE) */
  deleteNodesByIds(projectId: string, nodeIds: string[]): Promise<number>;

  /** Execute raw Cypher query */
  query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;

  /** Execute a safe, pre-defined query by template name. Prevents Cypher injection. */
  safeQuery?(templateName: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;

  /** Clear all data for a project */
  clearProject(projectId: string): Promise<void>;

  /** List all project IDs */
  listProjects(): Promise<string[]>;

  /** Close connections */
  close(): Promise<void>;
}

// === ISearchStore — Full-text Search ===

export interface SearchOptions {
  limit?: number;
  filterByTypes?: string[];
}

export interface SearchDocument {
  id: string;
  name: string;
  content: string;
  filePath: string;
  nodeType: string;
}

export interface ISearchStore {
  /** Search for documents */
  search(projectId: string, query: string, options?: SearchOptions): Promise<SearchResult[]>;

  /** Index documents (create or update) */
  indexDocuments(projectId: string, docs: SearchDocument[]): Promise<void>;

  /** Delete a project's collection */
  deleteCollection(projectId: string): Promise<void>;

  /** Ensure a project's collection exists */
  ensureCollection(projectId: string): Promise<void>;

  /** Delete all documents for a given file path */
  deleteDocumentsByFilePath(projectId: string, filePath: string): Promise<number>;

  /** Health check — returns true if the backend is reachable */
  healthCheck?(): Promise<boolean>;

  /** Close connections */
  close(): Promise<void>;
}

// === IVectorStore — Vector Search ===

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface IVectorStore {
  /** Search for similar vectors */
  search(projectId: string, vector: number[], k: number): Promise<VectorResult[]>;

  /** Upsert vectors (create or update) */
  upsertVectors(projectId: string, points: VectorPoint[]): Promise<void>;

  /** Delete a project's collection */
  deleteCollection(projectId: string): Promise<void>;

  /** Ensure a project's collection exists */
  ensureCollection(projectId: string, vectorSize: number): Promise<void>;

  /** Delete vectors by node IDs */
  deleteVectorsByNodeIds(projectId: string, nodeIds: string[]): Promise<number>;

  /** Health check — returns true if the backend is reachable */
  healthCheck?(): Promise<boolean>;

  /** Close connections */
  close(): Promise<void>;
}

// === IAuthProvider — Authentication ===

export interface AuthResult {
  valid: boolean;
  identity: string;  // API key hash or user ID
  error?: string;
}

export interface QuotaInfo {
  remaining: number;
  total: number;
}

export interface IAuthProvider {
  /** Verify an API key */
  verify(apiKey: string): Promise<AuthResult>;

  /** Check remaining quota */
  checkQuota(identity: string): Promise<QuotaInfo>;

  /** Consume quota (deduct after successful call) */
  consumeQuota(identity: string, amount: number): Promise<void>;
}

// === LLM Client ===

export type { ILLMClient, LLMConfig, LLMOptions } from '../llm/interface.js';

// === Store Factory ===

export interface StoreSet {
  graph: IGraphStore;
  search: ISearchStore;
  vector: IVectorStore;
  llm: import('../llm/interface.js').ILLMClient;

  /** Close all store connections */
  close(): Promise<void>;
}
