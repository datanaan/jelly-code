import { describe, it, expect } from 'vitest';
import type { Relation } from '../../src/store/interfaces.js';

describe('Relation interface', () => {
  it('should accept extra properties via index signature', () => {
    const r: Relation = {
      id: 'test-rel-1',
      type: 'CHANGED_IN',
      projectId: 'proj-1',
      sourceId: 'node-a',
      targetId: 'node-b',
      confidence: 1.0,
      additions: 10,
      deletions: 5,
      changeType: 'modified',
    };
    expect((r as Record<string, unknown>).additions).toBe(10);
    expect((r as Record<string, unknown>).changeType).toBe('modified');
  });

  it('should allow CO_CHANGED_WITH specific properties', () => {
    const r: Relation = {
      id: 'test-rel-2',
      type: 'CO_CHANGED_WITH',
      projectId: 'proj-1',
      sourceId: 'node-a',
      targetId: 'node-b',
      confidence: 0.85,
      coChangeCount: 12,
      support: 0.15,
      lift: 2.3,
    };
    expect((r as Record<string, unknown>).coChangeCount).toBe(12);
    expect((r as Record<string, unknown>).lift).toBe(2.3);
  });
});
