import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  buildAccrualEntries,
  buildFxRevaluation,
  buildYearEndClosingEntry,
  CloseError,
  type ClosingAccountBalance,
  type MonetaryBalance,
} from '../src/close/close';
import { makeRate } from '../src/money/fx';

const CURRENCY = 'JOD';

const plBalances: ClosingAccountBalance[] = [
  { accountId: 'rev-1', code: '4010', type: 'revenue', debitMinor: '0', creditMinor: '1000000' },
  { accountId: 'exp-1', code: '5100', type: 'expense', debitMinor: '300000', creditMinor: '0' },
  { accountId: 'exp-2', code: '5220', type: 'expense', debitMinor: '150000', creditMinor: '0' },
];

describe('year-end closing entry', () => {
  const entry = buildYearEndClosingEntry(plBalances, {
    currency: CURRENCY,
    entryDate: '2026-12-31',
    retainedEarningsAccountId: 'eq-retained',
  });

  it('zeroes every profit and loss account on the opposite side', () => {
    const revenue = entry.lines.find((l) => l.accountId === 'rev-1');
    expect(revenue).toMatchObject({ side: 'debit', amountMinor: '1000000' });
    const expense = entry.lines.find((l) => l.accountId === 'exp-1');
    expect(expense).toMatchObject({ side: 'credit', amountMinor: '300000' });
  });

  it('moves the resulting profit to retained earnings', () => {
    const retained = entry.lines.find((l) => l.accountId === 'eq-retained');
    expect(retained).toMatchObject({ side: 'credit', amountMinor: '550000' });
    expect(entry.profit.amount).toBe('550.000');
  });

  it('balances', () => {
    const sum = (side: 'debit' | 'credit'): bigint =>
      entry.lines
        .filter((l) => l.side === side)
        .reduce((total, l) => total + BigInt(l.amountMinor), 0n);
    expect(sum('debit')).toBe(sum('credit'));
  });

  it('debits retained earnings when the year made a loss', () => {
    const loss = buildYearEndClosingEntry(
      [
        { accountId: 'rev-1', code: '4010', type: 'revenue', debitMinor: '0', creditMinor: '100000' },
        { accountId: 'exp-1', code: '5100', type: 'expense', debitMinor: '250000', creditMinor: '0' },
      ],
      { currency: CURRENCY, entryDate: '2026-12-31', retainedEarningsAccountId: 'eq-retained' },
    );
    expect(loss.lines.find((l) => l.accountId === 'eq-retained')).toMatchObject({
      side: 'debit',
      amountMinor: '150000',
    });
  });

  it('refuses to close a year with nothing to close rather than posting an empty entry', () => {
    expect(() =>
      buildYearEndClosingEntry([], {
        currency: CURRENCY,
        entryDate: '2026-12-31',
        retainedEarningsAccountId: 'eq-retained',
      }),
    ).toThrow(CloseError);
  });

  it('refuses a balance sheet account: closing one would destroy the balance sheet', () => {
    expect(() =>
      buildYearEndClosingEntry(
        [{ accountId: 'a-1', code: '1120', type: 'asset', debitMinor: '1', creditMinor: '0' }],
        { currency: CURRENCY, entryDate: '2026-12-31', retainedEarningsAccountId: 'eq-retained' },
      ),
    ).toThrow(/balance sheet/i);
  });
});

describe('FX revaluation', () => {
  const balances: MonetaryBalance[] = [
    {
      accountId: 'ar-usd',
      code: '1130',
      currency: 'USD',
      foreignMinor: '100000', // USD 1,000.00
      baseMinor: '700000', // booked at 0.700
      normalBalance: 'debit',
    },
  ];

  it('books the difference between the booked base value and the closing rate', () => {
    const run = buildFxRevaluation(balances, {
      currency: CURRENCY,
      asOfDate: '2026-01-31',
      rates: [makeRate('USD', 'JOD', new Decimal('0.710'), '2026-01-31')],
      gainAccountId: 'fx-gain',
      lossAccountId: 'fx-loss',
      unrealisedOnly: true,
    });
    expect(run.lines).toHaveLength(2);
    // 1,000.00 USD at 0.710 = 710.000 JOD against 700.000 booked: a 10.000 gain.
    expect(run.lines.find((l) => l.accountId === 'ar-usd')).toMatchObject({
      side: 'debit',
      amountMinor: '10000',
    });
    expect(run.lines.find((l) => l.accountId === 'fx-gain')).toMatchObject({
      side: 'credit',
      amountMinor: '10000',
    });
    expect(run.netGain.amount).toBe('10.000');
  });

  it('books a loss to the loss account when the currency moved the other way', () => {
    const run = buildFxRevaluation(balances, {
      currency: CURRENCY,
      asOfDate: '2026-01-31',
      rates: [makeRate('USD', 'JOD', new Decimal('0.690'), '2026-01-31')],
      gainAccountId: 'fx-gain',
      lossAccountId: 'fx-loss',
      unrealisedOnly: true,
    });
    expect(run.lines.find((l) => l.accountId === 'fx-loss')).toMatchObject({
      side: 'debit',
      amountMinor: '10000',
    });
    expect(run.netGain.amount).toBe('-10.000');
  });

  it('produces no entry at all when nothing moved', () => {
    const run = buildFxRevaluation(balances, {
      currency: CURRENCY,
      asOfDate: '2026-01-31',
      rates: [makeRate('USD', 'JOD', new Decimal('0.700'), '2026-01-31')],
      gainAccountId: 'fx-gain',
      lossAccountId: 'fx-loss',
      unrealisedOnly: true,
    });
    expect(run.lines).toHaveLength(0);
    expect(run.isEmpty).toBe(true);
  });

  it('refuses to revalue a currency it has no closing rate for', () => {
    expect(() =>
      buildFxRevaluation(balances, {
        currency: CURRENCY,
        asOfDate: '2026-01-31',
        rates: [],
        gainAccountId: 'fx-gain',
        lossAccountId: 'fx-loss',
        unrealisedOnly: true,
      }),
    ).toThrow(CloseError);
  });
});

describe('accruals and prepayments', () => {
  it('posts the accrual and its reversal on the first day of the next period', () => {
    const { accrual, reversal } = buildAccrualEntries({
      currency: CURRENCY,
      kind: 'accrual',
      amountMinor: '250000',
      expenseAccountId: 'exp-1',
      balanceAccountId: 'accrual-liab',
      accrualDate: '2026-01-31',
      reversalDate: '2026-02-01',
      memo: 'January electricity, invoice not yet received',
    });

    expect(accrual.lines).toEqual([
      { accountId: 'exp-1', side: 'debit', amountMinor: '250000' },
      { accountId: 'accrual-liab', side: 'credit', amountMinor: '250000' },
    ]);
    // The reversal is the mirror image, so the bill lands clean next month.
    expect(reversal.lines).toEqual([
      { accountId: 'exp-1', side: 'credit', amountMinor: '250000' },
      { accountId: 'accrual-liab', side: 'debit', amountMinor: '250000' },
    ]);
    expect(reversal.entryDate).toBe('2026-02-01');
  });

  it('reverses a prepayment the other way round', () => {
    const { accrual } = buildAccrualEntries({
      currency: CURRENCY,
      kind: 'prepayment',
      amountMinor: '120000',
      expenseAccountId: 'exp-rent',
      balanceAccountId: 'prepaid-asset',
      accrualDate: '2026-01-31',
      reversalDate: '2026-02-01',
      memo: 'February rent paid in January',
    });
    expect(accrual.lines).toEqual([
      { accountId: 'prepaid-asset', side: 'debit', amountMinor: '120000' },
      { accountId: 'exp-rent', side: 'credit', amountMinor: '120000' },
    ]);
  });

  it('refuses a reversal dated before the accrual', () => {
    expect(() =>
      buildAccrualEntries({
        currency: CURRENCY,
        kind: 'accrual',
        amountMinor: '1000',
        expenseAccountId: 'exp-1',
        balanceAccountId: 'accrual-liab',
        accrualDate: '2026-01-31',
        reversalDate: '2026-01-30',
        memo: 'backwards',
      }),
    ).toThrow(CloseError);
  });
});
