import { Money } from '../money/money';

import type { AccountType } from '../ledger/types';

/**
 * One account's balance, split into what it carried before the window and what
 * moved inside it. Both halves are needed: the income statement reads movement,
 * the balance sheet reads opening + movement, and the cash flow statement needs
 * both to reconcile. Amounts are unsigned minor units, matching the ledger's
 * rule that a side and a non-negative amount carry the sign.
 */
export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  nameAr?: string | null;
  type: AccountType;
  subtype: string | null;
  openingDebitMinor: string;
  openingCreditMinor: string;
  periodDebitMinor: string;
  periodCreditMinor: string;
}

export type MoneyView = ReturnType<Money['toJSON']>;

export interface StatementLine {
  accountId: string;
  code: string;
  name: string;
  nameAr?: string | null;
  amount: MoneyView;
}

export interface StatementSection {
  key: string;
  label: string;
  lines: StatementLine[];
  total: MoneyView;
}

export class StatementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>(['asset', 'expense']);

/** Movement inside the window, signed so a positive number reads naturally. */
function periodMovement(row: AccountBalanceRow, currency: string): Money {
  const debit = Money.fromMinor(row.periodDebitMinor, currency);
  const credit = Money.fromMinor(row.periodCreditMinor, currency);
  return DEBIT_NORMAL.has(row.type) ? debit.subtract(credit) : credit.subtract(debit);
}

/** Balance at the end of the window, signed the same way. */
function closingBalance(row: AccountBalanceRow, currency: string): Money {
  const debit = Money.fromMinor(row.openingDebitMinor, currency).add(
    Money.fromMinor(row.periodDebitMinor, currency),
  );
  const credit = Money.fromMinor(row.openingCreditMinor, currency).add(
    Money.fromMinor(row.periodCreditMinor, currency),
  );
  return DEBIT_NORMAL.has(row.type) ? debit.subtract(credit) : credit.subtract(debit);
}

function openingBalance(row: AccountBalanceRow, currency: string): Money {
  const debit = Money.fromMinor(row.openingDebitMinor, currency);
  const credit = Money.fromMinor(row.openingCreditMinor, currency);
  return DEBIT_NORMAL.has(row.type) ? debit.subtract(credit) : credit.subtract(debit);
}

function section(
  key: string,
  label: string,
  rows: readonly AccountBalanceRow[],
  currency: string,
  amountOf: (row: AccountBalanceRow) => Money,
): { section: StatementSection; total: Money } {
  const lines: StatementLine[] = [];
  let total = Money.zero(currency);
  for (const row of [...rows].sort((a, b) => a.code.localeCompare(b.code))) {
    const amount = amountOf(row);
    total = total.add(amount);
    lines.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      nameAr: row.nameAr ?? null,
      amount: amount.toJSON(),
    });
  }
  return { section: { key, label, lines, total: total.toJSON() }, total };
}

// ---------------------------------------------------------------------------
// Income statement
// ---------------------------------------------------------------------------

export interface IncomeStatement {
  currency: string;
  fromDate: string;
  toDate: string;
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfit: MoneyView;
  operatingExpenses: StatementSection;
  operatingProfit: MoneyView;
  otherIncome: StatementSection;
  otherExpenses: StatementSection;
  netProfit: MoneyView;
  comparative?: IncomeStatement;
  variance?: { revenue: MoneyView; grossProfit: MoneyView; netProfit: MoneyView };
}

export interface StatementPeriod {
  currency: string;
  fromDate: string;
  toDate: string;
  comparative?: IncomeStatement;
}

const OTHER_INCOME_SUBTYPES = new Set(['other_income']);
const OTHER_EXPENSE_SUBTYPES = new Set(['other_expense']);

export function buildIncomeStatement(
  rows: readonly AccountBalanceRow[],
  period: StatementPeriod,
): IncomeStatement {
  const { currency } = period;
  const movement = (row: AccountBalanceRow): Money => periodMovement(row, currency);

  const revenueRows = rows.filter(
    (r) => r.type === 'revenue' && !OTHER_INCOME_SUBTYPES.has(r.subtype ?? ''),
  );
  const otherIncomeRows = rows.filter(
    (r) => r.type === 'revenue' && OTHER_INCOME_SUBTYPES.has(r.subtype ?? ''),
  );
  const cogsRows = rows.filter((r) => r.type === 'expense' && r.subtype === 'cogs');
  const otherExpenseRows = rows.filter(
    (r) => r.type === 'expense' && OTHER_EXPENSE_SUBTYPES.has(r.subtype ?? ''),
  );
  const opexRows = rows.filter(
    (r) => r.type === 'expense' && r.subtype !== 'cogs' && !OTHER_EXPENSE_SUBTYPES.has(r.subtype ?? ''),
  );

  const revenue = section('revenue', 'Revenue', revenueRows, currency, movement);
  const costOfSales = section('cost_of_sales', 'Cost of sales', cogsRows, currency, movement);
  const grossProfit = revenue.total.subtract(costOfSales.total);
  const operatingExpenses = section(
    'operating_expenses',
    'Operating expenses',
    opexRows,
    currency,
    movement,
  );
  const operatingProfit = grossProfit.subtract(operatingExpenses.total);
  const otherIncome = section('other_income', 'Other income', otherIncomeRows, currency, movement);
  const otherExpenses = section('other_expenses', 'Other expenses', otherExpenseRows, currency, movement);
  const netProfit = operatingProfit.add(otherIncome.total).subtract(otherExpenses.total);

  const statement: IncomeStatement = {
    currency,
    fromDate: period.fromDate,
    toDate: period.toDate,
    revenue: revenue.section,
    costOfSales: costOfSales.section,
    grossProfit: grossProfit.toJSON(),
    operatingExpenses: operatingExpenses.section,
    operatingProfit: operatingProfit.toJSON(),
    otherIncome: otherIncome.section,
    otherExpenses: otherExpenses.section,
    netProfit: netProfit.toJSON(),
  };

  if (period.comparative) {
    const prior = period.comparative;
    if (prior.currency !== currency) {
      throw new StatementError(
        'COMPARATIVE_CURRENCY_MISMATCH',
        `Comparative period is in ${prior.currency}, this period in ${currency}`,
      );
    }
    statement.comparative = prior;
    // Variance reads current minus prior, so a fall against last year is negative.
    statement.variance = {
      revenue: revenue.total.subtract(Money.fromMinor(prior.revenue.total.minor, currency)).toJSON(),
      grossProfit: grossProfit.subtract(Money.fromMinor(prior.grossProfit.minor, currency)).toJSON(),
      netProfit: netProfit.subtract(Money.fromMinor(prior.netProfit.minor, currency)).toJSON(),
    };
  }

  return statement;
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

const NON_CURRENT_ASSET_SUBTYPES = new Set(['fixed_asset', 'accumulated_depreciation']);
const NON_CURRENT_LIABILITY_SUBTYPES = new Set(['long_term_liability']);

export interface BalanceSheet {
  currency: string;
  asOfDate: string;
  currentAssets: StatementSection;
  nonCurrentAssets: StatementSection;
  totalAssets: MoneyView;
  currentLiabilities: StatementSection;
  nonCurrentLiabilities: StatementSection;
  totalLiabilities: MoneyView;
  equity: StatementSection;
  profitForPeriod: MoneyView;
  totalLiabilitiesAndEquity: MoneyView;
  isBalanced: boolean;
}

export function buildBalanceSheet(
  rows: readonly AccountBalanceRow[],
  opts: { currency: string; asOfDate: string },
): BalanceSheet {
  const { currency } = opts;
  const closing = (row: AccountBalanceRow): Money => closingBalance(row, currency);

  const assets = rows.filter((r) => r.type === 'asset');
  const currentAssetRows = assets.filter((r) => !NON_CURRENT_ASSET_SUBTYPES.has(r.subtype ?? ''));
  const nonCurrentAssetRows = assets.filter((r) => NON_CURRENT_ASSET_SUBTYPES.has(r.subtype ?? ''));
  const liabilities = rows.filter((r) => r.type === 'liability');
  const nonCurrentLiabilityRows = liabilities.filter((r) =>
    NON_CURRENT_LIABILITY_SUBTYPES.has(r.subtype ?? ''),
  );
  const currentLiabilityRows = liabilities.filter(
    (r) => !NON_CURRENT_LIABILITY_SUBTYPES.has(r.subtype ?? ''),
  );

  const currentAssets = section('current_assets', 'Current assets', currentAssetRows, currency, closing);
  const nonCurrentAssets = section(
    'non_current_assets',
    'Non-current assets',
    nonCurrentAssetRows,
    currency,
    closing,
  );
  const totalAssets = currentAssets.total.add(nonCurrentAssets.total);

  const currentLiabilities = section(
    'current_liabilities',
    'Current liabilities',
    currentLiabilityRows,
    currency,
    closing,
  );
  const nonCurrentLiabilities = section(
    'non_current_liabilities',
    'Non-current liabilities',
    nonCurrentLiabilityRows,
    currency,
    closing,
  );
  const totalLiabilities = currentLiabilities.total.add(nonCurrentLiabilities.total);

  /*
   * Profit for the period has not been closed to retained earnings yet, so it
   * sits in the unclosed P&L accounts rather than in any equity account.
   * Presenting the balance sheet without it would show an out-of-balance
   * statement, which is the exact failure this function refuses to commit.
   */
  const pl = rows.filter((r) => r.type === 'revenue' || r.type === 'expense');
  let profitForPeriod = Money.zero(currency);
  for (const row of pl) {
    const balance = closingBalance(row, currency);
    profitForPeriod =
      row.type === 'revenue' ? profitForPeriod.add(balance) : profitForPeriod.subtract(balance);
  }

  const equityRows = rows.filter((r) => r.type === 'equity');
  const equity = section('equity', 'Equity', equityRows, currency, closing);
  const totalEquity = equity.total.add(profitForPeriod);
  const equityWithProfit: StatementSection = {
    ...equity.section,
    lines: [
      ...equity.section.lines,
      {
        accountId: 'profit-for-period',
        code: '',
        name: 'Profit for the period',
        nameAr: 'ربح الفترة',
        amount: profitForPeriod.toJSON(),
      },
    ],
    total: totalEquity.toJSON(),
  };
  const totalLiabilitiesAndEquity = totalLiabilities.add(totalEquity);

  if (!totalAssets.equals(totalLiabilitiesAndEquity)) {
    throw new StatementError(
      'BALANCE_SHEET_UNBALANCED',
      `Assets ${totalAssets.toString()} do not equal liabilities plus equity ` +
        `${totalLiabilitiesAndEquity.toString()}. The ledger is inconsistent; rebuild ` +
        `balances and check the trial balance before reporting.`,
    );
  }

  return {
    currency,
    asOfDate: opts.asOfDate,
    currentAssets: currentAssets.section,
    nonCurrentAssets: nonCurrentAssets.section,
    totalAssets: totalAssets.toJSON(),
    currentLiabilities: currentLiabilities.section,
    nonCurrentLiabilities: nonCurrentLiabilities.section,
    totalLiabilities: totalLiabilities.toJSON(),
    equity: equityWithProfit,
    profitForPeriod: profitForPeriod.toJSON(),
    totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toJSON(),
    isBalanced: true,
  };
}

// ---------------------------------------------------------------------------
// Cash flow statement (indirect)
// ---------------------------------------------------------------------------

const CASH_SUBTYPES = new Set(['cash', 'bank']);
/*
 * Depreciation accumulates against the asset but never moves cash, so it is an
 * operating add-back; investing then shows the gross fixed asset movement.
 */
const NON_CASH_SUBTYPES = new Set(['accumulated_depreciation']);
const INVESTING_SUBTYPES = new Set(['fixed_asset']);
const FINANCING_SUBTYPES = new Set([
  'long_term_liability',
  'capital',
  'retained_earnings',
  'current_earnings',
]);

export interface CashFlowStatement {
  currency: string;
  fromDate: string;
  toDate: string;
  operating: {
    netProfit: MoneyView;
    nonCashAdjustments: StatementSection;
    workingCapital: StatementSection;
    total: MoneyView;
  };
  investing: StatementSection;
  financing: StatementSection;
  netMovement: MoneyView;
  openingCash: MoneyView;
  closingCash: MoneyView;
  reconciles: boolean;
}

export function buildCashFlowStatement(
  rows: readonly AccountBalanceRow[],
  period: StatementPeriod,
): CashFlowStatement {
  const { currency } = period;

  /*
   * Every non-cash account is classified exactly once. Because debits equal
   * credits, the cash effect of the non-cash accounts is the negative of their
   * own movement, so the three sections must sum to the movement in cash. That
   * identity is asserted at the end rather than assumed.
   */
  const cashEffect = (row: AccountBalanceRow): Money => {
    const debit = Money.fromMinor(row.periodDebitMinor, currency);
    const credit = Money.fromMinor(row.periodCreditMinor, currency);
    return credit.subtract(debit);
  };

  const cashRows = rows.filter((r) => CASH_SUBTYPES.has(r.subtype ?? ''));
  const nonCashRows = rows.filter((r) => !CASH_SUBTYPES.has(r.subtype ?? ''));

  const plRows = nonCashRows.filter((r) => r.type === 'revenue' || r.type === 'expense');
  const nonCashAdjustmentRows = nonCashRows.filter((r) => NON_CASH_SUBTYPES.has(r.subtype ?? ''));
  const investingRows = nonCashRows.filter((r) => INVESTING_SUBTYPES.has(r.subtype ?? ''));
  const financingRows = nonCashRows.filter((r) => FINANCING_SUBTYPES.has(r.subtype ?? ''));
  const classified = new Set([...plRows, ...nonCashAdjustmentRows, ...investingRows, ...financingRows]);
  const workingCapitalRows = nonCashRows.filter((r) => !classified.has(r));

  let netProfit = Money.zero(currency);
  for (const row of plRows) netProfit = netProfit.add(cashEffect(row));

  const nonCashAdjustments = section(
    'non_cash',
    'Non-cash adjustments',
    nonCashAdjustmentRows,
    currency,
    cashEffect,
  );
  const workingCapital = section(
    'working_capital',
    'Movements in working capital',
    workingCapitalRows,
    currency,
    cashEffect,
  );
  const investing = section('investing', 'Investing activities', investingRows, currency, cashEffect);
  const financing = section('financing', 'Financing activities', financingRows, currency, cashEffect);

  const operatingTotal = netProfit.add(nonCashAdjustments.total).add(workingCapital.total);
  const netMovement = operatingTotal.add(investing.total).add(financing.total);

  let openingCash = Money.zero(currency);
  let closingCash = Money.zero(currency);
  for (const row of cashRows) {
    openingCash = openingCash.add(openingBalance(row, currency));
    closingCash = closingCash.add(closingBalance(row, currency));
  }

  const actualMovement = closingCash.subtract(openingCash);
  if (!actualMovement.equals(netMovement)) {
    throw new StatementError(
      'CASH_FLOW_UNRECONCILED',
      `Cash flow statement nets ${netMovement.toString()} but cash moved ` +
        `${actualMovement.toString()}. An account is unclassified or the ledger is inconsistent.`,
    );
  }

  return {
    currency,
    fromDate: period.fromDate,
    toDate: period.toDate,
    operating: {
      netProfit: netProfit.toJSON(),
      nonCashAdjustments: nonCashAdjustments.section,
      workingCapital: workingCapital.section,
      total: operatingTotal.toJSON(),
    },
    investing: investing.section,
    financing: financing.section,
    netMovement: netMovement.toJSON(),
    openingCash: openingCash.toJSON(),
    closingCash: closingCash.toJSON(),
    reconciles: true,
  };
}

// ---------------------------------------------------------------------------
// Statement of changes in equity
// ---------------------------------------------------------------------------

export interface EquityStatement {
  currency: string;
  fromDate: string;
  toDate: string;
  openingEquity: MoneyView;
  movements: StatementSection;
  profitForPeriod: MoneyView;
  closingEquity: MoneyView;
}

export function buildEquityStatement(
  rows: readonly AccountBalanceRow[],
  period: StatementPeriod,
): EquityStatement {
  const { currency } = period;
  const equityRows = rows.filter((r) => r.type === 'equity');

  let openingEquity = Money.zero(currency);
  for (const row of equityRows) openingEquity = openingEquity.add(openingBalance(row, currency));

  const movements = section('equity_movements', 'Movements in equity', equityRows, currency, (row) =>
    periodMovement(row, currency),
  );

  const profitForPeriod = Money.fromMinor(
    buildIncomeStatement(rows, { currency, fromDate: period.fromDate, toDate: period.toDate })
      .netProfit.minor,
    currency,
  );
  const closingEquity = openingEquity.add(movements.total).add(profitForPeriod);

  return {
    currency,
    fromDate: period.fromDate,
    toDate: period.toDate,
    openingEquity: openingEquity.toJSON(),
    movements: movements.section,
    profitForPeriod: profitForPeriod.toJSON(),
    closingEquity: closingEquity.toJSON(),
  };
}
