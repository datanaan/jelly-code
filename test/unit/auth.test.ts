/**
 * Tests: Authentication Module (unit tests, no external deps)
 *
 * Covers:
 * - StandaloneAuthProvider (verify, quota, addKey, removeKey)
 * - JellyAuthProvider (verify with fetch mock, quota, consume)
 * - createAuthProvider factory
 * - createAuthMiddleware + createQuotaMiddleware (Express middleware)
 *
 * Auth module has ZERO test coverage before this file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAuthProvider } from '../../src/store/interfaces.js';

// ─── StandaloneAuthProvider ──────────────────────────────────────────

describe('StandaloneAuthProvider', () => {
  it('should verify valid API keys', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: ['key1', 'key2'] });

    const result = await provider.verify('key1');
    expect(result.valid).toBe(true);
    expect(result.identity).toBe('key1');
  });

  it('should reject invalid API keys', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: ['key1'] });

    const result = await provider.verify('wrong-key');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid API Key');
  });

  it('should reject empty API key', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: [] });

    const result = await provider.verify('');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('API Key required');
  });

  it('should provide unlimited quota', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: ['key'] });

    const quota = await provider.checkQuota('key');
    expect(quota.remaining).toBe(Infinity);
    expect(quota.total).toBe(Infinity);
  });

  it('should no-op consumeQuota', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: ['key'] });

    await expect(provider.consumeQuota('key', 100)).resolves.toBeUndefined();
  });

  it('should support runtime addKey and removeKey', async () => {
    const { StandaloneAuthProvider } = await import('../../src/auth/standalone.js');
    const provider = new StandaloneAuthProvider({ apiKeys: ['key1'] });

    expect((await provider.verify('key2')).valid).toBe(false);

    provider.addKey('key2');
    expect((await provider.verify('key2')).valid).toBe(true);

    provider.removeKey('key1');
    expect((await provider.verify('key1')).valid).toBe(false);
  });
});

// ─── JellyAuthProvider ────────────────────────────────────────────────

describe('JellyAuthProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should verify API key via remote endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quota_remaining: 100, quota_total: 100 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const result = await provider.verify('jelly_test_key');

    expect(result.valid).toBe(true);
    expect(result.identity).toMatch(/^jelly_[0-9a-f]+$/);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://jelly.test/v1/auth/device/quota',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'jelly_test_key' }),
      }),
    );
  });

  it('should reject API key when remote returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const result = await provider.verify('bad-key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('401');
  });

  it('should handle network errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const result = await provider.verify('key');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Auth service unavailable');
  });

  it('should check quota from remote', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quota_remaining: 50, quota_total: 100 }),
    }));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const quota = await provider.checkQuota('test-key');
    expect(quota.remaining).toBe(50);
    expect(quota.total).toBe(100);
  });

  it('should return zero quota on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const quota = await provider.checkQuota('test-key');
    expect(quota.remaining).toBe(0);
    expect(quota.total).toBe(0);
  });

  it('should consume quota (best-effort, no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    await expect(provider.consumeQuota('test-key', 1)).resolves.toBeUndefined();
  });

  it('should not throw when consume fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    await expect(provider.consumeQuota('test-key', 1)).resolves.toBeUndefined();
  });

  it('should produce deterministic hash for same key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const { JellyAuthProvider } = await import('../../src/auth/jelly.js');
    const provider = new JellyAuthProvider({ apiUrl: 'https://jelly.test' });

    const r1 = await provider.verify('same-key');
    const r2 = await provider.verify('same-key');
    expect(r1.identity).toBe(r2.identity);
  });
});

// ─── Factory ─────────────────────────────────────────────────────────

describe('createAuthProvider', () => {
  it('should create StandaloneAuthProvider when deployMode=standalone', async () => {
    const { createAuthProvider } = await import('../../src/auth/factory.js');
    const provider = createAuthProvider({
      deployMode: 'standalone',
      standalone: { apiKeys: ['admin-key'] },
    } as any);
    const result = await provider.verify('admin-key');
    expect(result.valid).toBe(true);
  });

  it('should create JellyAuthProvider when deployMode=jelly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ quota_remaining: 100, quota_total: 100 }),
    }));

    const { createAuthProvider } = await import('../../src/auth/factory.js');
    const provider = createAuthProvider({
      deployMode: 'jelly',
      jelly: { apiUrl: 'https://jelly.test' },
    } as any);

    expect(provider).toBeDefined();
    const result = await provider.verify('test-key');
    expect(result.valid).toBe(true);
  });

  it('should throw on unknown deploy mode', async () => {
    const { createAuthProvider } = await import('../../src/auth/factory.js');
    expect(() => createAuthProvider({ deployMode: 'unknown' } as any)).toThrow('deploy mode');
  });
});

// ─── Middleware ───────────────────────────────────────────────────────

describe('Auth Middleware', () => {
  function createMockProvider(): IAuthProvider {
    return {
      verify: vi.fn().mockResolvedValue({ valid: true, identity: 'test-user' }),
      checkQuota: vi.fn().mockResolvedValue({ remaining: 50, total: 100 }),
      consumeQuota: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockReqRes(headers: Record<string, string> = {}, query: Record<string, string> = {}) {
    const req = { headers, query } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as any;
    return { req, res };
  }

  it('should authenticate via X-API-Key header', async () => {
    const { createAuthMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();
    const middleware = createAuthMiddleware(provider);

    const { req, res } = createMockReqRes({ 'x-api-key': 'valid-key' });
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.auth).toBeDefined();
    expect(req.auth.identity).toBe('test-user');
  });

  it('should authenticate via query parameter fallback', async () => {
    const { createAuthMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();
    const middleware = createAuthMiddleware(provider);

    const { req, res } = createMockReqRes({}, { apiKey: 'query-key' });
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should return 401 when no API key provided', async () => {
    const { createAuthMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();
    const middleware = createAuthMiddleware(provider);

    const { req, res } = createMockReqRes({}, {});
    const next = vi.fn();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'API Key required' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when API key is invalid', async () => {
    const { createAuthMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();
    provider.verify = vi.fn().mockResolvedValue({ valid: false, identity: '', error: 'Invalid API Key' });

    const middleware = createAuthMiddleware(provider);
    const { req, res } = createMockReqRes({ 'x-api-key': 'bad-key' });
    const next = vi.fn();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid API Key' }));
  });

  it('quota middleware should pass-through when no auth', async () => {
    const { createQuotaMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();

    const middleware = createQuotaMiddleware(provider);
    const req = { headers: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('quota middleware should return 429 when quota exhausted', async () => {
    const { createQuotaMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();
    provider.checkQuota = vi.fn().mockResolvedValue({ remaining: 0, total: 100 });

    const middleware = createQuotaMiddleware(provider);
    const req = { auth: { valid: true, identity: 'user' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
    const next = vi.fn();
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'quota_exhausted' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('quota middleware should proceed when quota available', async () => {
    const { createQuotaMiddleware } = await import('../../src/auth/middleware.js');
    const provider = createMockProvider();

    const middleware = createQuotaMiddleware(provider);
    const req = { auth: { valid: true, identity: 'user' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
    const next = vi.fn();
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(429);
  });
});
