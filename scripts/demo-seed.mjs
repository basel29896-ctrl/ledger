#!/usr/bin/env node
/**
 * Populates a running development stack with a year of plausible trading
 * activity, through the public API rather than by writing to the database.
 *
 * That distinction matters: everything this script creates has passed the same
 * validation, the same period rules and the same balancing triggers as anything
 * a user would enter. The demo dataset captured afterwards is therefore real
 * output of the real system, not a hand-written fixture that only looks like it.
 *
 *   node scripts/demo-seed.mjs
 */

const BASE = process.env.DEMO_API_URL ?? 'http://localhost:4000/api/v1';
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'ChangeMe!2026';

let cookies = '';

const rememberCookies = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [];
  const jar = new Map(
    cookies
      .split('; ')
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf('=')), c]),
  );
  for (const line of raw) {
    const pair = line.split(';')[0];
    jar.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  cookies = [...jar.values()].join('; ');
};

const csrf = () => /csrf_token=([^;]+)/.exec(cookies)?.[1] ?? '';

const call = async (method, path, body, idempotencyKey) => {
  const headers = { Accept: 'application/json', Cookie: cookies };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  rememberCookies(res);

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

const get = (p) => call('GET', p);
const post = (p, b, key) => call('POST', p, b, key);
const put = (p, b) => call('PUT', p, b);

/** Tolerates re-runs: a duplicate is not a failure, it is a second run. */
const idempotent = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    if (/CONFLICT|DUPLICATE|already|unique/i.test(String(error))) {
      console.log(`  · ${label} already present`);
      return undefined;
    }
    throw error;
  }
};

/** JOD carries three decimal places, so a dinar is 1000 minor units. */
const dinars = (n) => String(Math.round(n * 1000));

const main = async () => {
  await post('/auth/login', { email: EMAIL, password: PASSWORD });
  console.log('signed in');

  const accounts = await get('/accounts');
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const id = (code) => {
    const account = byCode.get(code);
    if (!account) throw new Error(`Chart of accounts has no ${code}`);
    return account.id;
  };

  // ---- Journal: a trading year, entered as ordinary manual entries ---------
  const entries = [
    ['2026-01-02', 'Shareholder capital injected', [['1120', 'debit', 60000], ['3010', 'credit', 60000]]],
    ['2026-01-05', 'Office rent, first quarter', [['5220', 'debit', 4500], ['1120', 'credit', 4500]]],
    ['2026-01-31', 'Salaries — January', [['5210', 'debit', 8200], ['1120', 'credit', 8200]]],
    ['2026-02-03', 'Consultancy invoiced to Amman Trading', [['1130', 'debit', 14000], ['4020', 'credit', 14000]]],
    ['2026-02-18', 'Utilities and telecoms', [['5230', 'debit', 640], ['5240', 'debit', 310], ['1120', 'credit', 950]]],
    ['2026-02-28', 'Salaries — February', [['5210', 'debit', 8200], ['1120', 'credit', 8200]]],
    ['2026-03-09', 'Customer settled invoice', [['1120', 'debit', 14000], ['1130', 'credit', 14000]]],
    ['2026-03-20', 'Professional fees — audit', [['5250', 'debit', 2750], ['2110', 'credit', 2750]]],
    ['2026-03-31', 'Salaries — March', [['5210', 'debit', 8200], ['1120', 'credit', 8200]]],
    ['2026-04-07', 'Bank charges', [['5280', 'debit', 85], ['1120', 'credit', 85]]],
    ['2026-04-15', 'Service revenue — retainer', [['1130', 'debit', 9500], ['4020', 'credit', 9500]]],
    ['2026-04-30', 'Salaries — April', [['5210', 'debit', 8400], ['1120', 'credit', 8400]]],
    ['2026-05-06', 'Office rent, second quarter', [['5220', 'debit', 4500], ['1120', 'credit', 4500]]],
    ['2026-05-22', 'Supplier settled', [['2110', 'debit', 2750], ['1120', 'credit', 2750]]],
    ['2026-05-31', 'Salaries — May', [['5210', 'debit', 8400], ['1120', 'credit', 8400]]],
    ['2026-06-11', 'Service revenue — implementation', [['1130', 'debit', 21500], ['4020', 'credit', 21500]]],
    ['2026-06-30', 'Salaries — June', [['5210', 'debit', 8400], ['1120', 'credit', 8400]]],
  ];

  let posted = 0;
  for (const [index, [entryDate, memo, lines]] of entries.entries()) {
    const created = await idempotent(memo, () =>
      post(
        '/journal-entries',
        {
          entryDate,
          memo,
          sourceModule: 'manual',
          status: 'posted',
          lines: lines.map(([code, side, amount]) => ({
            accountId: id(code),
            side,
            amountMinor: dinars(amount),
          })),
        },
        `demo-journal-${index}`,
      ),
    );
    if (created) posted += 1;
  }
  console.log(`journal: ${posted} entrie(s) posted`);

  // A draft left deliberately unposted, so the demo shows both states and the
  // period-close screen has something real to complain about.
  await idempotent('draft entry', () =>
    post('/journal-entries', {
      entryDate: '2026-06-28',
      memo: 'Accrual awaiting supporting document — left as a draft on purpose',
      sourceModule: 'manual',
      status: 'draft',
      lines: [
        { accountId: id('5250'), side: 'debit', amountMinor: dinars(1200) },
        { accountId: id('2120'), side: 'credit', amountMinor: dinars(1200) },
      ],
    }),
  );

  // ---- Inventory -----------------------------------------------------------
  const warehouses = await get('/inventory/warehouses');
  let main = warehouses.find((w) => w.code === 'MAIN');
  main ??= await post('/inventory/warehouses', { code: 'MAIN', name: 'Main Warehouse' });
  let spare = warehouses.find((w) => w.code === 'AQB');
  spare ??= await post('/inventory/warehouses', { code: 'AQB', name: 'Aqaba Depot' });

  const existingItems = await get('/inventory/items');
  const itemSpecs = [
    { sku: 'SRV-100', name: 'Rack Server 1U', costingMethod: 'fifo', salePriceMinor: dinars(1450) },
    { sku: 'SWT-24', name: '24-Port Switch', costingMethod: 'weighted_average', salePriceMinor: dinars(390) },
    { sku: 'UPS-3K', name: 'UPS 3kVA', costingMethod: 'fifo', salePriceMinor: dinars(720) },
  ];
  const items = [];
  for (const spec of itemSpecs) {
    const found = existingItems.find((i) => i.sku === spec.sku);
    items.push(
      found ??
        (await post('/inventory/items', {
          ...spec,
          unitOfMeasure: 'PCE',
          inventoryAccountId: id('1150'),
          cogsAccountId: id('5100'),
        })),
    );
  }

  // FIFO only means something with layers at different costs, so the server is
  // received twice at two prices before any of it is issued.
  const movements = [
    ['receipts', { itemId: items[0].id, warehouseId: main.id, quantity: '12', unitCostMinor: dinars(980), movementDate: '2026-02-10', offsetAccountId: id('2110'), reference: 'GRN-0041' }],
    ['receipts', { itemId: items[0].id, warehouseId: main.id, quantity: '8', unitCostMinor: dinars(1040), movementDate: '2026-04-12', offsetAccountId: id('2110'), reference: 'GRN-0067' }],
    ['receipts', { itemId: items[1].id, warehouseId: main.id, quantity: '40', unitCostMinor: dinars(240), movementDate: '2026-02-14', offsetAccountId: id('2110'), reference: 'GRN-0043' }],
    ['receipts', { itemId: items[1].id, warehouseId: main.id, quantity: '25', unitCostMinor: dinars(268), movementDate: '2026-05-09', offsetAccountId: id('2110'), reference: 'GRN-0072' }],
    ['receipts', { itemId: items[2].id, warehouseId: spare.id, quantity: '15', unitCostMinor: dinars(455), movementDate: '2026-03-03', offsetAccountId: id('2110'), reference: 'GRN-0055' }],
    ['issues', { itemId: items[0].id, warehouseId: main.id, quantity: '9', movementDate: '2026-05-18', reference: 'SO-0112' }],
    ['issues', { itemId: items[1].id, warehouseId: main.id, quantity: '30', movementDate: '2026-05-20', reference: 'SO-0114' }],
    ['issues', { itemId: items[2].id, warehouseId: spare.id, quantity: '4', movementDate: '2026-06-02', reference: 'SO-0121' }],
  ];
  for (const [path, body] of movements) {
    await idempotent(`${path} ${body.reference}`, () =>
      post(`/inventory/${path}`, body, `demo-${path}-${body.reference}`),
    );
  }
  console.log(`inventory: ${items.length} item(s), ${movements.length} movement(s)`);

  // ---- Fixed assets --------------------------------------------------------
  const assetSpecs = [
    { assetNo: 'FA-0001', name: 'Delivery Van', category: 'Vehicles', costMinor: dinars(28000), residualMinor: dinars(4000), method: 'straight_line', usefulLifeMonths: 60, acquiredOn: '2026-01-15', inServiceOn: '2026-02-01' },
    { assetNo: 'FA-0002', name: 'Server Rack and Network Core', category: 'IT Equipment', costMinor: dinars(16500), residualMinor: dinars(500), method: 'reducing_balance', usefulLifeMonths: 48, annualRatePercent: '30', acquiredOn: '2026-02-20', inServiceOn: '2026-03-01' },
    { assetNo: 'FA-0003', name: 'Office Fit-out', category: 'Leasehold', costMinor: dinars(9750), method: 'straight_line', usefulLifeMonths: 36, acquiredOn: '2026-03-10', inServiceOn: '2026-04-01' },
  ];
  for (const spec of assetSpecs) {
    await idempotent(spec.assetNo, () =>
      post('/assets', {
        ...spec,
        assetAccountId: id('1210'),
        accumulatedAccountId: id('1220'),
        depreciationExpenseAccountId: id('5260'),
      }),
    );
  }
  for (const periodEnd of ['2026-04-30', '2026-05-31', '2026-06-30']) {
    await idempotent(`depreciation ${periodEnd}`, () => post('/assets/depreciation-runs', { periodEnd }));
  }
  console.log(`assets: ${assetSpecs.length} asset(s), 3 depreciation run(s)`);

  // ---- Budget --------------------------------------------------------------
  const periods = await get('/fiscal-periods');
  // The period list does not carry its year, but the close status does.
  const first = periods[0];
  if (!first) throw new Error('No fiscal periods to budget against');
  const { fiscalYearId } = await get(`/fiscal-periods/${first.id}/close-status`);
  const budgets = await get('/budgets');
  let budget = budgets.find((b) => b.name === 'Operating Budget 2026');
  budget ??= await post('/budgets', { name: 'Operating Budget 2026', fiscalYearId });

  const budgetLines = [
    ['4020', 120000],
    ['5210', 100000],
    ['5220', 18000],
    ['5230', 3600],
    ['5240', 1800],
    ['5250', 6000],
    ['5260', 9000],
    ['5280', 400],
  ];
  // An approved budget refuses new lines by design, so a re-run leaves it alone
  // rather than arguing with the rule.
  if (budget.status === 'approved') {
    console.log('  · budget already approved; lines are fixed');
  } else {
    for (const [code, annual] of budgetLines) {
      await put(`/budgets/${budget.id}/accounts`, {
        accountId: id(code),
        annualAmountMinor: dinars(annual),
        method: 'even',
      });
    }
    await post(`/budgets/${budget.id}/approve`, {});
  }
  console.log(`budget: ${budgetLines.length} line(s) on ${budget.name}`);

  const tb = await get('/reports/trial-balance');
  console.log(
    `\ntrial balance: debits ${tb.totalDebit.amount}, credits ${tb.totalCredit.amount}, ` +
      `${tb.balanced ? 'balanced' : 'OUT OF BALANCE'}`,
  );
  if (!tb.balanced) process.exitCode = 1;
};

await main();
