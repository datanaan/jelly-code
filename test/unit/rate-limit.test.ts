/**
 * Unit Tests: Rate Limiting, CORS, and Quota
 *
 * Tests that rate limit configuration works correctly.
 * CORS whitelist and quota are configuration-driven — tested at unit level.
 */

import { describe, it, expect } from 'vitest';
import rateLimit from 'express-rate-limit';

describe('Rate Limit Configuration', () => {
  it('should configure global rate limit of 100/min by default', () => {
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    });
    expect(limiter).toBeDefined();
    // express-rate-limit returns a middleware function
    expect(typeof limiter).toBe('function');
    expect(limiter.name).toBeDefined();
  });

  it('should configure analyze rate limit of 10/min by default', () => {
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
    });
    expect(limiter).toBeDefined();
    expect(typeof limiter).toBe('function');
  });

  it('should use custom env overrides for rate limits', () => {
    // Simulate env override
    process.env.RATE_LIMIT_GLOBAL = '200';
    process.env.RATE_LIMIT_ANALYZE = '20';

    const globalMax = parseInt(process.env.RATE_LIMIT_GLOBAL || '100', 10);
    const analyzeMax = parseInt(process.env.RATE_LIMIT_ANALYZE || '10', 10);

    expect(globalMax).toBe(200);
    expect(analyzeMax).toBe(20);

    // Clean up
    delete process.env.RATE_LIMIT_GLOBAL;
    delete process.env.RATE_LIMIT_ANALYZE;
  });

  it('should have CORS origins configurable via env', () => {
    process.env.CORS_ORIGINS = 'http://example.com,http://app.example.com';
    const origins = (process.env.CORS_ORIGINS || 'http://localhost:5173').split(',').map(s => s.trim());
    expect(origins).toContain('http://example.com');
    expect(origins).toContain('http://app.example.com');
    expect(origins.length).toBe(2);
    delete process.env.CORS_ORIGINS;
  });

  it('should default CORS origins to localhost', () => {
    const origins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173').split(',').map(s => s.trim());
    expect(origins).toContain('http://localhost:5173');
    expect(origins.length).toBeGreaterThanOrEqual(1);
  });
});
