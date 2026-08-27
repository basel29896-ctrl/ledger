/**
 * Whether this build is the static demo published to GitHub Pages.
 *
 * It is a build-time constant rather than a runtime check so that a normal
 * build drops the demo backend and its dataset entirely: a deployment talking
 * to a real API must never be able to fall back to fixture data.
 */
export const DEMO = process.env.NEXT_PUBLIC_DEMO === '1';
