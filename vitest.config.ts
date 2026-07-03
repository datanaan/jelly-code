import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'src/shared/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
