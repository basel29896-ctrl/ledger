import postgres from 'postgres';
import { MINOR_UNIT_EXPONENTS } from '@acct/shared';
import { normalBalanceFor, SME_COA } from './seed/coa-sme';

/**
 * Baseline seed: currencies with their real exponents, one demo tenant, an
 * admin user, a fiscal year with twelve open periods, and the SME chart of
 * accounts. Idempotent — safe to run on every `make dev`.
 */

const CURRENCY_NAMES: Record<string, { name: string; symbol: string }> = {
  JOD: { name: 'Jordanian Dinar', symbol: 'JD' },
  USD: { name: 'US Dollar', symbol: '$' },
  EUR: { name: 'Euro', symbol: '€' },
  GBP: { name: 'Pound Sterling', symbol: '£' },
  SAR: { name: 'Saudi Riyal', symbol: 'SR' },
  AED: { name: 'UAE Dirham', symbol: 'AED' },
  EGP: { name: 'Egyptian Pound', symbol: 'E£' },
  KWD: { name: 'Kuwaiti Dinar', symbol: 'KD' },
  BHD: { name: 'Bahraini Dinar', symbol: 'BD' },
  TND: { name: 'Tunisian Dinar', symbol: 'DT' },
  OMR: { name: 'Omani Rial', symbol: 'OMR' },
  JPY: { name: 'Japanese Yen', symbol: '¥' },
};

const TENANT_SLUG = 'demo';
const ADMIN_EMAIL = 'admin@demo.local';
const FISCAL_YEAR = 2026;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      for (const [code, exponent] of Object.entries(MINOR_UNIT_EXPONENTS)) {
        const meta = CURRENCY_NAMES[code] ?? { name: code, symbol: code };
        await tx`
          INSERT INTO currencies (code, name, symbol, minor_unit_exponent)
          VALUES (${code}, ${meta.name}, ${meta.symbol}, ${exponent})
          ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                symbol = EXCLUDED.symbol,
                minor_unit_exponent = EXCLUDED.minor_unit_exponent`;
      }

      const [tenant] = await tx<{ id: string }[]>`
        INSERT INTO tenants (name, slug, base_currency)
        VALUES ('Demo Company', ${TENANT_SLUG}, 'JOD')
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id`;
      const tenantId = tenant?.id;
      if (!tenantId) throw new Error('failed to upsert tenant');

      const [admin] = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, email, display_name)
        VALUES (${tenantId}, ${ADMIN_EMAIL}, 'Demo Admin')
        ON CONFLICT (tenant_id, email) DO UPDATE SET display_name = EXCLUDED.display_name
        RETURNING id`;
      const adminId = admin?.id;

      const [year] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_years (tenant_id, name, start_date, end_date, created_by)
        VALUES (${tenantId}, ${String(FISCAL_YEAR)},
                ${`${FISCAL_YEAR}-01-01`}, ${`${FISCAL_YEAR}-12-31`}, ${adminId ?? null})
        ON CONFLICT (tenant_id, name) DO UPDATE SET start_date = EXCLUDED.start_date
        RETURNING id`;
      const yearId = year?.id;
      if (!yearId) throw new Error('failed to upsert fiscal year');

      for (let month = 1; month <= 12; month += 1) {
        const start = new Date(Date.UTC(FISCAL_YEAR, month - 1, 1));
        const end = new Date(Date.UTC(FISCAL_YEAR, month, 0));
        await tx`
          INSERT INTO fiscal_periods (tenant_id, fiscal_year_id, period_no, start_date, end_date, created_by)
          VALUES (${tenantId}, ${yearId}, ${month},
                  ${start.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}, ${adminId ?? null})
          ON CONFLICT (tenant_id, fiscal_year_id, period_no) DO NOTHING`;
      }

      // Parents first, so each child can resolve its parent by code.
      for (const account of SME_COA) {
        await tx`
          INSERT INTO accounts (
            tenant_id, code, name, name_ar, type, subtype, normal_balance,
            parent_account_id, is_bank, is_control_account, created_by
          )
          VALUES (
            ${tenantId}, ${account.code}, ${account.name}, ${account.nameAr},
            ${account.type}::account_type, ${account.subtype},
            ${normalBalanceFor(account.type)}::normal_balance,
            ${account.parent
              ? tx`(SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND code = ${account.parent})`
              : null},
            ${account.isBank ?? false}, ${account.isControlAccount ?? false}, ${adminId ?? null}
          )
          ON CONFLICT (tenant_id, code) DO UPDATE
            SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, subtype = EXCLUDED.subtype`;
      }

      await tx`
        INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
        VALUES (${tenantId}, 'journal_entry', ${yearId}, ${`JE-${FISCAL_YEAR}-`}, 5)
        ON CONFLICT (tenant_id, doc_type, scope_key) DO NOTHING`;

      const [counts] = await tx<{ accounts: string; periods: string }[]>`
        SELECT (SELECT count(*) FROM accounts WHERE tenant_id = ${tenantId})::text AS accounts,
               (SELECT count(*) FROM fiscal_periods WHERE tenant_id = ${tenantId})::text AS periods`;

      console.log(
        `seed — tenant ${TENANT_SLUG} (base JOD): ${counts?.accounts ?? '0'} accounts, ` +
          `${counts?.periods ?? '0'} fiscal periods, admin ${ADMIN_EMAIL}`,
      );
    });
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
