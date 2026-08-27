#!/usr/bin/env node
/**
 * Builds the static documentation site published to GitHub Pages.
 *
 * Pages carries two things: the demo application at the root, and — built here
 * — the written record beneath it at /docs. The README, the milestone notes and
 * the decision log explain what the demo cannot show on its own, which is why
 * the system is built the way it is.
 *
 * The site is deliberately dependency-light: one markdown renderer, one
 * stylesheet, no client-side framework. It uses the same palette as the
 * application so the documentation and the product look like one thing.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The demo application owns the site root; the written record lives under it.
const outDir = join(root, 'site', 'docs');

/** Milestone order is chronological, not lexicographic: M2 comes before M10. */
const milestoneOrder = (name) => {
  const match = /^M(\d+)/.exec(name);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
};

const titleOf = (markdown, fallback) => {
  const heading = /^#\s+(.+)$/m.exec(markdown);
  return heading?.[1]?.trim() ?? fallback;
};

/**
 * Rewrites in-repo markdown links to their published counterparts, so a link
 * that works in the editor also works on the site.
 */
const rewriteLinks = (html) =>
  html
    .replace(/href="(?:\.\/)?docs\/([\w.-]+)\.md"/g, 'href="./$1.html"')
    .replace(/href="(?:\.\/)?([\w.-]+)\.md"/g, (whole, name) =>
      name === 'README' ? 'href="./index.html"' : `href="./${name}.html"`,
    );

const layout = ({ title, nav, body, depth }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Ledger</title>
<meta name="description" content="Documentation for a self-hosted, multi-tenant double-entry accounting system." />
<link rel="stylesheet" href="${depth}style.css" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e1821'/%3E%3Ctext x='16' y='23' font-size='19' font-family='system-ui' text-anchor='middle' fill='%23b0fbc1'%3E%E2%80%B1%3C/text%3E%3C/svg%3E" />
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <nav class="rail" aria-label="Documentation">
    <a class="brand" href="${depth}index.html">
      <span class="mark" aria-hidden="true">‱</span>
      <span><strong>Ledger</strong><small>double-entry accounting</small></span>
    </a>
    ${nav}
    <a class="repo" href="../">← Back to the demo</a>
    <a class="repo repo-last" href="https://github.com/basel29896-ctrl/ledger">Source on GitHub →</a>
  </nav>
  <main id="main" class="page">
    <article class="prose">${body}</article>
  </main>
</div>
</body>
</html>
`;

const style = `:root {
  --ink-800: #0e1821;
  --ink-700: #0b2229;
  --ink-500: #476069;
  --ink-300: #8fa4ab;
  --mint-300: #b0fbc1;
  --mint-700: #1f6b3c;
  --ice-100: #e1f0ee;
  --ice-200: #cfe4e1;
  --amber-400: #ffc120;
  --canvas: #f5f9f9;
  --surface: #ffffff;
}
* { box-sizing: border-box; }
html { font-variant-numeric: tabular-nums; -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--canvas);
  color: var(--ink-800);
  font: 15px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.skip { position: absolute; inset-inline-start: -9999px; }
.skip:focus { inset-inline-start: 1rem; top: 1rem; background: var(--mint-300); padding: .5rem .75rem; border-radius: .375rem; z-index: 10; }
.shell { display: flex; min-height: 100vh; align-items: flex-start; }
.rail {
  position: sticky; top: 0; flex: 0 0 17rem; align-self: stretch;
  display: flex; flex-direction: column; gap: .25rem;
  max-height: 100vh; overflow-y: auto;
  padding: 1.25rem 1rem 1.5rem;
  background: var(--ink-800); color: var(--ice-100);
}
.brand { display: flex; align-items: center; gap: .625rem; padding: .25rem .5rem 1rem; color: inherit; text-decoration: none; }
.brand .mark {
  display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: .5rem;
  background: var(--mint-300); color: var(--ink-800); font-size: 1.1rem; font-weight: 700;
}
.brand strong { display: block; font-size: .95rem; letter-spacing: -0.01em; }
.brand small { display: block; font-size: .7rem; color: var(--ink-300); }
.rail h2 {
  margin: 1rem .5rem .35rem; font-size: .68rem; font-weight: 600;
  letter-spacing: .09em; text-transform: uppercase; color: var(--ink-300);
}
.rail a.item {
  display: block; padding: .35rem .5rem; border-radius: .375rem;
  color: var(--ice-100); text-decoration: none; font-size: .84rem;
}
.rail a.item:hover { background: rgba(255,255,255,.07); }
.rail a.item[aria-current="page"] { background: var(--mint-300); color: var(--ink-800); font-weight: 600; }
.repo { margin-top: auto; padding: .75rem .5rem 0; font-size: .78rem; color: var(--mint-300); text-decoration: none; }
.repo-last { margin-top: 0; padding-top: .35rem; }
.repo:hover { text-decoration: underline; }
.page { flex: 1 1 auto; min-width: 0; padding: 2.5rem clamp(1rem, 4vw, 3.5rem) 5rem; }
.prose { max-width: 46rem; }
.prose > :first-child { margin-top: 0; }
.prose h1 { font-size: 1.85rem; line-height: 1.2; letter-spacing: -0.02em; margin: 0 0 .35em; }
.prose h2 { font-size: 1.2rem; margin: 2.25em 0 .5em; padding-bottom: .3em; border-bottom: 1px solid var(--ice-200); }
.prose h3 { font-size: 1rem; margin: 1.75em 0 .4em; }
.prose p, .prose li { color: var(--ink-700); }
.prose a { color: var(--ink-700); text-decoration: underline; text-decoration-color: var(--ice-200); text-underline-offset: 2px; }
.prose a:hover { text-decoration-color: var(--ink-500); }
.prose code {
  font: .86em/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: var(--ice-100); padding: .1em .35em; border-radius: .25rem;
}
.prose pre {
  background: var(--ink-800); color: var(--ice-100);
  padding: .9rem 1rem; border-radius: .5rem; overflow-x: auto;
}
.prose pre code { background: none; padding: 0; color: inherit; }
.prose blockquote {
  margin: 1.25em 0; padding: .1em 1rem; border-inline-start: 3px solid var(--mint-300);
  color: var(--ink-500);
}
.prose table { width: 100%; border-collapse: collapse; margin: 1.25em 0; font-size: .88rem; display: block; overflow-x: auto; }
.prose th, .prose td { padding: .375rem .75rem; border-bottom: 1px solid var(--ice-200); text-align: start; vertical-align: top; }
.prose th { background: var(--ice-100); font-size: .72rem; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-500); }
.prose hr { border: 0; border-top: 1px solid var(--ice-200); margin: 2.5em 0; }
:focus-visible { outline: 2px solid var(--mint-700); outline-offset: 2px; }
@media (max-width: 820px) {
  .shell { flex-direction: column; }
  .rail { position: static; flex: none; width: 100%; max-height: none; }
  .repo { margin-top: 1rem; }
}
`;

const build = async () => {
  const docFiles = (await readdir(join(root, 'docs')))
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => milestoneOrder(a) - milestoneOrder(b) || a.localeCompare(b));

  const pages = [{ slug: 'index', source: join(root, 'README.md'), group: 'Overview' }];
  for (const file of docFiles) {
    pages.push({
      slug: file.replace(/\.md$/, ''),
      source: join(root, 'docs', file),
      group: file.startsWith('M') ? 'Milestones' : 'Reference',
    });
  }

  const rendered = [];
  for (const page of pages) {
    const markdown = await readFile(page.source, 'utf8');
    rendered.push({
      ...page,
      title: page.slug === 'index' ? 'Overview' : titleOf(markdown, page.slug),
      html: rewriteLinks(marked.parse(markdown, { async: false })),
    });
  }

  const groups = ['Overview', 'Reference', 'Milestones'];
  const navFor = (current) =>
    groups
      .filter((g) => rendered.some((p) => p.group === g))
      .map((g) => {
        const items = rendered
          .filter((p) => p.group === g)
          .map(
            (p) =>
              `<a class="item" href="./${p.slug}.html"${
                p.slug === current ? ' aria-current="page"' : ''
              }>${p.title}</a>`,
          )
          .join('\n      ');
        return `<h2>${g}</h2>\n      ${items}`;
      })
      .join('\n    ');

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'style.css'), style, 'utf8');

  for (const page of rendered) {
    await writeFile(
      join(outDir, `${page.slug}.html`),
      layout({ title: page.title, nav: navFor(page.slug), body: page.html, depth: './' }),
      'utf8',
    );
  }

  console.log(`docs site — ${rendered.length} page(s) written to site/docs/`);
};

await build();
