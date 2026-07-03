/**
 * Unit Tests: Code signature generator (P0c-T1)
 *
 * Tests generateSignature() for code entities (functions, classes, interfaces,
 * modules). The core invariant:
 *
 *   signatureHash = sha256 of structured signature (name + param types + return type)
 *   astHash       = sha256 of full AST serialization
 *
 * - Body-only changes: same signatureHash, DIFFERENT astHash
 * - Signature changes (name/params/return): different signatureHash
 * - Same source parsed twice: identical both hashes
 *
 * Anti-theater: Every test calls the real generateSignature with real code
 * strings. No mocks, no shortcuts. The body-change test verifies BOTH halves
 * (signatureHash MUST be equal, astHash MUST differ).
 */

import { describe, it, expect } from 'vitest';
import {
  generateSignature,
  type CodeSignature,
} from '../../src/wiki/code-signature.js';

describe('code-signature', () => {
  // ─── Determinism ───────────────────────────────────────────────

  describe('Determinism', () => {
    it('same function source parsed twice → identical signatureHash AND astHash', () => {
      const code = `function greet(name: string): string { return 'hello ' + name; }`;
      const sig1 = generateSignature(code);
      const sig2 = generateSignature(code);
      expect(sig1.signatureHash).toBe(sig2.signatureHash);
      expect(sig1.astHash).toBe(sig2.astHash);
    });

    it('hashes are stable hex strings (64 chars, sha256)', () => {
      const code = `function foo(): void {}`;
      const sig = generateSignature(code);
      expect(sig.signatureHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sig.astHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ─── Signature stability (body changes) ───────────────────────

  describe('Body-only changes', () => {
    it('change function body only → same signatureHash, DIFFERENT astHash', () => {
      const codeA = `function add(a: number, b: number): number { return a + b; }`;
      const codeB = `function add(a: number, b: number): number { return a - b; }`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);

      // signatureHash MUST be identical
      expect(sigA.signatureHash).toBe(sigB.signatureHash);

      // astHash MUST differ
      expect(sigA.astHash).not.toBe(sigB.astHash);
    });

    it('change only a comment → same signatureHash, DIFFERENT astHash', () => {
      const codeA = `function fn(): void { /* old */ }`;
      const codeB = `function fn(): void { /* new comment */ }`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).toBe(sigB.signatureHash);
      expect(sigA.astHash).not.toBe(sigB.astHash);
    });
  });

  // ─── Signature changes (name/params/return) ───────────────────

  describe('Signature changes', () => {
    it('change param type → different signatureHash', () => {
      const codeA = `function process(data: string): void {}`;
      const codeB = `function process(data: number): void {}`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).not.toBe(sigB.signatureHash);
    });

    it('change param NAME only (same type) → same signatureHash', () => {
      const codeA = `function process(data: string): void {}`;
      const codeB = `function process(input: string): void {}`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).toBe(sigB.signatureHash);
    });

    it('change return type → different signatureHash', () => {
      const codeA = `function getValue(): string { return 'x'; }`;
      const codeB = `function getValue(): number { return 42; }`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).not.toBe(sigB.signatureHash);
    });

    it('change function name → different signatureHash', () => {
      const codeA = `function hello(): void {}`;
      const codeB = `function goodbye(): void {}`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).not.toBe(sigB.signatureHash);
      expect(sigA.entityName).toBe('hello');
      expect(sigB.entityName).toBe('goodbye');
    });

    it('add a parameter → different signatureHash', () => {
      const codeA = `function fn(a: number): void {}`;
      const codeB = `function fn(a: number, b: string): void {}`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      expect(sigA.signatureHash).not.toBe(sigB.signatureHash);
    });
  });

  // ─── Entity types ─────────────────────────────────────────────

  describe('Entity types', () => {
    it('class signature: entityType=class', () => {
      const code = `class Foo { constructor(private x: number) {} bar(): string { return ''; } }`;
      const sig = generateSignature(code);
      expect(sig.entityType).toBe('class');
      expect(sig.entityName).toBe('Foo');
    });

    it('interface signature: entityType=interface', () => {
      const code = `interface IRepository { find(id: string): Promise<Entity>; save(e: Entity): Promise<void>; }`;
      const sig = generateSignature(code);
      expect(sig.entityType).toBe('interface');
      expect(sig.entityName).toBe('IRepository');
    });

    it('function signature: entityType=function', () => {
      const code = `function compute(x: number): number { return x * 2; }`;
      const sig = generateSignature(code);
      expect(sig.entityType).toBe('function');
      expect(sig.entityName).toBe('compute');
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────

  describe('Edge cases', () => {
    it('function with no params and no return type', () => {
      const code = `function noop() {}`;
      const sig = generateSignature(code);
      expect(sig.paramTypes).toEqual([]);
      // No explicit return type → 'unknown' or inferred
      expect(sig.returnType).toBeTruthy();
    });

    it('arrow function', () => {
      const code = `const arrow = (x: number): string => x.toString();`;
      const sig = generateSignature(code);
      expect(sig.entityName).toBe('arrow');
      expect(sig.paramTypes).toEqual(['number']);
      expect(sig.returnType).toBe('string');
    });

    it('async function return type includes Promise wrapper', () => {
      const code = `async function fetchData(url: string): Promise<Response> { return fetch(url); }`;
      const sig = generateSignature(code);
      expect(sig.returnType).toBe('Promise<Response>');
      expect(sig.paramTypes).toEqual(['string']);
    });

    it('generator function', () => {
      const code = `function* counter(): Generator<number> { yield 1; }`;
      const sig = generateSignature(code);
      expect(sig.entityType).toBe('function');
      expect(sig.returnType).toBe('Generator<number>');
    });

    it('multiple functions in source → entityName picks the first', () => {
      const code = `function alpha(): void {} function beta(): void {}`;
      const sig = generateSignature(code);
      expect(sig.entityName).toBe('alpha');
    });

    it('can target a specific function by name when multiple exist', () => {
      const code = `function alpha(): void {} function beta(x: number): string { return ''; }`;
      const sig = generateSignature(code, 'beta');
      expect(sig.entityName).toBe('beta');
      expect(sig.paramTypes).toEqual(['number']);
      expect(sig.returnType).toBe('string');
    });

    it('empty params array for zero-arg function', () => {
      const code = `function getTimestamp(): number { return Date.now(); }`;
      const sig = generateSignature(code);
      expect(sig.paramTypes).toEqual([]);
    });
  });

  // ─── Canonical form ───────────────────────────────────────────

  describe('Canonical form', () => {
    it('whitespace differences in source do not change signatureHash', () => {
      const codeA = `function   fn(  x : number ) : void { }`;
      const codeB = `function fn(x: number): void {}`;
      const sigA = generateSignature(codeA);
      const sigB = generateSignature(codeB);
      // Signature should be the same (canonical form normalizes whitespace)
      expect(sigA.signatureHash).toBe(sigB.signatureHash);
    });

    it('paramTypes extracted correctly for multi-param function', () => {
      const code = `function map(fn: (x: number) => string, list: number[]): string[] { return []; }`;
      const sig = generateSignature(code);
      // Function type param uses getText() to preserve full signature
      expect(sig.paramTypes).toEqual(['(x: number) => string', 'number[]']);
      expect(sig.returnType).toBe('string[]');
    });
  });
});
