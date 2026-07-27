import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared/index.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    env: {
      NEO4J_PASSWORD: 'password123',
      TYPESENSE_API_KEY: 'dev-key',
      STANDALONE_API_KEYS: 'dev_key_1',
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
    },
  },
});
