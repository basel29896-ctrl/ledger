import { describe, expect, it } from 'vitest';
import {
  checkAccountingEquation,
  computeTrialBalance,
  partitionByStatement,
  type BalanceInput,
} from '../src/ledger/trial-balance';

/**
 * A small but complete set of books, in JOD minor units (fils):
 *   Cash sale        Dr Cash 1160.000 / Cr Revenue 1000.000, Cr Tax payable 160.000
 *   Rent expense     Dr Rent 250.000  / Cr Cash 250.000
 *   Owner capital    Dr Cash 5000.000 / Cr Capital 5000.000
 */
const LINES: BalanceInput[] = [
  { accountId: '1010-cash', accountType: 'asset', side: 'debit', baseAmountMinor: 1_160_000n },
  { accountId: '4010-revenue', accountType: 'revenue', side: 'credit', baseAmountMinor: 1_000_000n },
  { accountId: '2110-tax-payable', accountType: 'liability', side: 'credit', baseAmountMinor: 160_000n },
  { accountId: '5010-rent', accountType: 'expense', side: 'debit', baseAmountMinor: 250_000n },
  { accountId: '1010-cash', accountType: 'asset', side: 'credit', baseAmountMinor: 250_000n },
  { accountId: '1010-cash', accountType: 'asset', side: 'debit', baseAmountMinor: 5_000_000n },
  { accountId: '3010-capital', accountType: 'equity', side: 'credit', baseAmountMinor: 5_000_000n },
];

describe('trial balance', () => {
  it('is empty and balanced with no postings', () => {
    const tb = computeTrialBalance([], 'JOD');
    expect(tb.rows).toEqual([]);
    expect(tb.balanced).toBe(true);
    expect(tb.debitTotal.toString()).toBe('0.000');
  });

  it('sums to zero across a complete set of books', () => {
    const tb = computeTrialBalance(LINES, 'JOD');
    expect(tb.debitTotal.toString()).toBe('6410.000');
    expect(tb.creditTotal.toString()).toBe('6410.000');
    expect(tb.difference.isZero()).toBe(true);
    expect(tb.balanced).toBe(true);
  });

  it('aggregates repeated postings to one account', () => {
    const cash = computeTrialBalance(LINES, 'JOD').rows.find((r) => r.accountId === '1010-cash');
    expect(cash?.debitTotal.toString()).toBe('6160.000');
    expect(cash?.creditTotal.toString()).toBe('250.000');
    expect(cash?.closingBalance.toString()).toBe('5910.000');
  });

  it('signs each closing balance in the direction of the account normal balance', () => {
    const rows = new Map(computeTrialBalance(LINES, 'JOD').rows.map((r) => [r.accountId, r]));
    // Revenue is a credit-normal account: a net credit is positive, not negative.
    expect(rows.get('4010-revenue')?.closingBalance.toString()).toBe('1000.000');
    expect(rows.get('2110-tax-payable')?.closingBalance.toString()).toBe('160.000');
    expect(rows.get('5010-rent')?.closingBalance.toString()).toBe('250.000');
  });

  it('detects an imbalance rather than hiding it', () => {
    const tb = computeTrialBalance(
      [
        { accountId: 'a', accountType: 'asset', side: 'debit', baseAmountMinor: 1000n },
        { accountId: 'b', accountType: 'revenue', side: 'credit', baseAmountMinor: 999n },
      ],
      'JOD',
    );
    expect(tb.balanced).toBe(false);
    expect(tb.difference.toString()).toBe('0.001');
  });

  it('refuses signed base amounts', () => {
    expect(() =>
      computeTrialBalance(
        [{ accountId: 'a', accountType: 'asset', side: 'debit', baseAmountMinor: -1n }],
        'JOD',
      ),
    ).toThrow(RangeError);
  });

  it('orders rows deterministically so a rebuild is comparable', () => {
    const forward = computeTrialBalance(LINES, 'JOD').rows.map((r) => r.accountId);
    const reversed = computeTrialBalance([...LINES].reverse(), 'JOD').rows.map((r) => r.accountId);
    expect(reversed).toEqual(forward);
  });
});

describe('accounting equation', () => {
  it('ties out: assets equal liabilities plus equity plus net income', () => {
    const eq = checkAccountingEquation(computeTrialBalance(LINES, 'JOD'));
    expect(eq.assets.toString()).toBe('5910.000');
    expect(eq.liabilities.toString()).toBe('160.000');
    expect(eq.equity.toString()).toBe('5000.000');
    expect(eq.revenue.toString()).toBe('1000.000');
    expect(eq.expenses.toString()).toBe('250.000');
    expect(eq.netIncome.toString()).toBe('750.000');
    expect(eq.difference.isZero()).toBe(true);
    expect(eq.balanced).toBe(true);
  });

  it('reports the break when the books do not tie out', () => {
    const eq = checkAccountingEquation(
      computeTrialBalance(
        [{ accountId: 'a', accountType: 'asset', side: 'debit', baseAmountMinor: 1000n }],
        'JOD',
      ),
    );
    expect(eq.balanced).toBe(false);
    expect(eq.difference.toString()).toBe('1.000');
  });
});

describe('statement partitioning', () => {
  it('separates carry-forward accounts from those closed into equity', () => {
    const { balanceSheet, incomeStatement } = partitionByStatement(computeTrialBalance(LINES, 'JOD'));
    expect(balanceSheet.map((r) => r.accountId).sort()).toEqual([
      '1010-cash',
      '2110-tax-payable',
      '3010-capital',
    ]);
    expect(incomeStatement.map((r) => r.accountId).sort()).toEqual(['4010-revenue', '5010-rent']);
  });
});
