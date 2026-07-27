/**
 * Tests for Qdrant Multi-tenant Adapter (P2-T3)
 *
 * These are unit tests that mock the Qdrant client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantAdapter } from '../../src/store/qdrant/adapter.js';

function createMockClient() {
  return {
    search: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    scroll: vi.fn(),
    getCollection: vi.fn(),
    createCollection: vi.fn(),
    getCollections: vi.fn(),
  };
}

describe('QdrantAdapter (single-collection multi-tenant)', () => {
  let adapter: QdrantAdapter;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    // Mock ensureSharedCollection to succeed
    mockClient.getCollection.mockResolvedValue({} as any);
    adapter = new QdrantAdapter({ url: 'http://localhost:6333' });
    // Replace the internal client with our mock
    (adapter as any).client = mockClient;
    (adapter as any).cachedVectorSize = 384;
  });

  it('search filters by projectId', async () => {
    mockClient.search.mockResolvedValue([
      { id: 'uuid-1', score: 0.95, payload: { nodeId: 'node1', projectId: 'proj1' } },
    ] as any);

    const results = await adapter.search('proj1', [0.1, 0.2, 0.3], 10);

    expect(mockClient.search).toHaveBeenCalledWith(
      'jelly_code_all_embeddings',
      expect.objectContaining({
        filter: {
          must: [
            { key: 'projectId', match: { value: 'proj1' } },
          ],
        },
      }),
    );
    expect(results).toHaveLength(1);
  });

  it('upsertVectors adds projectId to payload', async () => {
    mockClient.upsert.mockResolvedValue({} as any);

    await adapter.upsertVectors('proj1', [
      { id: 'node1', vector: [0.1, 0.2, 0.3], payload: { content: 'test' } },
    ]);

    expect(mockClient.upsert).toHaveBeenCalledWith(
      'jelly_code_all_embeddings',
      expect.objectContaining({
        points: expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              projectId: 'proj1',
              nodeId: 'node1',
              content: 'test',
            }),
          }),
        ]),
      }),
    );
  });

  it('deleteCollection scrolls and deletes by projectId', async () => {
    mockClient.scroll
      .mockResolvedValueOnce({
        points: [{ id: 'uuid-1' }, { id: 'uuid-2' }],
        next_page_offset: undefined,
      } as any);

    await adapter.deleteCollection('proj1');

    expect(mockClient.scroll).toHaveBeenCalledWith(
      'jelly_code_all_embeddings',
      expect.objectContaining({
        filter: {
          must: [
            { key: 'projectId', match: { value: 'proj1' } },
          ],
        },
      }),
    );
    expect(mockClient.delete).toHaveBeenCalledWith(
      'jelly_code_all_embeddings',
      expect.objectContaining({
        points: ['uuid-1', 'uuid-2'],
      }),
    );
  });

  it('deleteVectorsByNodeIds filters by projectId', async () => {
    mockClient.delete.mockResolvedValue({ status: 'ok' } as any);

    const count = await adapter.deleteVectorsByNodeIds('proj1', ['node1', 'node2']);

    expect(count).toBe(2);
    expect(mockClient.delete).toHaveBeenCalledWith(
      'jelly_code_all_embeddings',
      expect.objectContaining({
        filter: {
          must: [
            { key: 'projectId', match: { value: 'proj1' } },
          ],
        },
      }),
    );
  });

  it('search returns empty for non-existent collection', async () => {
    mockClient.search.mockRejectedValue(new Error('Not Found'));

    const results = await adapter.search('proj1', [0.1, 0.2], 5);
    expect(results).toEqual([]);
  });

  it('ensureCollection delegates to ensureSharedCollection', async () => {
    (adapter as any).cachedVectorSize = -1; // Reset cache

    await adapter.ensureCollection('proj1', 768);

    expect(mockClient.getCollection).toHaveBeenCalledWith('jelly_code_all_embeddings');
  });
});
