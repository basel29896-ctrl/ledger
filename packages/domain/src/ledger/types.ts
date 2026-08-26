export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalBalance = 'debit' | 'credit';
export type Side = 'debit' | 'credit';
export type EntryStatus = 'draft' | 'posted' | 'reversed' | 'void';
export type PeriodStatus = 'open' | 'soft_closed' | 'closed';

export type SourceModule =
  | 'manual'
  | 'ar'
  | 'ap'
  | 'bank'
  | 'inventory'
  | 'payroll'
  | 'fx'
  | 'depreciation'
  | 'opening'
  | 'closing';

/** The normal balance of each account type, per the accounting equation. */
export const NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

/** Balance-sheet accounts carry forward across years; P&L accounts close into equity. */
export const IS_BALANCE_SHEET: Record<AccountType, boolean> = {
  asset: true,
  liability: true,
  equity: true,
  revenue: false,
  expense: false,
};

export interface AccountRef {
  readonly id: string;
  readonly code: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  /** Null means the account accepts any currency. */
  readonly currencyCode: string | null;
  readonly isPostable: boolean;
  readonly isActive: boolean;
}

export interface DraftLine {
  readonly lineNo: number;
  readonly accountId: string;
  readonly side: Side;
  /** Non-negative minor units in the transaction currency. Never signed. */
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  /** Rate from the transaction currency to the tenant base currency. */
  readonly fxRate: string;
  readonly baseAmountMinor: bigint;
  readonly description?: string | undefined;
}

export interface DraftEntry {
  readonly entryDate: string;
  readonly baseCurrencyCode: string;
  readonly sourceModule: SourceModule;
  readonly memo?: string | undefined;
  readonly lines: readonly DraftLine[];
}
