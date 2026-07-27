import type { RemoteServiceConfig } from './types.js';

export function validateRemoteServiceConfig(config: RemoteServiceConfig): string[] {
  const errors: string[] = [];
  if (!config.endpoints || config.endpoints.length === 0) {
    errors.push('at least one endpoint required');
    return errors;
  }
  for (const ep of config.endpoints) {
    try {
      new URL(ep.url);
    } catch {
      errors.push(`invalid URL: ${ep.url}`);
    }
    if (!ep.model) errors.push(`endpoint ${ep.url}: model required`);
  }
  const r = config.resilience;
  if (r.maxConcurrency <= 0 || r.maxConcurrency > 1000) {
    errors.push(`maxConcurrency must be in (0, 1000], got ${r.maxConcurrency}`);
  }
  if (r.timeoutMs < 100) errors.push(`timeoutMs too small: ${r.timeoutMs}`);
  if (r.retryAttempts < 0) errors.push(`retryAttempts must be >= 0`);
  if (r.circuitFailureThreshold <= 0) errors.push(`circuitFailureThreshold must be > 0`);
  if (r.circuitResetMs < 1000) errors.push(`circuitResetMs must be >= 1000ms, got ${r.circuitResetMs}`);
  return errors;
}
