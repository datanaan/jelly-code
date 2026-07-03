import type { ISearchStore, SearchResult } from '../../store/interfaces.js';

/**
 * BM25 full-text search using Typesense.
 * Replaces LadybugDB's CALL QUERY_FTS_INDEX.
 */
export class BM25Search {
  constructor(private searchStore: ISearchStore) {}

  /**
   * Search for code symbols using full-text search.
   * 
   * Original LadybugDB implementation made 5 separate FTS calls
   * (one per table: File, Function, Class, Method, Interface).
   * Typesense handles this in a single multi-field search.
   */
  async search(projectId: string, query: string, limit?: number): Promise<SearchResult[]> {
    return this.searchStore.search(projectId, query, {
      limit,
      filterByTypes: ['Function', 'Class', 'Method', 'Interface', 'File'],
    });
  }
}
