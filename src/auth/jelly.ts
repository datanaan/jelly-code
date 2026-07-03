import type { IAuthProvider, AuthResult, QuotaInfo } from '../store/interfaces.js';
import type { JellyConfig } from '../config/index.js';

/**
 * Jelly-mode authentication provider.
 * 
 * Validates API keys by calling the Jelly backend's
 * /v1/auth/device/quota endpoint. Quota is managed by Jelly.
 */
export class JellyAuthProvider implements IAuthProvider {
  constructor(private config: JellyConfig) {}

  async verify(apiKey: string): Promise<AuthResult> {
    try {
      const response = await fetch(`${this.config.apiUrl}/v1/auth/device/quota`, {
        headers: { 'X-API-Key': apiKey },
      });

      if (!response.ok) {
        return { valid: false, identity: '', error: `Invalid API Key (${response.status})` };
      }

      return { valid: true, identity: this.hashKey(apiKey) };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, identity: '', error: `Auth service unavailable: ${message}` };
    }
  }

  async checkQuota(identity: string): Promise<QuotaInfo> {
    try {
      // Reconstruct: we stored the hash, but Jelly needs the original key
      // In practice, the middleware passes the original key via req.auth
      const response = await fetch(`${this.config.apiUrl}/v1/auth/device/quota`, {
        headers: { 'X-API-Key': identity },
      });

      if (!response.ok) {
        return { remaining: 0, total: 0 };
      }

      const data = await response.json() as Record<string, unknown>;
      return {
        remaining: (data.quota_remaining as number) || 0,
        total: (data.quota_total as number) || 0,
      };
    } catch {
      return { remaining: 0, total: 0 };
    }
  }

  async consumeQuota(identity: string, amount: number): Promise<void> {
    try {
      await fetch(`${this.config.apiUrl}/v1/auth/device/consume`, {
        method: 'POST',
        headers: {
          'X-API-Key': identity,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount }),
      });
    } catch {
      // Log but don't throw — quota tracking is best-effort
      console.error('Failed to consume quota from Jelly');
    }
  }

  /** Simple hash for identity storage */
  private hashKey(key: string): string {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return `jelly_${Math.abs(hash).toString(16)}`;
  }
}
