/**
 * Credential loader with priority: apiKeyFile > apiKeyEnv > apiKey.
 * Files are read once at startup; env vars read once at startup.
 */
import { readFileSync } from 'fs';
import type { EndpointCredential } from './types.js';
import { logger } from '../logger.js';

export function loadCredential(cred: EndpointCredential): string | undefined {
  // 1. apiKeyFile (highest priority)
  if (cred.apiKeyFile) {
    try {
      const raw = readFileSync(cred.apiKeyFile, 'utf-8').trim();
      if (raw) return raw;
    } catch (err) {
      // File not found: degrade gracefully to next priority (CK-28)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn({ file: cred.apiKeyFile }, 'apiKeyFile not found, degrading to next priority');
      } else {
        // File exists but unreadable: throw (permissions, format, etc.)
        throw new Error(`Failed to read apiKeyFile ${cred.apiKeyFile}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  // 2. apiKeyEnv
  if (cred.apiKeyEnv) {
    const val = process.env[cred.apiKeyEnv];
    if (val) return val;
  }
  // 3. apiKey
  return cred.apiKey;
}

/**
 * Mask credential for logs: show first 3 and last 4 chars only.
 * Short values are fully redacted.
 */
export function maskCredential(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}***${key.slice(-4)}`;
}

/**
 * Sanitize a URL for logs: strip query string (may contain tokens).
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
