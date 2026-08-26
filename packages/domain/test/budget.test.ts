import { describe, expect, it } from 'vitest';
import {
  BudgetError,
  budgetVariance,
  spreadAnnualBudget,
  type BudgetActual,
  type BudgetLine,
} from '../src/budget/variance';

const JOD = 'JOD';

describe('spreading an annual budget', () => {
  it('divides evenly and puts the remainder in the last period', () => {
    const rows = spreadAnnualBudget({ currency: JOD, amountMinor: '1000000', periods: 12, method: 'even' });
    expect(rows).toHaveLength(12);
    const total = rows.reduce((sum, r) => sum + BigInt(r.amountMinor), 0n);
    expect(total.toString()).toBe('1000000');
    expect(new Set(rows.slice(0, 11).map((r) => r.amountMinor)).size).toBe(1);
  });

  it('spreads by weights when the year is not flat', () => {
    const rows = spreadAnnualBudget({
      currency: JOD,
      amountMinor: '1200000',
      periods: 4,
      method: 'weighted',
      weights: [1, 1, 2, 2],
    });
    expect(rows.map((r) => r.amountMinor)).toEqual(['200000', '200000', '400000', '400000']);
  });

  it('refuses weights that do not match the periods', () => {
    expect(() =>
      spreadAnnualBudget({
        currency: JOD,
        amountMinor: '100',
        periods: 4,
        method: 'weighted',
        weights: [1, 1],
      }),
    ).toThrow(BudgetError);
  });
});

describe('variance', () => {
  const budget: BudgetLine[] = [
    { accountId: 'a-rev', code: '4010', name: 'Sales', type: 'revenue', amountMinor: '1000000' },
    { accountId: 'a-exp', code: '5220', name: 'Rent', type: 'expense', amountMinor: '200000' },
  ];
  const actual: BudgetActual[] = [
    { accountId: 'a-rev', amountMinor: '900000' },
    { accountId: 'a-exp', amountMinor: '250000' },
  ];

  const report = budgetVariance(budget, actual, { currency: JOD, fromDate: '2026-01-01', toDate: '2026-01-31' });

  it('reads revenue short of budget as unfavourable', () => {
    const revenue = report.lines.find((l) => l.accountId === 'a-rev')!;
    expect(revenue.variance.amount).toBe('-100.000');
    expect(revenue.isFavourable).toBe(false);
  });

  it('reads expense above budget as unfavourable too, despite the opposite sign', () => {
    const rent = report.lines.find((l) => l.accountId === 'a-exp')!;
    expect(rent.variance.amount).toBe('50.000');
    expect(rent.isFavourable).toBe(false);
  });

  it('reports the percentage against budget, and nothing when the budget is zero', () => {
    const revenue = report.lines.find((l) => l.accountId === 'a-rev')!;
    expect(revenue.variancePercent).toBe('-10.00');
    const noBudget = budgetVariance(
      [{ accountId: 'x', code: '5999', name: 'Unbudgeted', type: 'expense', amountMinor: '0' }],
      [{ accountId: 'x', amountMinor: '5000' }],
      { currency: JOD, fromDate: '2026-01-01', toDate: '2026-01-31' },
    );
    expect(noBudget.lines[0]?.variancePercent).toBeNull();
  });

  it('includes actuals with no budget line rather than dropping them', () => {
    const report2 = budgetVariance(budget, [...actual, { accountId: 'a-new', amountMinor: '1000' }], {
      currency: JOD,
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    expect(report2.lines.some((l) => l.accountId === 'a-new')).toBe(true);
  });

  it('totals the budget, the actual and the net variance', () => {
    expect(report.totalBudget.amount).toBe('1200.000');
    expect(report.totalActual.amount).toBe('1150.000');
  });
});
