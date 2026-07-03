/**
 * P0c-T2: WikiEntity + LintIssue model extension tests.
 *
 * Verifies that:
 * 1. WikiEntity accepts optional codeSignature (null and full object)
 * 2. Old entities without codeSignature still type-check (backward compat)
 * 3. WikiEntity accepts validFrom / validTo temporal fields
 * 4. LintIssue accepts type 'unbound' (new staleness type)
 * 5. Existing LintIssue types still work
 */
import { describe, it, expect } from 'vitest';
import type { WikiEntity, LintIssue } from '../../src/wiki/models.js';
import type { CodeSignature } from '../../src/wiki/code-signature.js';

describe('WikiEntity model — P0c-T2 extensions', () => {
  const baseEntity: WikiEntity = {
    id: 'e1',
    projectId: 'p1',
    name: 'test-function',
    entityType: 'concept',
    definition: 'A test function',
    details: 'Detailed description',
    firstCompiled: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
  };

  it('accepts codeSignature: null', () => {
    const entity: WikiEntity = { ...baseEntity, codeSignature: null };
    expect(entity.codeSignature).toBeNull();
  });

  it('accepts codeSignature with full CodeSignature object', () => {
    const sig: CodeSignature = {
      entityName: 'greet',
      entityType: 'function',
      paramTypes: ['string'],
      returnType: 'void',
      signatureHash: 'abc123',
      astHash: 'def456',
    };
    const entity: WikiEntity = { ...baseEntity, codeSignature: sig };
    expect(entity.codeSignature).toEqual(sig);
    expect(entity.codeSignature?.signatureHash).toBe('abc123');
  });

  it('loads old entity without codeSignature as undefined', () => {
    // Simulate data from before P0c — no codeSignature field at all
    const oldData = {
      id: 'e1',
      projectId: 'p1',
      name: 'old-entity',
      entityType: 'concept' as const,
      definition: 'old',
      details: 'old',
      firstCompiled: '2020-01-01',
      lastUpdated: '2020-01-01',
    };
    const entity = oldData as WikiEntity;
    expect(entity.codeSignature).toBeUndefined();
  });

  it('accepts validFrom ISO string', () => {
    const entity: WikiEntity = { ...baseEntity, validFrom: '2026-06-01T00:00:00Z' };
    expect(entity.validFrom).toBe('2026-06-01T00:00:00Z');
  });

  it('accepts validTo ISO string', () => {
    const entity: WikiEntity = { ...baseEntity, validTo: '2026-12-31T23:59:59Z' };
    expect(entity.validTo).toBe('2026-12-31T23:59:59Z');
  });

  it('accepts both validFrom and validTo for bitemporal tracking', () => {
    const entity: WikiEntity = {
      ...baseEntity,
      validFrom: '2026-06-01T00:00:00Z',
      validTo: '2026-12-31T23:59:59Z',
    };
    expect(entity.validFrom).toBeDefined();
    expect(entity.validTo).toBeDefined();
  });
});

describe('LintIssue model — P0c-T2 extensions', () => {
  it('accepts type "unbound" for entities without code signatures', () => {
    const issue: LintIssue = {
      type: 'unbound',
      entityId: 'e1',
      entityName: 'unbound-entity',
      description: 'Entity has no code signature binding',
      severity: 'warning',
    };
    expect(issue.type).toBe('unbound');
  });

  it('still accepts existing type "orphan"', () => {
    const issue: LintIssue = {
      type: 'orphan',
      entityId: 'e1',
      description: 'Orphaned entity',
      severity: 'warning',
    };
    expect(issue.type).toBe('orphan');
  });

  it('still accepts existing type "missing_ref"', () => {
    const issue: LintIssue = {
      type: 'missing_ref',
      entityId: 'e1',
      description: 'Missing reference',
      severity: 'error',
    };
    expect(issue.type).toBe('missing_ref');
  });

  it('still accepts existing type "stale"', () => {
    const issue: LintIssue = {
      type: 'stale',
      entityId: 'e1',
      description: 'Stale entity',
      severity: 'warning',
    };
    expect(issue.type).toBe('stale');
  });

  it('still accepts existing type "contradiction"', () => {
    const issue: LintIssue = {
      type: 'contradiction',
      entityId: 'e1',
      description: 'Contradiction found',
      severity: 'error',
    };
    expect(issue.type).toBe('contradiction');
  });
});
