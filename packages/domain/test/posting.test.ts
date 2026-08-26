import { describe, expect, it } from 'vitest';
import {
  assertPostable,
  baseTotals,
  buildReversal,
  PostingError,
  totalsByCurrency,
  totalsFor,
  validateEntry,
  type ValidationContext,
} from '../src/ledger/posting';
import type { AccountRef, DraftEntry, DraftLine } from '../src/ledger/types';

const CASH: AccountRef = {
  id: 'acc-cash',
  code: '1010',
  type: 'asset',
  normalBalance: 'debit',
  currencyCode: null,
  isPostable: true,
  isActive: true,
};
const REVENUE: AccountRef = {
  id: 'acc-revenue',
  code: '4010',
  type: 'revenue',
  normalBalance: 'credit',
  currencyCode: null,
  isPostable: true,
  isActive: true,
};
const PARENT: AccountRef = { ...CASH, id: 'acc-parent', code: '1000', isPostable: false };
const ARCHIVED: AccountRef = { ...REVENUE, id: 'acc-old', code: '4999', isActive: false };
const USD_ONLY: AccountRef = { ...CASH, id: 'acc-usd', code: '1015', currencyCode: 'USD' };

const ACCOUNTS = new Map<string, AccountRef>(
  [CASH, REVENUE, PARENT, ARCHIVED, USD_ONLY].map((a) => [a.id, a]),
);
const OPEN: ValidationContext = { accounts: ACCOUNTS, periodStatus: 'open' };

function line(overrides: Partial<DraftLine> & Pick<DraftLine, 'lineNo' | 'accountId' | 'side'>): DraftLine {
  const amountMinor = overrides.amountMinor ?? 1160000n;
  return {
    currencyCode: 'JOD',
    fxRate: '1',
    baseAmountMinor: amountMinor,
    ...overrides,
    amountMinor,
  };
}

function entry(lines: DraftLine[], overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    entryDate: '2026-03-15',
    baseCurrencyCode: 'JOD',
    sourceModule: 'manual',
    memo: 'Cash sale',
    lines,
    ...overrides,
  };
}

const BALANCED = entry([
  line({ lineNo: 1, accountId: CASH.id, side: 'debit' }),
  line({ lineNo: 2, accountId: REVENUE.id, side: 'credit' }),
]);

describe('side totals', () => {
  it('sums debits and credits separately and reports the difference', () => {
    const totals = totalsFor(BALANCED.lines, 'JOD');
    expect(totals.debit.toString()).toBe('1160.000');
    expect(totals.credit.toString()).toBe('1160.000');
    expect(totals.balanced).toBe(true);
  });

  it('reports the out-of-balance amount for a lopsided entry', () => {
    const totals = totalsFor(
      [
        line({ lineNo: 1, accountId: CASH.id, side: 'debit', amountMinor: 1000n }),
        line({ lineNo: 2, accountId: REVENUE.id, side: 'credit', amountMinor: 400n }),
      ],
      'JOD',
    );
    expect(totals.balanced).toBe(false);
    expect(totals.difference.toString()).toBe('0.600');
  });

  it('groups totals per transaction currency', () => {
    const totals = totalsByCurrency([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit', amountMinor: 1000n }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit', amountMinor: 1000n }),
      line({ lineNo: 3, accountId: USD_ONLY.id, side: 'debit', amountMinor: 500n, currencyCode: 'USD' }),
    ]);
    expect(totals.get('JOD')?.balanced).toBe(true);
    expect(totals.get('USD')?.balanced).toBe(false);
  });

  it('sums base amounts across currencies', () => {
    const totals = baseTotals(BALANCED.lines, 'JOD');
    expect(totals.balanced).toBe(true);
    expect(totals.debit.toString()).toBe('1160.000');
  });
});

describe('entry validation', () => {
  it('accepts a balanced two-line entry into an open period', () => {
    expect(validateEntry(BALANCED, OPEN)).toEqual([]);
    expect(() => assertPostable(BALANCED, OPEN)).not.toThrow();
  });

  it('rejects an entry with no lines', () => {
    expect(validateEntry(entry([]), OPEN).map((v) => v.code)).toEqual(['NO_LINES']);
  });

  it('rejects a single-line entry', () => {
    const codes = validateEntry(entry([line({ lineNo: 1, accountId: CASH.id, side: 'debit' })]), OPEN).map(
      (v) => v.code,
    );
    expect(codes).toContain('SINGLE_LINE');
  });

  it('rejects an unbalanced entry and names the gap', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit', amountMinor: 1160000n }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit', amountMinor: 1000000n }),
    ]);
    const violations = validateEntry(bad, OPEN);
    expect(violations.map((v) => v.code)).toContain('UNBALANCED');
    expect(violations.find((v) => v.code === 'UNBALANCED')?.message).toContain('160.000');
  });

  it('rejects a negative amount rather than treating it as the other side', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit', amountMinor: -1160000n }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'debit', amountMinor: 1160000n }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('NEGATIVE_AMOUNT');
  });

  it('rejects a zero-amount line', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit', amountMinor: 0n }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit', amountMinor: 0n }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('ZERO_AMOUNT');
  });

  it('rejects duplicate line numbers', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit' }),
      line({ lineNo: 1, accountId: REVENUE.id, side: 'credit' }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('DUPLICATE_LINE_NO');
  });

  it('rejects a posting to a summary account', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: PARENT.id, side: 'debit' }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit' }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('NON_POSTABLE_ACCOUNT');
  });

  it('rejects a posting to an inactive account', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: CASH.id, side: 'debit' }),
      line({ lineNo: 2, accountId: ARCHIVED.id, side: 'credit' }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('INACTIVE_ACCOUNT');
  });

  it('rejects an unknown account', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: 'acc-missing', side: 'debit' }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit' }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('UNKNOWN_ACCOUNT');
  });

  it('rejects a line whose currency the account does not accept', () => {
    const bad = entry([
      line({ lineNo: 1, accountId: USD_ONLY.id, side: 'debit' }),
      line({ lineNo: 2, accountId: REVENUE.id, side: 'credit' }),
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('ACCOUNT_CURRENCY_MISMATCH');
  });

  it('rejects an entry whose base amounts do not balance even when the transaction currency does', () => {
    const bad = entry([
      {
        lineNo: 1,
        accountId: CASH.id,
        side: 'debit',
        amountMinor: 100000n,
        currencyCode: 'JOD',
        fxRate: '1',
        baseAmountMinor: 100000n,
      },
      {
        lineNo: 2,
        accountId: REVENUE.id,
        side: 'credit',
        amountMinor: 100000n,
        currencyCode: 'JOD',
        fxRate: '1',
        baseAmountMinor: 99000n,
      },
    ]);
    expect(validateEntry(bad, OPEN).map((v) => v.code)).toContain('UNBALANCED_BASE');
  });

  it.each(['soft_closed', 'closed'] as const)('refuses to post into a %s period', (status) => {
    const codes = validateEntry(BALANCED, { accounts: ACCOUNTS, periodStatus: status }).map((v) => v.code);
    expect(codes).toContain('PERIOD_CLOSED');
  });

  it('throws a PostingError carrying every violation', () => {
    const bad = entry([line({ lineNo: 1, accountId: PARENT.id, side: 'debit' })]);
    try {
      assertPostable(bad, OPEN);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PostingError);
      const codes = (err as PostingError).violations.map((v) => v.code);
      expect(codes).toEqual(expect.arrayContaining(['SINGLE_LINE', 'NON_POSTABLE_ACCOUNT', 'UNBALANCED']));
    }
  });

  it('accepts a balanced multi-currency entry', () => {
    const multi = entry([
      line({ lineNo: 1, accountId: USD_ONLY.id, side: 'debit', amountMinor: 10000n, currencyCode: 'USD', fxRate: '0.709', baseAmountMinor: 70900n }),
      line({ lineNo: 2, accountId: USD_ONLY.id, side: 'credit', amountMinor: 10000n, currencyCode: 'USD', fxRate: '0.709', baseAmountMinor: 70900n }),
    ]);
    expect(validateEntry(multi, OPEN)).toEqual([]);
  });
});

describe('reversal', () => {
  it('flips every side and keeps the amounts', () => {
    const reversal = buildReversal(BALANCED, { entryDate: '2026-04-01' });
    expect(reversal.entryDate).toBe('2026-04-01');
    expect(reversal.lines.map((l) => l.side)).toEqual(['credit', 'debit']);
    expect(reversal.lines.map((l) => l.amountMinor)).toEqual(BALANCED.lines.map((l) => l.amountMinor));
    expect(reversal.memo).toBe('Reversal of Cash sale');
  });

  it('produces an entry that is itself postable', () => {
    const reversal = buildReversal(BALANCED, { entryDate: '2026-04-01', memo: 'Cancelled sale' });
    expect(validateEntry(reversal, OPEN)).toEqual([]);
    expect(reversal.memo).toBe('Cancelled sale');
  });

  it('nets to zero against the original', () => {
    const reversal = buildReversal(BALANCED, { entryDate: '2026-04-01' });
    const combined = [...BALANCED.lines, ...reversal.lines];
    const totals = totalsFor(combined, 'JOD');
    expect(totals.debit.equals(totals.credit)).toBe(true);
  });
});
