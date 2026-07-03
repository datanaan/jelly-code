import type { Request, Response, NextFunction } from 'express';
import type { IAuthProvider, AuthResult } from '../store/interfaces.js';

/**
 * Express middleware that authenticates requests via API Key.
 * 
 * Reads the API key from:
 * 1. X-API-Key header (preferred)
 * 2. apiKey query parameter (fallback)
 */
export function createAuthMiddleware(provider: IAuthProvider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] as string
      || req.query.apiKey as string;

    if (!apiKey) {
      return res.status(401).json({ error: 'API Key required' });
    }

    const result = await provider.verify(apiKey);
    if (!result.valid) {
      return res.status(401).json({ error: result.error || 'Invalid API Key' });
    }

    // Attach auth info to request for downstream use
    (req as AuthenticatedRequest).auth = result;
    next();
  };
}

/**
 * Express middleware that checks quota before allowing the request.
 * Should be used AFTER createAuthMiddleware.
 */
export function createQuotaMiddleware(provider: IAuthProvider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return next();
    }

    const quota = await provider.checkQuota(auth.identity);
    if (quota.remaining <= 0) {
      return res.status(429).json({
        error: 'quota_exhausted',
        message: '免费额度已用完',
        quota_remaining: 0,
      });
    }

    next();
  };
}

/**
 * Request type with attached auth info.
 */
export interface AuthenticatedRequest extends Request {
  auth: AuthResult;
}
