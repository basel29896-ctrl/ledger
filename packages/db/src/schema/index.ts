import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed mirror of `migrations/0001_ledger_core.sql`.
 *
 * The SQL is the source of truth — it carries the triggers, deferrable
 * constraints and partial indexes that hold the ledger together and that no
 * ORM DSL expresses. This file exists so query code is type-checked against
 * the same shapes.
 */

export const fiscalStatus = pgEnum('fiscal_status', ['open', 'soft_closed', 'closed']);
export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);
export const normalBalanceEnum = pgEnum('normal_balance', ['debit', 'credit']);
export const entryStatusEnum = pgEnum('entry_status', ['draft', 'posted', 'reversed', 'void']);
export const entrySideEnum = pgEnum('entry_side', ['debit', 'credit']);
export const sourceModuleEnum = pgEnum('source_module', [
  'manual',
  'ar',
  'ap',
  'bank',
  'inventory',
  'payroll',
  'fx',
  'depreciation',
  'opening',
  'closing',
]);

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol'),
  minorUnitExponent: smallint('minor_unit_exponent').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt,
  updatedAt,
});

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  baseCurrency: char('base_currency', { length: 3 })
    .notNull()
    .references(() => currencies.code),
  createdAt,
  updatedAt,
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('users_tenant_email_key').on(t.tenantId, t.email)],
);

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromCurrency: char('from_currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    toCurrency: char('to_currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    rateDate: date('rate_date').notNull(),
    source: text('source').notNull().default('manual'),
    createdAt,
    updatedAt,
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('exchange_rates_tenant_pair_date_key').on(
      t.tenantId,
      t.fromCurrency,
      t.toCurrency,
      t.rateDate,
    ),
  ],
);

export const fiscalYears = pgTable('fiscal_years', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: fiscalStatus('status').notNull().default('open'),
  createdAt,
  updatedAt,
  createdBy: uuid('created_by').references(() => users.id),
});

export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    periodNo: smallint('period_no').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: fiscalStatus('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id),
    createdAt,
    updatedAt,
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [index('fiscal_periods_lookup_idx').on(t.tenantId, t.startDate, t.endDate)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    nameAr: text('name_ar'),
    type: accountTypeEnum('type').notNull(),
    subtype: text('subtype'),
    normalBalance: normalBalanceEnum('normal_balance').notNull(),
    parentAccountId: uuid('parent_account_id'),
    currencyCode: char('currency_code', { length: 3 }).references(() => currencies.code),
    isBank: boolean('is_bank').notNull().default(false),
    isControlAccount: boolean('is_control_account').notNull().default(false),
    isPostable: boolean('is_postable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
    updatedAt,
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('accounts_tenant_code_key').on(t.tenantId, t.code),
    index('accounts_tenant_type_idx').on(t.tenantId, t.type),
  ],
);

export const numberSequences = pgTable(
  'number_sequences',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    docType: text('doc_type').notNull(),
    scopeKey: text('scope_key').notNull().default(''),
    prefix: text('prefix').notNull().default(''),
    nextValue: bigint('next_value', { mode: 'bigint' }).notNull().default(1n),
    padding: smallint('padding').notNull().default(6),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex('number_sequences_key').on(t.tenantId, t.docType, t.scopeKey)],
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryNo: bigint('entry_no', { mode: 'bigint' }),
    entryRef: text('entry_ref'),
    entryDate: date('entry_date').notNull(),
    periodId: uuid('period_id')
      .notNull()
      .references(() => fiscalPeriods.id),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    status: entryStatusEnum('status').notNull().default('draft'),
    sourceModule: sourceModuleEnum('source_module').notNull().default('manual'),
    sourceDocumentId: uuid('source_document_id'),
    sourceSystem: text('source_system'),
    externalId: text('external_id'),
    memo: text('memo'),
    baseCurrency: char('base_currency', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id),
    reversesEntryId: uuid('reverses_entry_id'),
    reversedByEntryId: uuid('reversed_by_entry_id'),
    reversalReason: text('reversal_reason'),
    createdAt,
    updatedAt,
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    index('journal_entries_period_idx').on(t.tenantId, t.periodId, t.status),
    index('journal_entries_date_idx').on(t.tenantId, t.entryDate),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    side: entrySideEnum('side').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currencyCode: char('currency_code', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    baseAmountMinor: bigint('base_amount_minor', { mode: 'bigint' }).notNull(),
    description: text('description'),
    contactId: uuid('contact_id'),
    costCenterId: uuid('cost_center_id'),
    projectId: uuid('project_id'),
    taxCodeId: uuid('tax_code_id'),
    createdAt,
    updatedAt,
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    uniqueIndex('journal_lines_entry_line_key').on(t.entryId, t.lineNo),
    index('journal_lines_account_idx').on(t.tenantId, t.accountId),
  ],
);

export const accountBalances = pgTable(
  'account_balances',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    periodId: uuid('period_id')
      .notNull()
      .references(() => fiscalPeriods.id),
    currencyCode: char('currency_code', { length: 3 })
      .notNull()
      .references(() => currencies.code),
    debitTotal: bigint('debit_total', { mode: 'bigint' }).notNull().default(0n),
    creditTotal: bigint('credit_total', { mode: 'bigint' }).notNull().default(0n),
    closingBalance: bigint('closing_balance', { mode: 'bigint' }).notNull().default(0n),
    rebuiltAt: timestamp('rebuilt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.periodId, t.currencyCode] })],
);
