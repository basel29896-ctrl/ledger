#!/usr/bin/env node
/**
 * Captures the demo dataset from a running stack into a JSON fixture that the
 * static browser build serves.
 *
 * Everything here is a real API response. Nothing is hand-written, so the demo
 * cannot drift into showing numbers the system would never produce. Re-run it
 * after `scripts/demo-seed.mjs` whenever the demo data changes.
 *
 *   node scripts/capture-demo-fixture.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEMO_API_URL ?? 'http://localhost:4000/api/v1';
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'ChangeMe!2026';

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'web',
  'src',
  'demo',
  'fixture.json',
);

let cookies = '';

const call = async (method, path, body) => {
  const headers = { Accept: 'application/json', Cookie: cookies };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0];
    const jar = new Map(
      cookies
        .split('; ')
        .filter(Boolean)
        .map((c) => [c.slice(0, c.indexOf('=')), c]),
    );
    jar.set(pair.slice(0, pair.indexOf('=')), pair);
    cookies = [...jar.values()].join('; ');
  }
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
};

const get = (p) => call('GET', p);

/**
 * The API is rate limited, and rightly so. The capture walks rather than
 * sprints: sequential requests with a small gap, instead of a burst that the
 * throttler is correct to refuse.
 */
const walk = async (paths) => {
  const results = [];
  for (const path of paths) {
    results.push(await get(path));
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return results;
};

const main = async () => {
  await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });

  const [user, tenants, accounts, periods, valuation, items, warehouses, register, budgets] =
    await walk([
      '/auth/me',
      '/auth/tenants',
      '/accounts',
      '/fiscal-periods',
      '/inventory/valuation',
      '/inventory/items',
      '/inventory/warehouses',
      '/assets/register',
      '/budgets',
    ]);

  // The list endpoint is paged; the demo wants the whole year, and every entry
  // is captured with its lines so the browser can rebuild the ledger from them.
  const entryList = [];
  let cursor;
  do {
    const page = await get(`/journal-entries?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    entryList.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const entries = await walk(entryList.map((e) => `/journal-entries/${e.id}`));

  const zip = (keys, values) => Object.fromEntries(keys.map((k, i) => [k, values[i]]));

  const periodIds = periods.map((p) => p.id);
  const closeStatus = zip(
    periodIds,
    await walk(periodIds.map((id) => `/fiscal-periods/${id}/close-status`)),
  );

  const itemIds = items.map((i) => i.id);
  const movements = zip(
    itemIds,
    await walk(itemIds.map((id) => `/inventory/items/${id}/movements`)),
  );

  const assetIds = register.assets.map((a) => a.id);
  const schedules = zip(assetIds, await walk(assetIds.map((id) => `/assets/${id}/schedule`)));

  const budgetIds = budgets.map((b) => b.id);
  const variance = zip(
    budgetIds,
    await walk(
      budgetIds.map((id) => `/budgets/${id}/variance?fromDate=2026-01-01&toDate=2026-12-31`),
    ),
  );

  const fixture = {
    capturedAt: new Date().toISOString().slice(0, 10),
    user,
    tenants,
    accounts,
    periods,
    closeStatus,
    entries,
    inventory: { valuation, items, warehouses, movements },
    assets: { register, schedules },
    budgets: { list: budgets, variance },
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  const bytes = JSON.stringify(fixture).length;
  console.log(
    `fixture: ${accounts.length} accounts, ${entries.length} entries, ` +
      `${items.length} items, ${register.assets.length} assets, ` +
      `${budgets.length} budget(s) — ${(bytes / 1024).toFixed(0)} kB`,
  );
};

await main();
