import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
  // esbuild does not emit decorator metadata, which Nest needs for injection.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
