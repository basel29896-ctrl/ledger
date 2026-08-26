import Decimal from 'decimal.js';
import { Money } from '../money/money';
import { convert, type ExchangeRate } from '../money/fx';
import type { AccountType, Side } from '../ledger/types';

/**
 * Period close: the year-end closing entry, FX revaluation, and accruals with
 * their reversals. Everything here produces journal lines and nothing writes:
 * the entries go through the same posting path as any other, so every ledger
 * invariant applies to them too.
 */

export class CloseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloseError';
  }
}

export interface ClosingLine {
  accountId: string;
  side: Side;
  amountMinor: string;
}

export interface ClosingAccountBalance {
  accountId: string;
  code: string;
  type: AccountType;
  debitMinor: string;
  creditMinor: string;
}

export interface YearEndClosingEntry {
  entryDate: string;
  memo: string;
  lines: ClosingLine[];
  profit: ReturnType<Money['toJSON']>;
}

/**
 * The year-end closing entry: every P&L account is written back to zero on the
 * side opposite its balance, and the net lands in retained earnings. Revenue
 * and expense accounts start the new year empty; the balance sheet is untouched.
 */
export function buildYearEndClosingEntry(
  balances: readonly ClosingAccountBalance[],
  opts: { currency: string; entryDate: string; retainedEarningsAccountId: string },
): YearEndClosingEntry {
  const { currency } = opts;
  const lines: ClosingLine[] = [];
  let profit = Money.zero(currency);

  for (const balance of balances) {
    if (balance.type !== 'revenue' && balance.type !== 'expense') {
      throw new CloseError(
        'NOT_A_PROFIT_AND_LOSS_ACCOUNT',
        `Account ${balance.code} is ${balance.type}: closing a balance sheet account would ` +
          `destroy the balance sheet. Only revenue and expense accounts are closed.`,
      );
    }
    const debit = Money.fromMinor(balance.debitMinor, currency);
    const credit = Money.fromMinor(balance.creditMinor, currency);
    // Signed the natural way: revenue positive on credit, expense on debit.
    const net = balance.type === 'revenue' ? credit.subtract(debit) : debit.subtract(credit);
    if (net.isZero()) continue;

    profit = balance.type === 'revenue' ? profit.add(net) : profit.subtract(net);
    const closingSide: Side =
      balance.type === 'revenue'
        ? net.isPositive()
          ? 'debit'
          : 'credit'
        : net.isPositive()
          ? 'credit'
          : 'debit';
    lines.push({ accountId: balance.accountId, side: closingSide, amountMinor: net.abs().minor.toString() });
  }

  if (lines.length === 0) {
    throw new CloseError(
      'NOTHING_TO_CLOSE',
      'No profit or loss account carries a balance; there is no closing entry to post.',
    );
  }

  lines.push({
    accountId: opts.retainedEarningsAccountId,
    // A profit credits retained earnings; a loss debits it.
    side: profit.isNegative() ? 'debit' : 'credit',
    amountMinor: profit.abs().minor.toString(),
  });

  return {
    entryDate: opts.entryDate,
    memo: `Year-end closing entry to ${opts.entryDate}`,
    lines,
    profit: profit.toJSON(),
  };
}

// ---------------------------------------------------------------------------
// FX revaluation
// ---------------------------------------------------------------------------

export interface MonetaryBalance {
  accountId: string;
  code: string;
  /** The foreign currency the balance is denominated in. */
  currency: string;
  /** Outstanding balance in that currency, unsigned minor units. */
  foreignMinor: string;
  /** What the ledger currently carries for it in the base currency. */
  baseMinor: string;
  normalBalance: 'debit' | 'credit';
}

export interface FxRevaluationRun {
  asOfDate: string;
  memo: string;
  lines: ClosingLine[];
  netGain: ReturnType<Money['toJSON']>;
  isEmpty: boolean;
  details: {
    accountId: string;
    code: string;
    currency: string;
    revaluedBaseMinor: string;
    carriedBaseMinor: string;
    differenceMinor: string;
  }[];
}

/**
 * Restate foreign-currency monetary balances at the closing rate. The gain or
 * loss is unrealised: nothing has settled, only the reporting value changed.
 * A currency with no closing rate is an error, never an assumption that the
 * rate has not moved.
 */
export function buildFxRevaluation(
  balances: readonly MonetaryBalance[],
  opts: {
    currency: string;
    asOfDate: string;
    rates: readonly ExchangeRate[];
    gainAccountId: string;
    lossAccountId: string;
    unrealisedOnly: boolean;
  },
): FxRevaluationRun {
  const { currency } = opts;
  const lines: ClosingLine[] = [];
  const details: FxRevaluationRun['details'] = [];
  let netGain = Money.zero(currency);

  for (const balance of balances) {
    if (balance.currency === currency) continue;
    const rate = opts.rates.find((r) => r.from === balance.currency && r.to === currency);
    if (!rate) {
      throw new CloseError(
        'NO_CLOSING_RATE',
        `No ${balance.currency}->${currency} rate at ${opts.asOfDate}. Revaluing without one ` +
          `would silently assume the rate did not move.`,
      );
    }

    const revalued = convert(Money.fromMinor(balance.foreignMinor, balance.currency), rate);
    const carried = Money.fromMinor(balance.baseMinor, currency);
    const difference = revalued.subtract(carried);
    details.push({
      accountId: balance.accountId,
      code: balance.code,
      currency: balance.currency,
      revaluedBaseMinor: revalued.minor.toString(),
      carriedBaseMinor: carried.minor.toString(),
      differenceMinor: difference.minor.toString(),
    });
    if (difference.isZero()) continue;

    /*
     * A debit-balance account (a receivable) worth more in base terms is a gain
     * and is debited up. A credit-balance account (a payable) worth more is a
     * loss: the same movement, the opposite effect on profit.
     */
    const increasesAccount = difference.isPositive();
    const accountSide: Side = balance.normalBalance === 'debit'
      ? increasesAccount
        ? 'debit'
        : 'credit'
      : increasesAccount
        ? 'credit'
        : 'debit';

    const gain = balance.normalBalance === 'debit' ? difference : difference.negate();
    netGain = netGain.add(gain);

    lines.push({
      accountId: balance.accountId,
      side: accountSide,
      amountMinor: difference.abs().minor.toString(),
    });
    lines.push({
      accountId: gain.isPositive() ? opts.gainAccountId : opts.lossAccountId,
      side: gain.isPositive() ? 'credit' : 'debit',
      amountMinor: gain.abs().minor.toString(),
    });
  }

  return {
    asOfDate: opts.asOfDate,
    memo: `${opts.unrealisedOnly ? 'Unrealised ' : ''}FX revaluation at ${opts.asOfDate}`,
    lines,
    netGain: netGain.toJSON(),
    isEmpty: lines.length === 0,
    details,
  };
}

// ---------------------------------------------------------------------------
// Accruals and prepayments
// ---------------------------------------------------------------------------

export interface AccrualEntry {
  entryDate: string;
  memo: string;
  lines: ClosingLine[];
}

/**
 * An accrual recognises a cost in the period it belongs to before the document
 * arrives; a prepayment defers a cost already paid. Both are posted with their
 * reversal so the following period starts clean and the bill, when it lands,
 * needs no manual unwind.
 */
export function buildAccrualEntries(opts: {
  currency: string;
  kind: 'accrual' | 'prepayment';
  amountMinor: string;
  /** The profit and loss account the cost belongs to. */
  expenseAccountId: string;
  /** The accrued liability, or the prepaid asset. */
  balanceAccountId: string;
  accrualDate: string;
  reversalDate: string;
  memo: string;
}): { accrual: AccrualEntry; reversal: AccrualEntry } {
  const amount = Money.fromMinor(opts.amountMinor, opts.currency);
  if (!amount.isPositive()) {
    throw new CloseError('NON_POSITIVE_AMOUNT', 'An accrual must be for a positive amount');
  }
  if (new Decimal(opts.reversalDate.replace(/-/g, '')).lessThanOrEqualTo(
      new Decimal(opts.accrualDate.replace(/-/g, '')),
    )) {
    throw new CloseError(
      'REVERSAL_NOT_AFTER_ACCRUAL',
      `The reversal (${opts.reversalDate}) must fall after the accrual (${opts.accrualDate}); ` +
        `otherwise the period it corrects never carries the cost.`,
    );
  }

  const minor = amount.minor.toString();
  const lines: ClosingLine[] =
    opts.kind === 'accrual'
      ? [
          { accountId: opts.expenseAccountId, side: 'debit', amountMinor: minor },
          { accountId: opts.balanceAccountId, side: 'credit', amountMinor: minor },
        ]
      : [
          { accountId: opts.balanceAccountId, side: 'debit', amountMinor: minor },
          { accountId: opts.expenseAccountId, side: 'credit', amountMinor: minor },
        ];

  const flip = (line: ClosingLine): ClosingLine => ({
    ...line,
    side: line.side === 'debit' ? 'credit' : 'debit',
  });

  return {
    accrual: { entryDate: opts.accrualDate, memo: opts.memo, lines },
    reversal: {
      entryDate: opts.reversalDate,
      memo: `Reversal of: ${opts.memo}`,
      lines: lines.map(flip),
    },
  };
}
