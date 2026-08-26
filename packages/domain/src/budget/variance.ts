import Decimal from 'decimal.js';
import { Money } from '../money/money';
import type { AccountType } from '../ledger/types';

/**
 * Budgeting: spreading an annual figure across periods, and comparing it with
 * what actually happened.
 *
 * The one subtlety worth stating: "favourable" is not the sign of the variance.
 * Revenue below budget and expense above budget are both bad news, and they
 * carry opposite signs, so the account type decides how a number reads.
 */

export class BudgetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

export interface SpreadRow {
  periodNo: number;
  amountMinor: string;
}

export function spreadAnnualBudget(input: {
  currency: string;
  amountMinor: string;
  periods: number;
  method: 'even' | 'weighted';
  weights?: readonly number[];
}): SpreadRow[] {
  if (input.periods <= 0) {
    throw new BudgetError('PERIODS_NOT_POSITIVE', 'A budget needs at least one period');
  }
  const total = BigInt(input.amountMinor);

  if (input.method === 'weighted') {
    const weights = input.weights ?? [];
    if (weights.length !== input.periods) {
      throw new BudgetError(
        'WEIGHTS_MISMATCH',
        `Given ${weights.length} weights for ${input.periods} periods: the spread would be ambiguous`,
      );
    }
    if (weights.some((w) => w < 0)) {
      throw new BudgetError('WEIGHT_NEGATIVE', 'A budget weight cannot be negative');
    }
    // Largest-remainder allocation, so the parts add back to the total exactly.
    const parts = Money.fromMinor(total, input.currency).allocate(weights);
    return parts.map((part, index) => ({ periodNo: index + 1, amountMinor: part.minor.toString() }));
  }

  const each = total / BigInt(input.periods);
  const rows: SpreadRow[] = [];
  let allocated = 0n;
  for (let period = 1; period <= input.periods; period += 1) {
    // The last period carries the remainder rather than everyone carrying a fraction.
    const amount = period === input.periods ? total - allocated : each;
    allocated += amount;
    rows.push({ periodNo: period, amountMinor: amount.toString() });
  }
  return rows;
}

export interface BudgetLine {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  amountMinor: string;
}

export interface BudgetActual {
  accountId: string;
  amountMinor: string;
  code?: string;
  name?: string;
  type?: AccountType;
}

export interface VarianceLine {
  accountId: string;
  code: string;
  name: string;
  type: AccountType | null;
  budget: ReturnType<Money['toJSON']>;
  actual: ReturnType<Money['toJSON']>;
  variance: ReturnType<Money['toJSON']>;
  /** Null when the account type is unknown, so the reader is not misled. */
  isFavourable: boolean | null;
  /** Null when there is no budget to compare against. */
  variancePercent: string | null;
}

export interface VarianceReport {
  currency: string;
  fromDate: string;
  toDate: string;
  lines: VarianceLine[];
  totalBudget: ReturnType<Money['toJSON']>;
  totalActual: ReturnType<Money['toJSON']>;
  totalVariance: ReturnType<Money['toJSON']>;
}

export function budgetVariance(
  budget: readonly BudgetLine[],
  actuals: readonly BudgetActual[],
  period: { currency: string; fromDate: string; toDate: string },
): VarianceReport {
  const { currency } = period;
  const actualByAccount = new Map(actuals.map((a) => [a.accountId, a]));
  const seen = new Set<string>();
  const lines: VarianceLine[] = [];

  const build = (
    accountId: string,
    code: string,
    name: string,
    type: AccountType | null,
    budgetMinor: string,
    actualMinor: string,
  ): VarianceLine => {
    const budgeted = Money.fromMinor(budgetMinor, currency);
    const actual = Money.fromMinor(actualMinor, currency);
    const variance = actual.subtract(budgeted);
    /*
     * Revenue above budget is good; expense above budget is not. Without a type
     * we cannot say, and saying nothing beats guessing wrong.
     */
    const isFavourable =
      type === null
        ? null
        : type === 'revenue' || type === 'asset' || type === 'equity'
          ? !variance.isNegative()
          : !variance.isPositive();

    const variancePercent = budgeted.isZero()
      ? null
      : new Decimal(variance.minor.toString())
          .div(new Decimal(budgeted.minor.toString()).abs())
          .mul(100)
          .toDecimalPlaces(2)
          .toFixed(2);

    return {
      accountId,
      code,
      name,
      type,
      budget: budgeted.toJSON(),
      actual: actual.toJSON(),
      variance: variance.toJSON(),
      isFavourable,
      variancePercent,
    };
  };

  for (const line of budget) {
    seen.add(line.accountId);
    const actual = actualByAccount.get(line.accountId);
    lines.push(
      build(line.accountId, line.code, line.name, line.type, line.amountMinor, actual?.amountMinor ?? '0'),
    );
  }

  // Spending nobody budgeted for is exactly what a variance report is for.
  for (const actual of actuals) {
    if (seen.has(actual.accountId)) continue;
    lines.push(
      build(
        actual.accountId,
        actual.code ?? '',
        actual.name ?? 'Unbudgeted',
        actual.type ?? null,
        '0',
        actual.amountMinor,
      ),
    );
  }

  let totalBudget = Money.zero(currency);
  let totalActual = Money.zero(currency);
  for (const line of lines) {
    totalBudget = totalBudget.add(Money.fromMinor(line.budget.minor, currency));
    totalActual = totalActual.add(Money.fromMinor(line.actual.minor, currency));
  }

  return {
    currency,
    fromDate: period.fromDate,
    toDate: period.toDate,
    lines: lines.sort((a, b) => a.code.localeCompare(b.code)),
    totalBudget: totalBudget.toJSON(),
    totalActual: totalActual.toJSON(),
    totalVariance: totalActual.subtract(totalBudget).toJSON(),
  };
}
