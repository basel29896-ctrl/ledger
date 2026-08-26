import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postEntry, startLedgerFixture, type LedgerFixture } from './helpers/ledger-fixture';

/**
 * Section 2 of the specification, asserted against a real PostgreSQL.
 * Each test proves that the database itself refuses the operation — no
 * application code is in the path.
 */

let fx: LedgerFixture;

beforeAll(async () => {
  fx = await startLedgerFixture();
}, 180_000);

afterAll(async () => {
  await fx?.stop();
});

describe('invariant 1 — every posted entry balances', () => {
  it('accepts a balanced entry', async () => {
    const entry = await postEntry(fx, {
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_160_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000_000n },
        { accountId: fx.accounts.taxPayable, side: 'credit', amountMinor: 160_000n },
      ],
    });
    expect(entry.id).toBeTruthy();
  });

  it('rejects an unbalanced entry at COMMIT, not at insert', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_160_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000_000n },
        ],
      }),
    ).rejects.toThrow(/out of balance in JOD: debits 1160000, credits 1000000/);
  });

  it('rejects a posted entry with a single line', async () => {
    await expect(
      postEntry(fx, {
        lines: [{ accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n }],
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it('rejects a posted header with no lines at all', async () => {
    await expect(
      fx.sql.begin(async (tx) => {
        await tx`
          INSERT INTO journal_entries (tenant_id, entry_date, period_id, fiscal_year_id, status, base_currency)
          VALUES (${fx.tenantId}, '2026-01-15', ${fx.periodId}, ${fx.fiscalYearId}, 'posted', 'JOD')`;
      }),
    ).rejects.toThrow(/at least two lines/);
  });

  it('requires each currency to balance independently in a multi-currency entry', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 70_900n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 70_900n },
          {
            accountId: fx.accounts.usdBank,
            side: 'debit',
            amountMinor: 10_000n,
            currencyCode: 'USD',
            fxRate: '0.7090000000',
            baseAmountMinor: 70_900n,
          },
        ],
      }),
    ).rejects.toThrow(/out of balance in USD/);
  });

  it('rejects an entry whose base-currency amounts do not balance', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          {
            accountId: fx.accounts.usdBank,
            side: 'debit',
            amountMinor: 10_000n,
            currencyCode: 'USD',
            fxRate: '0.7090000000',
            baseAmountMinor: 70_900n,
          },
          {
            accountId: fx.accounts.usdBank,
            side: 'credit',
            amountMinor: 10_000n,
            currencyCode: 'USD',
            fxRate: '0.7000000000',
            baseAmountMinor: 70_000n,
          },
        ],
      }),
    ).rejects.toThrow(/out of balance in base currency JOD/);
  });

  it('allows a draft to sit unbalanced until it is posted', async () => {
    const draft = await postEntry(fx, {
      status: 'draft',
      lines: [{ accountId: fx.accounts.cash, side: 'debit', amountMinor: 500n }],
    });
    expect(draft.entryNo).toBeNull();

    await expect(
      fx.sql`UPDATE journal_entries SET status = 'posted' WHERE id = ${draft.id}`,
    ).rejects.toThrow(/at least two lines/);
  });
});

describe('invariant 2 — posted entries are immutable', () => {
  let postedId: string;

  beforeAll(async () => {
    const entry = await postEntry(fx, {
      memo: 'immutability subject',
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 100_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 100_000n },
      ],
    });
    postedId = entry.id;
  });

  it('refuses UPDATE of a posted entry', async () => {
    await expect(
      fx.sql`UPDATE journal_entries SET memo = 'tampered' WHERE id = ${postedId}`,
    ).rejects.toThrow(/posted and immutable/);
  });

  it('refuses UPDATE of the entry date', async () => {
    await expect(
      fx.sql`UPDATE journal_entries SET entry_date = '2026-02-01' WHERE id = ${postedId}`,
    ).rejects.toThrow(/posted and immutable/);
  });

  it('refuses DELETE of a posted entry', async () => {
    await expect(fx.sql`DELETE FROM journal_entries WHERE id = ${postedId}`).rejects.toThrow(
      /cannot be deleted; post a reversing entry instead/,
    );
  });

  it('refuses UPDATE of a line on a posted entry', async () => {
    await expect(
      fx.sql`UPDATE journal_lines SET amount_minor = 1 WHERE entry_id = ${postedId}`,
    ).rejects.toThrow(/cannot be modified or deleted/);
  });

  it('refuses DELETE of a line on a posted entry', async () => {
    await expect(fx.sql`DELETE FROM journal_lines WHERE entry_id = ${postedId}`).rejects.toThrow(
      /cannot be modified or deleted/,
    );
  });

  it('permits the reversal link and only the reversal link', async () => {
    const reversal = await postEntry(fx, {
      memo: 'reversal',
      lines: [
        { accountId: fx.accounts.cash, side: 'credit', amountMinor: 100_000n },
        { accountId: fx.accounts.revenue, side: 'debit', amountMinor: 100_000n },
      ],
    });

    await fx.sql`
      UPDATE journal_entries
         SET status = 'reversed', reversed_by_entry_id = ${reversal.id}, reversal_reason = 'test'
       WHERE id = ${postedId}`;

    const [row] = await fx.sql<{ status: string; reversed_by_entry_id: string }[]>`
      SELECT status, reversed_by_entry_id FROM journal_entries WHERE id = ${postedId}`;
    expect(row?.status).toBe('reversed');
    expect(row?.reversed_by_entry_id).toBe(reversal.id);
  });

  it('allows a draft to be edited and deleted', async () => {
    const draft = await postEntry(fx, {
      status: 'draft',
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
      ],
    });
    await fx.sql`UPDATE journal_entries SET memo = 'edited draft' WHERE id = ${draft.id}`;
    await fx.sql`DELETE FROM journal_lines WHERE entry_id = ${draft.id}`;
    await fx.sql`DELETE FROM journal_entries WHERE id = ${draft.id}`;
    const rows = await fx.sql`SELECT 1 FROM journal_entries WHERE id = ${draft.id}`;
    expect(rows).toHaveLength(0);
  });
});

describe('invariant 4 and 5 — unsigned amounts, correct minor units', () => {
  it('refuses a negative amount outright', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: -100n },
          { accountId: fx.accounts.revenue, side: 'debit', amountMinor: 100n },
        ],
      }),
    ).rejects.toThrow(/amount_minor/);
  });

  it('refuses a zero-amount line', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 0n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 0n },
        ],
      }),
    ).rejects.toThrow(/greater than zero/);
  });

  it('stores JOD to three decimal places without loss', async () => {
    const entry = await postEntry(fx, {
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_160_001n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_160_001n },
      ],
    });
    const [line] = await fx.sql<{ amount_minor: string }[]>`
      SELECT amount_minor::text FROM journal_lines WHERE entry_id = ${entry.id} LIMIT 1`;
    expect(line?.amount_minor).toBe('1160001');
  });

  it('refuses a base-currency line that claims a rate other than 1', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          {
            accountId: fx.accounts.cash,
            side: 'debit',
            amountMinor: 1_000n,
            fxRate: '0.5000000000',
            baseAmountMinor: 500n,
          },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/Base-currency line must have fx_rate 1/);
  });
});

describe('account integrity', () => {
  it('refuses a posting to a summary account', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.parent, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/summary account and cannot be posted to/);
  });

  it('refuses a currency the account does not accept', async () => {
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.usdBank, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/only accepts USD/);
  });

  it('refuses an account whose normal balance contradicts its type', async () => {
    await expect(
      fx.sql`
        INSERT INTO accounts (tenant_id, code, name, type, normal_balance)
        VALUES (${fx.tenantId}, '9999', 'Wrong', 'asset', 'credit')`,
    ).rejects.toThrow(/must have normal balance debit/);
  });

  it('refuses an inactive account', async () => {
    const [acct] = await fx.sql<{ id: string }[]>`
      INSERT INTO accounts (tenant_id, code, name, type, normal_balance, is_active)
      VALUES (${fx.tenantId}, '5999', 'Closed Expense', 'expense', 'debit', false) RETURNING id`;
    await expect(
      postEntry(fx, {
        lines: [
          { accountId: acct!.id, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/is inactive/);
  });
});

describe('invariant 6 — closed periods are locked', () => {
  it('refuses a posting into a hard-closed period', async () => {
    await fx.sql`UPDATE fiscal_periods SET status = 'closed' WHERE id = ${fx.period2Id}`;
    await expect(
      postEntry(fx, {
        entryDate: '2026-02-10',
        periodId: fx.period2Id,
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/is closed and will not accept postings/);
  });

  it('refuses a posting into a soft-closed period', async () => {
    await fx.sql`UPDATE fiscal_periods SET status = 'soft_closed' WHERE id = ${fx.period2Id}`;
    await expect(
      postEntry(fx, {
        entryDate: '2026-02-10',
        periodId: fx.period2Id,
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/is soft_closed and will not accept postings/);
  });

  it('accepts the same posting once the period is reopened', async () => {
    await fx.sql`UPDATE fiscal_periods SET status = 'open' WHERE id = ${fx.period2Id}`;
    const entry = await postEntry(fx, {
      entryDate: '2026-02-10',
      periodId: fx.period2Id,
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
      ],
    });
    expect(entry.entryNo).not.toBeNull();
  });

  it('refuses an entry dated outside its own period', async () => {
    await expect(
      postEntry(fx, {
        entryDate: '2026-05-01',
        periodId: fx.periodId,
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/is outside period 1/);
  });

  it('refuses to close a period that still holds drafts', async () => {
    const draft = await postEntry(fx, {
      status: 'draft',
      entryDate: '2026-02-15',
      periodId: fx.period2Id,
      lines: [
        { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1_000n },
        { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 1_000n },
      ],
    });

    await expect(
      fx.sql`UPDATE fiscal_periods SET status = 'closed' WHERE id = ${fx.period2Id}`,
    ).rejects.toThrow(/still has 1 draft entries/);

    await fx.sql`DELETE FROM journal_lines WHERE entry_id = ${draft.id}`;
    await fx.sql`DELETE FROM journal_entries WHERE id = ${draft.id}`;
  });
});

describe('invariant 7 — idempotency', () => {
  it('refuses a second entry with the same (source_system, external_id)', async () => {
    const lines = [
      { accountId: fx.accounts.cash, side: 'debit' as const, amountMinor: 5_000n },
      { accountId: fx.accounts.revenue, side: 'credit' as const, amountMinor: 5_000n },
    ];
    await postEntry(fx, { lines, sourceSystem: 'ar', externalId: 'INV-0001' });
    await expect(
      postEntry(fx, { lines, sourceSystem: 'ar', externalId: 'INV-0001' }),
    ).rejects.toThrow(/journal_entries_idempotency_unique/);
  });

  it('allows the same external id under a different source system', async () => {
    const lines = [
      { accountId: fx.accounts.cash, side: 'debit' as const, amountMinor: 5_000n },
      { accountId: fx.accounts.revenue, side: 'credit' as const, amountMinor: 5_000n },
    ];
    const entry = await postEntry(fx, { lines, sourceSystem: 'bank', externalId: 'INV-0001' });
    expect(entry.id).toBeTruthy();
  });
});

describe('gapless numbering', () => {
  it('numbers posted entries consecutively and formats the reference', async () => {
    await fx.sql`
      INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
      VALUES (${fx.tenantId}, 'invoice', '2026', 'INV-2026-', 5)`;

    const first = await fx.sql<{ formatted: string }[]>`
      SELECT formatted FROM allocate_document_number(${fx.tenantId}, 'invoice', '2026')`;
    const second = await fx.sql<{ formatted: string }[]>`
      SELECT formatted FROM allocate_document_number(${fx.tenantId}, 'invoice', '2026')`;

    expect(first[0]?.formatted).toBe('INV-2026-00001');
    expect(second[0]?.formatted).toBe('INV-2026-00002');
  });

  it('leaves no gaps and reuses no number when a posting rolls back', async () => {
    const before = await fx.sql<{ next_value: string }[]>`
      SELECT next_value::text FROM number_sequences
       WHERE tenant_id = ${fx.tenantId} AND doc_type = 'journal_entry'`;

    await expect(
      postEntry(fx, {
        lines: [
          { accountId: fx.accounts.cash, side: 'debit', amountMinor: 1n },
          { accountId: fx.accounts.revenue, side: 'credit', amountMinor: 2n },
        ],
      }),
    ).rejects.toThrow();

    const after = await fx.sql<{ next_value: string }[]>`
      SELECT next_value::text FROM number_sequences
       WHERE tenant_id = ${fx.tenantId} AND doc_type = 'journal_entry'`;
    expect(after[0]?.next_value).toBe(before[0]?.next_value);
  });

  it('has produced a contiguous run of entry numbers so far', async () => {
    const rows = await fx.sql<{ no: string }[]>`
      SELECT entry_no::text AS no FROM journal_entries
       WHERE tenant_id = ${fx.tenantId} AND entry_no IS NOT NULL
       ORDER BY journal_entries.entry_no`;
    const numbers = rows.map((r) => Number(r.no));
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});
