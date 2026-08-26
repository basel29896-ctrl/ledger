import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postEntry, startLedgerFixture, type LedgerFixture } from './helpers/ledger-fixture';

let fx: LedgerFixture;

beforeAll(async () => {
  fx = await startLedgerFixture();
}, 180_000);

afterAll(async () => {
  await fx?.stop();
});

describe('concurrency', () => {
  it('produces exactly 100 entries with a gapless sequence under parallel posting', async () => {
    const POSTINGS = 100;

    const results = await Promise.all(
      Array.from({ length: POSTINGS }, (_, i) =>
        postEntry(fx, {
          memo: `parallel ${i}`,
          lines: [
            { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
            { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
          ],
        }),
      ),
    );

    expect(results).toHaveLength(POSTINGS);

    const [{ count }] = await fx.sql<{ count: string }[]>`
      SELECT count(*)::text FROM journal_entries WHERE tenant_id = ${fx.tenantId} AND status = 'posted'`;
    expect(Number(count)).toBe(POSTINGS);

    // No lost updates: every number from 1..100 exists exactly once.
    // Alias the cast: a bare `ORDER BY entry_no` would bind to the ::text
    // output column and sort 1, 10, 100, 11 instead of numerically.
    const numbers = (
      await fx.sql<{ no: string }[]>`
        SELECT entry_no::text AS no FROM journal_entries
         WHERE tenant_id = ${fx.tenantId} AND entry_no IS NOT NULL
         ORDER BY journal_entries.entry_no`
    ).map((r) => Number(r.no));

    expect(numbers).toEqual(Array.from({ length: POSTINGS }, (_, i) => i + 1));
    expect(new Set(numbers).size).toBe(POSTINGS);

    // And the ledger still balances after all that contention.
    const imbalances = await fx.sql`SELECT * FROM ledger_verify(${fx.tenantId}::uuid)`;
    expect(imbalances).toHaveLength(0);
  }, 120_000);

  it('keeps the account total exact after 100 concurrent postings', async () => {
    const [row] = await fx.sql<{ debit_total: string }[]>`
      SELECT COALESCE(SUM(amount_minor) FILTER (WHERE side = 'debit'), 0)::text AS debit_total
        FROM journal_lines WHERE account_id = ${fx.accounts.cash}`;
    expect(row?.debit_total).toBe('100000');
  });
});

describe('ledger:rebuild', () => {
  it('reproduces byte-identical balances when run twice', async () => {
    await fx.sql`SELECT ledger_rebuild_balances(${fx.tenantId}::uuid)`;
    const first = await fx.sql<Record<string, unknown>[]>`
      SELECT account_id, period_id, currency_code, debit_total::text, credit_total::text, closing_balance::text
        FROM account_balances WHERE tenant_id = ${fx.tenantId}
       ORDER BY account_id, period_id, currency_code`;

    await fx.sql`SELECT ledger_rebuild_balances(${fx.tenantId}::uuid)`;
    const second = await fx.sql<Record<string, unknown>[]>`
      SELECT account_id, period_id, currency_code, debit_total::text, credit_total::text, closing_balance::text
        FROM account_balances WHERE tenant_id = ${fx.tenantId}
       ORDER BY account_id, period_id, currency_code`;

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  it('rebuilds from an empty cache — balances are derived, never authoritative', async () => {
    const before = await fx.sql<Record<string, unknown>[]>`
      SELECT account_id, debit_total::text, credit_total::text FROM account_balances
       WHERE tenant_id = ${fx.tenantId} ORDER BY account_id`;

    await fx.sql`DELETE FROM account_balances WHERE tenant_id = ${fx.tenantId}`;
    const emptied = await fx.sql`SELECT 1 FROM account_balances WHERE tenant_id = ${fx.tenantId}`;
    expect(emptied).toHaveLength(0);

    await fx.sql`SELECT ledger_rebuild_balances(${fx.tenantId}::uuid)`;
    const after = await fx.sql<Record<string, unknown>[]>`
      SELECT account_id, debit_total::text, credit_total::text FROM account_balances
       WHERE tenant_id = ${fx.tenantId} ORDER BY account_id`;

    expect(after).toEqual(before);
  });

  it('signs the closing balance towards each account normal balance', async () => {
    const rows = await fx.sql<{ code: string; closing_balance: string }[]>`
      SELECT a.code, b.closing_balance::text
        FROM account_balances b JOIN accounts a ON a.id = b.account_id
       WHERE b.tenant_id = ${fx.tenantId} AND a.code IN ('1110', '4010')`;

    const cash = rows.find((r) => r.code === '1110');
    const revenue = rows.find((r) => r.code === '4010');
    // Both sides are positive: cash is debit-normal, revenue is credit-normal.
    expect(Number(cash?.closing_balance)).toBe(100_000);
    expect(Number(revenue?.closing_balance)).toBe(100_000);
  });

  it('excludes drafts from the balance cache', async () => {
    const draft = await postEntry(fx, {
      status: 'draft',
      lines: [
        { accountId: fx.accounts.rent, side: 'debit', amountMinor: 999_000n },
        { accountId: fx.accounts.cash, side: 'credit', amountMinor: 999_000n },
      ],
    });

    await fx.sql`SELECT ledger_rebuild_balances(${fx.tenantId}::uuid)`;
    const rows = await fx.sql`
      SELECT 1 FROM account_balances b JOIN accounts a ON a.id = b.account_id
       WHERE b.tenant_id = ${fx.tenantId} AND a.code = '5220'`;
    expect(rows).toHaveLength(0);

    await fx.sql`DELETE FROM journal_lines WHERE entry_id = ${draft.id}`;
    await fx.sql`DELETE FROM journal_entries WHERE id = ${draft.id}`;
  });
});

describe('ledger:verify', () => {
  it('returns no rows for a healthy ledger', async () => {
    const rows = await fx.sql`SELECT * FROM ledger_verify(${fx.tenantId}::uuid)`;
    expect(rows).toHaveLength(0);
  });

  it('reports the imbalance if one is ever forced past the triggers', async () => {
    // Only reachable by disabling the trigger, which is the point: verify is the
    // backstop that catches corruption however it got in.
    await fx.sql`ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_assert_balanced`;
    const entry = await postEntry(fx, {
      status: 'draft',
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 7_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 6_000n },
      ],
    });
    await fx.sql`ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_assert_balanced`;
    await fx.sql`UPDATE journal_entries SET status = 'posted' WHERE id = ${entry.id}`;

    const rows = await fx.sql<{ difference: string }[]>`
      SELECT * FROM ledger_verify(${fx.tenantId}::uuid)`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.difference).toBe('1000');

    await fx.sql`ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_assert_balanced`;
    await fx.sql`ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_assert_balanced`;
  });
});
