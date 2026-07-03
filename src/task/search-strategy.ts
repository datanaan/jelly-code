import type { ProjectState, SearchStrategy, SearchResultMeta } from './types.js';

export function resolveSearchStrategy(state: ProjectState): SearchStrategy {
  switch (state.status) {
    case 'ready':     return 'fresh';
    case 'analyzing': return 'stale';
    case 'queued':    return 'stale+wait';
    case 'idle':      return 'not_found';
    case 'error':     return 'stale+error';
    case 'cancelled': return 'not_found';
  }
}

export function wrapSearchResult(
  result: Record<string, unknown>,
  strategy: SearchStrategy,
  analyzingSince?: Date,
): Record<string, unknown> & { _meta?: SearchResultMeta } {
  if (strategy === 'fresh' || strategy === 'not_found') {
    return result;
  }

  const meta: SearchResultMeta = {};

  if (strategy.startsWith('stale')) {
    meta.stale = true;
    if (analyzingSince) meta.analyzingSince = analyzingSince;
  }

  if (strategy === 'stale+wait') {
    meta._hint = 'Analysis in progress. Results may be outdated.';
  }

  if (strategy === 'stale+error') {
    meta._hint = 'Previous analysis failed. Results may be outdated.';
  }

  return { ...result, _meta: meta };
}