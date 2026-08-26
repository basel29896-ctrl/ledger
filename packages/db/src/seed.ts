import postgres from 'postgres';
import argon2 from 'argon2';
import { MINOR_UNIT_EXPONENTS } from '@acct/shared';
import { normalBalanceFor, SME_COA } from './seed/coa-sme';
import { SYSTEM_ROLES } from './seed/roles';

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
// Development convenience only. Production seeds must supply SEED_ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';

async function main(): Promise<void> {
  // Seeds and maintenance span tenants, so they use the owner connection.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
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

      // Argon2id: memory-hard, the OWASP recommendation for password storage.
      const passwordHash = await argon2.hash(ADMIN_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });

      const [admin] = await tx<{ id: string }[]>`
        INSERT INTO users (tenant_id, email, display_name, password_hash)
        VALUES (${tenantId}, ${ADMIN_EMAIL}, 'Demo Admin', ${passwordHash})
        ON CONFLICT (tenant_id, email) DO UPDATE
          SET display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash
        RETURNING id`;
      const adminId = admin?.id;

      // Roles and their permission grants.
      for (const role of SYSTEM_ROLES) {
        const [saved] = await tx<{ id: string }[]>`
          INSERT INTO roles (tenant_id, code, name, description, is_system)
          VALUES (${tenantId}, ${role.code}, ${role.name}, ${role.description}, true)
          ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
          RETURNING id`;
        await tx`DELETE FROM role_permissions WHERE role_id = ${saved!.id}`;
        const codes =
          role.permissions === '*'
            ? (await tx<{ code: string }[]>`SELECT code FROM permissions`).map((r) => r.code)
            : role.permissions;
        for (const code of codes) {
          await tx`
            INSERT INTO role_permissions (role_id, permission_code) VALUES (${saved!.id}, ${code})
            ON CONFLICT DO NOTHING`;
        }
        if (role.code === 'admin' && adminId) {
          await tx`
            INSERT INTO user_roles (user_id, role_id, tenant_id)
            VALUES (${adminId}, ${saved!.id}, ${tenantId})
            ON CONFLICT DO NOTHING`;
        }
      }

      await tx`
        INSERT INTO company_settings (tenant_id, legal_name, legal_name_ar, tax_number, address, base_currency, default_locale)
        VALUES (${tenantId}, 'Demo Company LLC', 'شركة العرض التجريبي', '1234567',
                'Amman, Jordan', 'JOD', 'en')
        ON CONFLICT (tenant_id) DO UPDATE SET legal_name = EXCLUDED.legal_name`;

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

      for (const [docType, prefix] of [
        ['journal_entry', `JE-${FISCAL_YEAR}-`],
        ['sales_invoice', `INV-${FISCAL_YEAR}-`],
        ['credit_note', `CN-${FISCAL_YEAR}-`],
        ['customer_receipt', `RCT-${FISCAL_YEAR}-`],
        ['vendor_bill', `BILL-${FISCAL_YEAR}-`],
        ['vendor_payment', `PAY-${FISCAL_YEAR}-`],
        ['purchase_order', `PO-${FISCAL_YEAR}-`],
        ['goods_receipt', `GRN-${FISCAL_YEAR}-`],
        ['debit_note', `DN-${FISCAL_YEAR}-`],
      ] as const) {
        await tx`
          INSERT INTO number_sequences (tenant_id, doc_type, scope_key, prefix, padding)
          VALUES (${tenantId}, ${docType}, ${docType === 'journal_entry' ? yearId : ''}, ${prefix}, 5)
          ON CONFLICT (tenant_id, doc_type, scope_key) DO NOTHING`;
      }

      // Generic tax codes; the Jordan set with its rates and rules is seeded in M7.
      const [outputTax] = await tx<{ id: string }[]>`
        SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND code = '2130'`;
      const [inputTax] = await tx<{ id: string }[]>`
        SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND code = '1170'`;
      for (const code of [
        { code: 'GST16', name: 'General Sales Tax 16%', nameAr: 'ضريبة المبيعات العامة ١٦٪', rate: '16' },
        { code: 'GST0', name: 'Zero rated', nameAr: 'معفى بنسبة صفر', rate: '0' },
      ]) {
        await tx`
          INSERT INTO tax_codes (tenant_id, code, name, name_ar, kind, rate_percent,
                                 output_account_id, input_account_id)
          VALUES (${tenantId}, ${code.code}, ${code.name}, ${code.nameAr}, 'both', ${code.rate},
                  ${outputTax?.id ?? null}, ${inputTax?.id ?? null})
          ON CONFLICT (tenant_id, code) DO UPDATE SET rate_percent = EXCLUDED.rate_percent`;
      }

      const [counts] = await tx<{ accounts: string; periods: string }[]>`
        SELECT (SELECT count(*) FROM accounts WHERE tenant_id = ${tenantId})::text AS accounts,
               (SELECT count(*) FROM fiscal_periods WHERE tenant_id = ${tenantId})::text AS periods`;

      console.log(
        `seed — tenant ${TENANT_SLUG} (base JOD): ${counts?.accounts ?? '0'} accounts, ` +
          `${counts?.periods ?? '0'} fiscal periods, ${SYSTEM_ROLES.length} roles, ` +
          `admin ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`,
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
