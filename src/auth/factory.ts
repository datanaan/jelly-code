import type { IAuthProvider } from '../store/interfaces.js';
import { JellyAuthProvider } from './jelly.js';
import { StandaloneAuthProvider } from './standalone.js';
import type { AppConfig } from '../config/index.js';

/**
 * Create an authentication provider based on the deployment mode.
 */
export function createAuthProvider(config: AppConfig): IAuthProvider {
  switch (config.deployMode) {
    case 'jelly':
      if (!config.jelly) {
        throw new Error('Jelly config is required when DEPLOY_MODE=jelly');
      }
      return new JellyAuthProvider(config.jelly);

    case 'standalone':
      if (!config.standalone || config.standalone.apiKeys.length === 0) {
        console.warn('No STANDALONE_API_KEYS configured — all requests will be rejected');
      }
      return new StandaloneAuthProvider(config.standalone || { apiKeys: [] });

    default:
      throw new Error(`Unknown deploy mode: ${config.deployMode}`);
  }
}
