import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each suite starts its own PostgreSQL container.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
