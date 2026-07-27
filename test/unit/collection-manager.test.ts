/**
 * Tests for Typesense Collection Manager (P2-T7)
 */

import { describe, it, expect, vi } from 'vitest';
import { CollectionManager } from '../../src/store/typesense/collection-manager.js';

function createMockClient() {
  return {
    collections: vi.fn().mockReturnThis(),
    retrieve: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  } as unknown as any;
}

describe('CollectionManager', () => {
  it('registers and unregisters collections', () => {
    const client = createMockClient();
    const mgr = new CollectionManager(client as any);

    expect(mgr.isRegistered('proj1_code')).toBe(false);
    mgr.register('proj1_code');
    expect(mgr.isRegistered('proj1_code')).toBe(true);
    mgr.unregister('proj1_code');
    expect(mgr.isRegistered('proj1_code')).toBe(false);
  });

  it('listProjectCollections filters to *_code pattern', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockResolvedValue([
      { name: 'proj1_code', num_documents: 100 },
      { name: 'proj2_code', num_documents: 50 },
      { name: 'system_meta', num_documents: 10 },
    ] as any);

    const mgr = new CollectionManager(client as any);
    const collections = await mgr.listProjectCollections();

    expect(collections).toHaveLength(2);
    expect(collections[0].name).toBe('proj1_code');
    expect(collections[0].projectId).toBe('proj1');
    expect(collections[1].name).toBe('proj2_code');
    expect(collections[1].projectId).toBe('proj2');
  });

  it('scanAndCleanup deletes orphaned collections', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockResolvedValue([
      { name: 'orphan1_code', num_documents: 10 },
      { name: 'active_code', num_documents: 50 },
    ] as any);

    const mgr = new CollectionManager(client as any);
    mgr.register('active_code');

    const activeProjects = async () => new Set<string>(['active']);
    const orphans = await mgr.scanAndCleanup(activeProjects);

    expect(orphans).toContain('orphan1_code');
    expect(orphans).not.toContain('active_code');
    expect(client.collections('orphan1_code').delete).toHaveBeenCalled();
  });

  it('scanAndCleanup re-registers collections with active projects', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockResolvedValue([
      { name: 'proj1_code', num_documents: 100 },
    ] as any);

    const mgr = new CollectionManager(client as any);

    const activeProjects = async () => new Set<string>(['proj1']);
    const orphans = await mgr.scanAndCleanup(activeProjects);

    expect(orphans).toHaveLength(0);
    expect(mgr.isRegistered('proj1_code')).toBe(true);
  });

  it('getStats returns collection statistics', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockResolvedValue([
      { name: 'proj1_code', num_documents: 100 },
      { name: 'proj2_code', num_documents: 50 },
      { name: 'proj3_code', num_documents: 30 },
    ] as any);

    const mgr = new CollectionManager(client as any);
    mgr.register('proj1_code');
    mgr.register('proj2_code');

    const stats = await mgr.getStats();
    expect(stats.totalCollections).toBe(3);
    expect(stats.registeredCollections).toBe(2);
    expect(stats.orphanCollections).toBe(1);
  });

  it('close stops scanning and clears state', async () => {
    const client = createMockClient();
    const mgr = new CollectionManager(client as any);
    mgr.register('test_code');
    await mgr.close();

    expect(mgr.isRegistered('test_code')).toBe(false);
  });

  it('does not delete when autoCleanup is disabled', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockResolvedValue([
      { name: 'orphan_code', num_documents: 10 },
    ] as any);

    const mgr = new CollectionManager(client as any, { autoCleanup: false });
    const activeProjects = async () => new Set<string>();
    const orphans = await mgr.scanAndCleanup(activeProjects);

    expect(orphans).toHaveLength(0);
    expect(client.collections().delete).not.toHaveBeenCalled();
  });

  it('handles list failure gracefully', async () => {
    const client = createMockClient();
    client.collections().retrieve.mockRejectedValue(new Error('Connection refused'));

    const mgr = new CollectionManager(client as any);
    const collections = await mgr.listProjectCollections();

    expect(collections).toEqual([]);
  });
});
