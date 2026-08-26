import { Money } from '../money/money';
import { IS_BALANCE_SHEET, NORMAL_BALANCE, type AccountType, type Side } from './types';

/** One posted line, reduced to what a balance calculation needs. */
export interface BalanceInput {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly side: Side;
  readonly baseAmountMinor: bigint;
}

export interface AccountBalance {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly debitTotal: Money;
  readonly creditTotal: Money;
  /**
   * Signed in the direction of the account's normal balance: positive means
   * the account sits on its normal side. This is a presentation convenience;
   * the stored totals stay unsigned per side.
   */
  readonly closingBalance: Money;
}

export interface TrialBalance {
  readonly currency: string;
  readonly rows: readonly AccountBalance[];
  readonly debitTotal: Money;
  readonly creditTotal: Money;
  readonly difference: Money;
  readonly balanced: boolean;
}

/**
 * Fold posted lines into per-account debit/credit totals and a trial balance.
 *
 * Balances are always derived from lines here and in `ledger:rebuild`; the
 * `account_balances` table is a cache of exactly this computation and never an
 * independent source of truth.
 */
export function computeTrialBalance(lines: readonly BalanceInput[], baseCurrency: string): TrialBalance {
  const byAccount = new Map<string, { type: AccountType; debit: bigint; credit: bigint }>();

  for (const line of lines) {
    if (line.baseAmountMinor < 0n) {
      throw new RangeError('Base amounts are non-negative; the side carries the direction');
    }
    const current = byAccount.get(line.accountId) ?? { type: line.accountType, debit: 0n, credit: 0n };
    if (line.side === 'debit') current.debit += line.baseAmountMinor;
    else current.credit += line.baseAmountMinor;
    byAccount.set(line.accountId, current);
  }

  const rows: AccountBalance[] = [];
  let debitTotal = Money.zero(baseCurrency);
  let creditTotal = Money.zero(baseCurrency);

  for (const [accountId, totals] of byAccount) {
    const debit = Money.fromMinor(totals.debit, baseCurrency);
    const credit = Money.fromMinor(totals.credit, baseCurrency);
    const signed =
      NORMAL_BALANCE[totals.type] === 'debit' ? debit.subtract(credit) : credit.subtract(debit);
    rows.push({
      accountId,
      accountType: totals.type,
      debitTotal: debit,
      creditTotal: credit,
      closingBalance: signed,
    });
    debitTotal = debitTotal.add(debit);
    creditTotal = creditTotal.add(credit);
  }

  rows.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  const difference = debitTotal.subtract(creditTotal);

  return {
    currency: baseCurrency,
    rows,
    debitTotal,
    creditTotal,
    difference,
    balanced: difference.isZero(),
  };
}

export interface AccountingEquation {
  readonly assets: Money;
  readonly liabilities: Money;
  readonly equity: Money;
  readonly revenue: Money;
  readonly expenses: Money;
  readonly netIncome: Money;
  /** Assets - (Liabilities + Equity + Net Income). Zero when the books tie out. */
  readonly difference: Money;
  readonly balanced: boolean;
}

/**
 * Assets = Liabilities + Equity + (Revenue - Expenses).
 *
 * Net income appears explicitly because during an open year it has not yet
 * been rolled into retained earnings by the year-end closing entry.
 */
export function checkAccountingEquation(tb: TrialBalance): AccountingEquation {
  const zero = Money.zero(tb.currency);
  const sumOf = (type: AccountType): Money =>
    tb.rows.filter((r) => r.accountType === type).reduce((acc, r) => acc.add(r.closingBalance), zero);

  const assets = sumOf('asset');
  const liabilities = sumOf('liability');
  const equity = sumOf('equity');
  const revenue = sumOf('revenue');
  const expenses = sumOf('expense');
  const netIncome = revenue.subtract(expenses);
  const difference = assets.subtract(liabilities.add(equity).add(netIncome));

  return {
    assets,
    liabilities,
    equity,
    revenue,
    expenses,
    netIncome,
    difference,
    balanced: difference.isZero(),
  };
}

/** Split a trial balance into the accounts that carry forward and those that close. */
export function partitionByStatement(tb: TrialBalance): {
  balanceSheet: readonly AccountBalance[];
  incomeStatement: readonly AccountBalance[];
} {
  return {
    balanceSheet: tb.rows.filter((r) => IS_BALANCE_SHEET[r.accountType]),
    incomeStatement: tb.rows.filter((r) => !IS_BALANCE_SHEET[r.accountType]),
  };
}
