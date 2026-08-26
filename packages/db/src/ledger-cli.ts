import postgres from 'postgres';

/**
 * `ledger:rebuild` and `ledger:verify`.
 *
 * Rebuild drops the entire balance cache and recomputes it from journal lines,
 * proving invariant 3: balances are derived, never authoritative.
 *
 * Verify asserts invariant 10: for every tenant and every currency, posted
 * debits equal posted credits. A non-empty result is a P1 incident, so the
 * command exits non-zero for a monitor to pick up.
 */

interface Imbalance {
  tenant_id: string;
  currency_code: string;
  debit_total: string;
  credit_total: string;
  difference: string;
}

function connect(): postgres.Sql {
  // Seeds and maintenance span tenants, so they use the owner connection.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function rebuild(tenantId?: string): Promise<number> {
  const sql = connect();
  try {
    const started = Date.now();
    const [row] = await sql<{ ledger_rebuild_balances: string }[]>`
      SELECT ledger_rebuild_balances(${tenantId ?? null}::uuid)`;
    const rows = Number(row?.ledger_rebuild_balances ?? 0);
    console.log(
      `ledger:rebuild — ${rows} balance row(s) rebuilt from journal lines in ${Date.now() - started}ms`,
    );
    return rows;
  } finally {
    await sql.end();
  }
}

export async function verify(tenantId?: string): Promise<Imbalance[]> {
  const sql = connect();
  try {
    const imbalances = await sql<Imbalance[]>`
      SELECT * FROM ledger_verify(${tenantId ?? null}::uuid)`;

    const [counts] = await sql<{ tenants: string; entries: string; lines: string }[]>`
      SELECT (SELECT count(*) FROM tenants)::text AS tenants,
             (SELECT count(*) FROM journal_entries WHERE status IN ('posted','reversed'))::text AS entries,
             (SELECT count(*) FROM journal_lines)::text AS lines`;
    const { tenants = '0', entries = '0', lines = '0' } = counts ?? {};

    if (imbalances.length === 0) {
      console.log(
        `ledger:verify — OK. ${entries} posted entries, ${lines} lines, ${tenants} tenant(s); ` +
          'debits equal credits in every tenant and currency.',
      );
      return [];
    }

    console.error('ledger:verify — FAILED. The trial balance does not sum to zero:');
    for (const row of imbalances) {
      console.error(
        `  tenant=${row.tenant_id} currency=${row.currency_code} ` +
          `debits=${row.debit_total} credits=${row.credit_total} difference=${row.difference}`,
      );
    }
    return imbalances;
  } finally {
    await sql.end();
  }
}

/** Compare the cache against a freshly computed rebuild without persisting it. */
export async function checkCacheMatchesLines(): Promise<number> {
  const sql = connect();
  try {
    const drift = await sql<{ account_id: string; period_id: string; currency_code: string }[]>`
      WITH computed AS (
        SELECT l.tenant_id, l.account_id, e.period_id, l.currency_code,
               COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0)  AS debit_total,
               COALESCE(SUM(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0) AS credit_total
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.status IN ('posted', 'reversed')
         GROUP BY l.tenant_id, l.account_id, e.period_id, l.currency_code
      )
      SELECT COALESCE(c.account_id, b.account_id) AS account_id,
             COALESCE(c.period_id, b.period_id)   AS period_id,
             COALESCE(c.currency_code, b.currency_code) AS currency_code
        FROM computed c
        FULL OUTER JOIN account_balances b
          ON b.tenant_id = c.tenant_id AND b.account_id = c.account_id
         AND b.period_id = c.period_id AND b.currency_code = c.currency_code
       WHERE c.account_id IS NULL
          OR b.account_id IS NULL
          OR b.debit_total <> c.debit_total
          OR b.credit_total <> c.credit_total`;

    if (drift.length === 0) {
      console.log('ledger:verify — balance cache matches the journal lines exactly.');
    } else {
      console.error(`ledger:verify — ${drift.length} cached balance row(s) drifted from the journal.`);
    }
    return drift.length;
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const [command, tenantId] = process.argv.slice(2);
  switch (command) {
    case 'rebuild':
      await rebuild(tenantId);
      return;
    case 'verify': {
      const imbalances = await verify(tenantId);
      const drift = await checkCacheMatchesLines();
      if (imbalances.length > 0 || drift > 0) process.exit(1);
      return;
    }
    default:
      console.error('usage: ledger-cli <rebuild|verify> [tenantId]');
      process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
