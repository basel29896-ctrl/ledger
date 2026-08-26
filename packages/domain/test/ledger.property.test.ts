import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money/money';
import { buildReversal, totalsFor, validateEntry, type ValidationContext } from '../src/ledger/posting';
import { checkAccountingEquation, computeTrialBalance, type BalanceInput } from '../src/ledger/trial-balance';
import type { AccountRef, AccountType, DraftLine } from '../src/ledger/types';

const CURRENCIES = ['JOD', 'USD', 'JPY'] as const;
const TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

/** A posting: one account, one side, one non-negative amount. */
const arbAmount = fc.bigInt({ min: 1n, max: 10_000_000_000n });

/**
 * Any balanced set of postings: for each random pairing we emit a debit and a
 * matching credit, so by construction the books must always tie out. The test
 * is that our aggregation never loses that property.
 */
const arbBalancedLines = fc.array(
  fc.record({
    debitAccount: fc.integer({ min: 0, max: 19 }),
    creditAccount: fc.integer({ min: 0, max: 19 }),
    amount: arbAmount,
  }),
  { minLength: 0, maxLength: 60 },
);

function accountId(n: number): string {
  return `acc-${String(n).padStart(3, '0')}`;
}

function accountType(n: number): AccountType {
  return TYPES[n % TYPES.length] as AccountType;
}

function toBalanceInputs(
  pairs: readonly { debitAccount: number; creditAccount: number; amount: bigint }[],
): BalanceInput[] {
  return pairs.flatMap((p) => [
    {
      accountId: accountId(p.debitAccount),
      accountType: accountType(p.debitAccount),
      side: 'debit' as const,
      baseAmountMinor: p.amount,
    },
    {
      accountId: accountId(p.creditAccount),
      accountType: accountType(p.creditAccount),
      side: 'credit' as const,
      baseAmountMinor: p.amount,
    },
  ]);
}

describe('property: the trial balance always sums to zero', () => {
  it('holds for any set of balanced postings', () => {
    fc.assert(
      fc.property(arbBalancedLines, (pairs) => {
        const tb = computeTrialBalance(toBalanceInputs(pairs), 'JOD');
        expect(tb.difference.isZero()).toBe(true);
        expect(tb.balanced).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('per-account debits minus credits reconstruct the closing balance', () => {
    fc.assert(
      fc.property(arbBalancedLines, (pairs) => {
        const inputs = toBalanceInputs(pairs);
        for (const row of computeTrialBalance(inputs, 'JOD').rows) {
          const expected =
            row.accountType === 'asset' || row.accountType === 'expense'
              ? row.debitTotal.subtract(row.creditTotal)
              : row.creditTotal.subtract(row.debitTotal);
          expect(row.closingBalance.equals(expected)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: the accounting equation holds', () => {
  it('assets equal liabilities plus equity plus net income for any balanced books', () => {
    fc.assert(
      fc.property(arbBalancedLines, (pairs) => {
        const eq = checkAccountingEquation(computeTrialBalance(toBalanceInputs(pairs), 'JOD'));
        expect(eq.difference.isZero()).toBe(true);
        // Net income is exactly what flows to retained earnings at year end.
        expect(eq.netIncome.equals(eq.revenue.subtract(eq.expenses))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property: reversal always annihilates the original', () => {
  const account = (id: string): AccountRef => ({
    id,
    code: id,
    type: 'asset',
    normalBalance: 'debit',
    currencyCode: null,
    isPostable: true,
    isActive: true,
  });
  const ctx: ValidationContext = {
    accounts: new Map([0, 1, 2, 3].map((n) => [accountId(n), account(accountId(n))])),
    periodStatus: 'open',
  };

  it('leaves a zero net position and stays postable', () => {
    fc.assert(
      fc.property(arbAmount, fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }), (amount, a, b) => {
        const lines: DraftLine[] = [
          { lineNo: 1, accountId: accountId(a), side: 'debit', amountMinor: amount, currencyCode: 'JOD', fxRate: '1', baseAmountMinor: amount },
          { lineNo: 2, accountId: accountId(b), side: 'credit', amountMinor: amount, currencyCode: 'JOD', fxRate: '1', baseAmountMinor: amount },
        ];
        const original = {
          entryDate: '2026-03-15',
          baseCurrencyCode: 'JOD',
          sourceModule: 'manual' as const,
          lines,
        };
        const reversal = buildReversal(original, { entryDate: '2026-04-01' });
        expect(validateEntry(reversal, ctx)).toEqual([]);
        const combined = totalsFor([...original.lines, ...reversal.lines], 'JOD');
        expect(combined.debit.equals(combined.credit)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('property: money arithmetic is exact', () => {
  it('add then subtract is the identity in every currency', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }),
        (currency, a, b) => {
          const money = Money.fromMinor(a, currency);
          expect(money.add(Money.fromMinor(b, currency)).subtract(Money.fromMinor(b, currency)).equals(money)).toBe(
            true,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('a decimal string round-trips through minor units unchanged', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CURRENCIES), fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), (currency, minor) => {
        const money = Money.fromMinor(minor, currency);
        expect(Money.fromDecimal(money.toString(), currency).equals(money)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('allocation never creates or destroys a single minor unit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CURRENCIES),
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }),
        fc.integer({ min: 1, max: 17 }),
        (currency, minor, parts) => {
          const money = Money.fromMinor(minor, currency);
          const shares = money.allocateEvenly(parts);
          expect(shares).toHaveLength(parts);
          expect(Money.sum(shares, currency).equals(money)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
