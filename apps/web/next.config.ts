import type { NextConfig } from 'next';

/**
 * Two builds come out of this one application.
 *
 * The ordinary build talks to the NestJS API over `NEXT_PUBLIC_API_URL`. The
 * demo build (`NEXT_PUBLIC_DEMO=1`) is a static export for GitHub Pages, which
 * serves files and nothing else: no Node process, no database, no API. In that
 * build the API client answers requests in the browser instead — see
 * `src/demo/backend.ts` for exactly what is computed and what is replayed.
 */
const demo = process.env.NEXT_PUBLIC_DEMO === '1';

/* Pages serves a project site from a sub-path, so assets and links need it. */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const config: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
    NEXT_PUBLIC_DEMO: demo ? '1' : '',
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  ...(demo
    ? {
        output: 'export' as const,
        basePath,
        // Pages resolves `/journal/` to `journal/index.html`; without the
        // trailing slash a refresh on a nested route 404s.
        trailingSlash: true,
        // The image optimiser needs a server, and a static export has none.
        images: { unoptimized: true },
      }
    : {}),
};

export default config;
