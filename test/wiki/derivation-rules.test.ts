/**
 * v1.3.0 Phase 3 T3-1: Derivation rules config tests.
 *
 * Tests:
 * - loadRules: JSON parsing + normalization (priority sort)
 * - loadRulesWithFallback: user file → default → hardcoded fallback
 * - isDerivationEnabled: enabled/default/backward compat
 * - maxEntitiesPerProject limit
 * - llmFallbackDefinition template (no "See code signature for details")
 * - Invalid JSON → fallback (no crash)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadRules,
  loadRulesWithFallback,
  isDerivationEnabled,
  DEFAULT_DERIVATION_RULES,
} from '../../src/wiki/derivation-rules.js';

// ─── Helpers ─────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'derivation-rules-test-'));
}

async function writeFile(dir: string, relPath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, content);
  return fullPath;
}

// ─── Tests ───────────────────────────────────────────────────────

describe('derivation-rules (v1.3.0 T3-1)', () => {

  describe('loadRules', () => {
    it('parses valid JSON rules file', () => {
      const rules = loadRules(path.join(process.cwd(), 'config/derivation-rules.json'));
      expect(rules.rules).toHaveLength(3);
      expect(rules.maxEntitiesPerProject).toBe(200);
    });

    it('sorts rules by priority', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify({
        enabled: true,
        rules: [
          { name: 'low', filter: {}, priority: 3 },
          { name: 'high', filter: {}, priority: 1 },
          { name: 'mid', filter: {}, priority: 2 },
        ],
      }));
      const rules = loadRules(rulesPath);
      expect(rules.rules[0].name).toBe('high');
      expect(rules.rules[1].name).toBe('mid');
      expect(rules.rules[2].name).toBe('low');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('throws on invalid JSON', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const rulesPath = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(rulesPath, '{ not valid json');
      expect(() => loadRules(rulesPath)).toThrow();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('loadRulesWithFallback', () => {
    it('CK-3: uses user file when present', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const userRulesPath = path.join(tmpDir, '.jelly-code', 'derivation-rules.json');
      fs.mkdirSync(path.dirname(userRulesPath), { recursive: true });
      fs.writeFileSync(userRulesPath, JSON.stringify({
        enabled: true,
        rules: [
          { name: 'custom_rule', filter: { minInDegree: 3 }, priority: 1 },
        ],
        maxEntitiesPerProject: 50,
      }));

      const rules = loadRulesWithFallback(tmpDir);
      expect(rules.rules).toHaveLength(1);
      expect(rules.rules[0].name).toBe('custom_rule');
      expect(rules.maxEntitiesPerProject).toBe(50);
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('CK-3: falls back to default when user file missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      // No user file — should use built-in default
      const defaultPath = path.join(process.cwd(), 'config/derivation-rules.json');
      const rules = loadRulesWithFallback(tmpDir, defaultPath);
      expect(rules.rules).toHaveLength(3);
      expect(rules.rules[0].name).toBe('exported_api');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('falls back to hardcoded default when no files exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const rules = loadRulesWithFallback(tmpDir, '/nonexistent/path.json');
      // Should match DEFAULT_DERIVATION_RULES
      expect(rules.rules).toHaveLength(3);
      expect(rules.enabled).toBe(true);
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('CK-3: invalid user JSON falls back to default (not crash)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const userRulesPath = path.join(tmpDir, '.jelly-code', 'derivation-rules.json');
      fs.mkdirSync(path.dirname(userRulesPath), { recursive: true });
      fs.writeFileSync(userRulesPath, '{ bad json');

      const defaultPath = path.join(process.cwd(), 'config/derivation-rules.json');
      const rules = loadRulesWithFallback(tmpDir, defaultPath);
      // Should fall back to default, not crash
      expect(rules.rules).toHaveLength(3);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('isDerivationEnabled (T3-1b)', () => {
    it('CK-15: enabled=true → derivation active', () => {
      expect(isDerivationEnabled({ enabled: true, rules: [] })).toBe(true);
    });

    it('CK-14: enabled=false → derivation skipped', () => {
      expect(isDerivationEnabled({ enabled: false, rules: [] })).toBe(false);
    });

    it('CK-15: absent enabled field defaults to true (backward compat)', () => {
      expect(isDerivationEnabled({ rules: [] })).toBe(true);
    });

    it('CK-15: undefined enabled defaults to true', () => {
      expect(isDerivationEnabled({ enabled: undefined, rules: [] })).toBe(true);
    });
  });

  describe('llmFallbackDefinition (D8 fix)', () => {
    it('CK-8: default template does NOT contain "See code signature for details"', () => {
      const template = DEFAULT_DERIVATION_RULES.llmFallbackDefinition!;
      expect(template).not.toContain('See code signature for details');
    });

    it('template contains real placeholders for interpolation', () => {
      const template = DEFAULT_DERIVATION_RULES.llmFallbackDefinition!;
      expect(template).toContain('{type}');
      expect(template).toContain('{name}');
      expect(template).toContain('{filePath}');
      expect(template).toContain('{signature}');
    });

    it('template produces substantive content when interpolated', () => {
      const template = DEFAULT_DERIVATION_RULES.llmFallbackDefinition!;
      const interpolated = template
        .replace('{type}', 'Function')
        .replace('{name}', 'handleSubmit')
        .replace('{filePath}', 'src/auth.ts')
        .replace('{signature}', 'handleSubmit(event: Event): Promise<void>');
      expect(interpolated).toBe(
        'Exported Function handleSubmit in src/auth.ts. Signature: handleSubmit(event: Event): Promise<void>.',
      );
      expect(interpolated.length).toBeGreaterThan(20);
    });
  });

  describe('maxEntitiesPerProject', () => {
    it('default is 200', () => {
      expect(DEFAULT_DERIVATION_RULES.maxEntitiesPerProject).toBe(200);
    });

    it('user can override to lower value', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
      const userRulesPath = path.join(tmpDir, '.jelly-code', 'derivation-rules.json');
      fs.mkdirSync(path.dirname(userRulesPath), { recursive: true });
      fs.writeFileSync(userRulesPath, JSON.stringify({
        rules: [],
        maxEntitiesPerProject: 10,
      }));

      const rules = loadRulesWithFallback(tmpDir);
      expect(rules.maxEntitiesPerProject).toBe(10);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });
});
