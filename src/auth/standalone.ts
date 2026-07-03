import type { IAuthProvider, AuthResult, QuotaInfo } from '../store/interfaces.js';
import type { StandaloneConfig } from '../config/index.js';

/**
 * Standalone-mode authentication provider.
 * 
 * Validates API keys against a local list configured via
 * STANDALONE_API_KEYS environment variable.
 * No quota tracking — unlimited usage for internal teams.
 */
export class StandaloneAuthProvider implements IAuthProvider {
  private validKeys: Set<string>;

  constructor(config: StandaloneConfig) {
    this.validKeys = new Set(config.apiKeys);
  }

  async verify(apiKey: string): Promise<AuthResult> {
    if (!apiKey) {
      return { valid: false, identity: '', error: 'API Key required' };
    }

    if (this.validKeys.has(apiKey)) {
      return { valid: true, identity: apiKey };
    }

    return { valid: false, identity: '', error: 'Invalid API Key' };
  }

  async checkQuota(_identity: string): Promise<QuotaInfo> {
    // Standalone mode: unlimited quota
    return { remaining: Infinity, total: Infinity };
  }

  async consumeQuota(_identity: string, _amount: number): Promise<void> {
    // Standalone mode: no quota tracking
  }

  /** Add a new API key at runtime (for admin operations) */
  addKey(key: string): void {
    this.validKeys.add(key);
  }

  /** Remove an API key at runtime */
  removeKey(key: string): void {
    this.validKeys.delete(key);
  }
}
