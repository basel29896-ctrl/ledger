import { z } from 'zod';

/**
 * The one definition of every ledger request and response shape.
 * The API validates with these and the web app builds forms from them, so a
 * field cannot drift between the two and quietly mis-state a balance.
 */

export const uuidSchema = z.string().uuid();
export const currencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/, 'ISO 4217 code, uppercase');
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const accountTypeSchema = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);
export const sideSchema = z.enum(['debit', 'credit']);
export const entryStatusSchema = z.enum(['draft', 'posted', 'reversed', 'void']);
export const periodStatusSchema = z.enum(['open', 'soft_closed', 'closed']);
export const sourceModuleSchema = z.enum([
  'manual', 'ar', 'ap', 'bank', 'inventory', 'payroll', 'fx', 'depreciation', 'opening', 'closing',
]);

/** Money on the wire: strings only, never a float. */
export const moneySchema = z.object({
  amount: z.string(),
  minor: z.string(),
  currency: currencyCodeSchema,
});
export type MoneyDto = z.infer<typeof moneySchema>;

// --- accounts ---------------------------------------------------------

export const createAccountSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  type: accountTypeSchema,
  subtype: z.string().max(64).optional(),
  parentAccountId: uuidSchema.optional(),
  currencyCode: currencyCodeSchema.optional(),
  isBank: z.boolean().default(false),
  isControlAccount: z.boolean().default(false),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const accountSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  type: accountTypeSchema,
  subtype: z.string().nullable(),
  normalBalance: sideSchema,
  parentAccountId: uuidSchema.nullable(),
  currencyCode: currencyCodeSchema.nullable(),
  isBank: z.boolean(),
  isControlAccount: z.boolean(),
  isPostable: z.boolean(),
  isActive: z.boolean(),
});
export type AccountDto = z.infer<typeof accountSchema>;

// --- journal entries --------------------------------------------------

export const journalLineInputSchema = z.object({
  accountId: uuidSchema,
  side: sideSchema,
  /** Minor units as a string so no amount passes through a JS number. */
  amountMinor: z.string().regex(/^\d+$/, 'non-negative integer minor units'),
  currencyCode: currencyCodeSchema.optional(),
  fxRate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  baseAmountMinor: z.string().regex(/^\d+$/).optional(),
  description: z.string().max(500).optional(),
  contactId: uuidSchema.optional(),
  costCenterId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
});
export type JournalLineInput = z.infer<typeof journalLineInputSchema>;

export const createJournalEntrySchema = z.object({
  entryDate: isoDateSchema,
  memo: z.string().max(1000).optional(),
  sourceModule: sourceModuleSchema.default('manual'),
  /** `draft` saves without posting; `posted` validates and posts immediately. */
  status: z.enum(['draft', 'posted']).default('draft'),
  lines: z.array(journalLineInputSchema).min(2, 'An entry needs at least two lines'),
});
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export const journalLineSchema = z.object({
  id: uuidSchema,
  lineNo: z.number().int(),
  accountId: uuidSchema,
  accountCode: z.string(),
  accountName: z.string(),
  side: sideSchema,
  amount: moneySchema,
  baseAmount: moneySchema,
  fxRate: z.string(),
  description: z.string().nullable(),
});

export const journalEntrySchema = z.object({
  id: uuidSchema,
  entryNo: z.number().int().nullable(),
  entryRef: z.string().nullable(),
  entryDate: isoDateSchema,
  periodId: uuidSchema,
  status: entryStatusSchema,
  sourceModule: sourceModuleSchema,
  memo: z.string().nullable(),
  baseCurrency: currencyCodeSchema,
  postedAt: z.string().nullable(),
  reversesEntryId: uuidSchema.nullable(),
  reversedByEntryId: uuidSchema.nullable(),
  totalDebit: moneySchema,
  totalCredit: moneySchema,
  lines: z.array(journalLineSchema),
});
export type JournalEntryDto = z.infer<typeof journalEntrySchema>;

export const reverseEntrySchema = z.object({
  entryDate: isoDateSchema.optional(),
  reason: z.string().min(1).max(500),
});
export type ReverseEntryInput = z.infer<typeof reverseEntrySchema>;

// --- reports ----------------------------------------------------------

export const trialBalanceQuerySchema = z.object({
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
  periodId: uuidSchema.optional(),
  includeZeroBalances: z.coerce.boolean().default(false),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const trialBalanceRowSchema = z.object({
  accountId: uuidSchema,
  accountCode: z.string(),
  accountName: z.string(),
  accountType: accountTypeSchema,
  debitTotal: moneySchema,
  creditTotal: moneySchema,
  closingBalance: moneySchema,
});

export const trialBalanceSchema = z.object({
  currency: currencyCodeSchema,
  fromDate: isoDateSchema.nullable(),
  toDate: isoDateSchema.nullable(),
  rows: z.array(trialBalanceRowSchema),
  totalDebit: moneySchema,
  totalCredit: moneySchema,
  difference: moneySchema,
  balanced: z.boolean(),
});
export type TrialBalanceDto = z.infer<typeof trialBalanceSchema>;

// --- pagination and errors -------------------------------------------

export const cursorPageSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CursorPage = z.infer<typeof cursorPageSchema>;

/** RFC 9457 problem detail with a stable machine-readable `code`. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDto = z.infer<typeof problemSchema>;
