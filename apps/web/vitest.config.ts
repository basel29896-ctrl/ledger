import { defineConfig } from 'vitest/config';

// Playwright owns `e2e/`; vitest must not try to run browser specs itself.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
