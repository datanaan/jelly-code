/**
 * Unit Tests: generateId utility
 */

import { describe, it, expect } from 'vitest';
import { generateId } from '../../src/lib/utils.js';

describe('generateId', () => {
  it('should generate node IDs with colon separator', () => {
    const id = generateId('File', 'src/index.ts');
    expect(id).toBe('File:src/index.ts');
  });

  it('should generate node IDs with multiple key parts', () => {
    const id = generateId('Function', 'myFunc', 'src/index.ts');
    expect(id).toBe('Function:myFunc:src/index.ts');
  });

  it('should generate relation IDs with arrow separator for CALLS', () => {
    const id = generateId('CALLS', 'source-id', 'target-id');
    expect(id).toBe('CALLS:source-id->target-id');
  });

  it('should generate relation IDs with arrow separator for IMPORTS', () => {
    const id = generateId('IMPORTS', 'source-id', 'target-id');
    expect(id).toBe('IMPORTS:source-id->target-id');
  });

  it('should generate relation IDs with arrow separator for EXTENDS', () => {
    const id = generateId('EXTENDS', 'source-id', 'target-id');
    expect(id).toBe('EXTENDS:source-id->target-id');
  });

  it('should handle CONTAINS as a relation type', () => {
    const id = generateId('CONTAINS', 'parent-id', 'child-id');
    expect(id).toBe('CONTAINS:parent-id->child-id');
  });

  it('should handle DEFINES as a relation type', () => {
    const id = generateId('DEFINES', 'source-id', 'target-id');
    expect(id).toBe('DEFINES:source-id->target-id');
  });
});
