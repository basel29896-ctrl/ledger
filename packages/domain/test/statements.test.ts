import { describe, expect, it } from 'vitest';
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildEquityStatement,
  buildIncomeStatement,
  StatementError,
  type AccountBalanceRow,
} from '../src/statements/statements';

/**
 * One coherent set of balances for a JOD tenant, so every statement in this
 * file is built from the same ledger and must therefore agree with the others.
 *
 * Opening: capital 100.000, bank 100.000.
 * Period:  sale 1000.000 on credit, 400.000 collected, COGS 300.000 of stock bought for cash, rent 100.000 paid, depreciation 50.000, equipment bought
 *          for 200.000 cash, loan drawn 150.000.
 */
const rows: AccountBalanceRow[] = [
  row('1120', 'Bank', 'asset', 'bank', { od: '100000', pd: '550000', pc: '600000' }),
  row('1130', 'Accounts Receivable', 'asset', 'receivable', { pd: '1000000', pc: '400000' }),
  row('1150', 'Inventory', 'asset', 'inventory', { pd: '300000', pc: '300000' }),
  row('1510', 'Equipment', 'asset', 'fixed_asset', { pd: '200000' }),
  row('1590', 'Accumulated Depreciation', 'asset', 'accumulated_depreciation', { pc: '50000' }),
  row('2410', 'Bank Loan', 'liability', 'long_term_liability', { pc: '150000' }),
  row('3010', 'Share Capital', 'equity', 'capital', { oc: '100000' }),
  row('4010', 'Sales Revenue', 'revenue', 'operating_revenue', { pc: '1000000' }),
  row('5100', 'Cost of Goods Sold', 'expense', 'cogs', { pd: '300000' }),
  row('5220', 'Rent', 'expense', 'operating_expense', { pd: '100000' }),
  row('5260', 'Depreciation Expense', 'expense', 'depreciation', { pd: '50000' }),
];

function row(
  code: string,
  name: string,
  type: AccountBalanceRow['type'],
  subtype: string,
  m: { od?: string; oc?: string; pd?: string; pc?: string },
): AccountBalanceRow {
  return {
    accountId: `acct-${code}`,
    code,
    name,
    type,
    subtype,
    openingDebitMinor: m.od ?? '0',
    openingCreditMinor: m.oc ?? '0',
    periodDebitMinor: m.pd ?? '0',
    periodCreditMinor: m.pc ?? '0',
  };
}

const period = { currency: 'JOD', fromDate: '2026-01-01', toDate: '2026-01-31' };

describe('income statement', () => {
  const pl = buildIncomeStatement(rows, period);

  it('separates cost of sales from operating expenses', () => {
    expect(pl.revenue.total.amount).toBe('1000.000');
    expect(pl.costOfSales.total.amount).toBe('300.000');
    expect(pl.grossProfit.amount).toBe('700.000');
    expect(pl.operatingExpenses.total.amount).toBe('150.000');
    expect(pl.netProfit.amount).toBe('550.000');
  });

  it('carries an account id on every line so a figure drills to its source', () => {
    for (const line of [...pl.revenue.lines, ...pl.operatingExpenses.lines]) {
      expect(line.accountId).toMatch(/^acct-/);
    }
  });

  it('ignores balance sheet accounts entirely', () => {
    const codes = [...pl.revenue.lines, ...pl.costOfSales.lines, ...pl.operatingExpenses.lines].map(
      (l) => l.code,
    );
    expect(codes).not.toContain('1120');
  });

  it('reports a comparative period and its variance', () => {
    const prior = buildIncomeStatement(
      [row('4010', 'Sales Revenue', 'revenue', 'operating_revenue', { pc: '800000' })],
      { ...period, fromDate: '2025-01-01', toDate: '2025-01-31' },
    );
    const compared = buildIncomeStatement(rows, { ...period, comparative: prior });
    expect(compared.comparative?.netProfit.amount).toBe('800.000');
    expect(compared.variance?.netProfit.amount).toBe('-250.000');
  });
});

describe('balance sheet', () => {
  const bs = buildBalanceSheet(rows, { currency: 'JOD', asOfDate: '2026-01-31' });

  it('balances: assets equal liabilities plus equity', () => {
    expect(bs.totalAssets.amount).toBe(bs.totalLiabilitiesAndEquity.amount);
    expect(bs.isBalanced).toBe(true);
  });

  it('nets accumulated depreciation against the asset it belongs to', () => {
    expect(bs.nonCurrentAssets.total.amount).toBe('150.000');
  });

  it('carries the unclosed profit for the period into equity', () => {
    expect(bs.profitForPeriod.amount).toBe('550.000');
    expect(bs.equity.total.amount).toBe('650.000');
  });

  it('refuses to report an unbalanced ledger rather than presenting one', () => {
    const broken = [...rows, row('5220', 'Rent', 'expense', 'operating_expense', { pd: '1' })];
    expect(() => buildBalanceSheet(broken, { currency: 'JOD', asOfDate: '2026-01-31' })).toThrow(
      StatementError,
    );
  });
});

describe('cash flow statement', () => {
  const cf = buildCashFlowStatement(rows, period);

  it('starts from net profit and adds back depreciation', () => {
    expect(cf.operating.netProfit.amount).toBe('550.000');
    expect(cf.operating.nonCashAdjustments.total.amount).toBe('50.000');
  });

  it('shows the working capital movement as a use of cash', () => {
    // Receivables rose by 600.000, which is cash not yet collected.
    const receivables = cf.operating.workingCapital.lines.find((l) => l.code === '1130');
    expect(receivables?.amount.amount).toBe('-600.000');
  });

  it('classifies the equipment purchase as investing and the loan as financing', () => {
    expect(cf.investing.total.amount).toBe('-200.000');
    expect(cf.financing.total.amount).toBe('150.000');
  });

  it('reconciles to the movement in the cash and bank accounts', () => {
    expect(cf.netMovement.amount).toBe('-50.000');
    expect(cf.openingCash.amount).toBe('100.000');
    expect(cf.closingCash.amount).toBe('50.000');
    expect(cf.reconciles).toBe(true);
  });
});

describe('statement of changes in equity', () => {
  const eq = buildEquityStatement(rows, period);

  it('opens at the prior equity, adds the profit and closes at the balance sheet figure', () => {
    expect(eq.openingEquity.amount).toBe('100.000');
    expect(eq.profitForPeriod.amount).toBe('550.000');
    expect(eq.closingEquity.amount).toBe('650.000');
  });
});
