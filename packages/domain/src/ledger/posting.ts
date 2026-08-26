import { Money } from '../money/money';
import type { AccountRef, DraftEntry, DraftLine, PeriodStatus } from './types';

export type PostingViolationCode =
  | 'NO_LINES'
  | 'SINGLE_LINE'
  | 'NEGATIVE_AMOUNT'
  | 'ZERO_AMOUNT'
  | 'UNBALANCED'
  | 'UNBALANCED_BASE'
  | 'DUPLICATE_LINE_NO'
  | 'UNKNOWN_ACCOUNT'
  | 'NON_POSTABLE_ACCOUNT'
  | 'INACTIVE_ACCOUNT'
  | 'ACCOUNT_CURRENCY_MISMATCH'
  | 'PERIOD_CLOSED';

export interface PostingViolation {
  readonly code: PostingViolationCode;
  readonly message: string;
  readonly lineNo?: number;
}

export class PostingError extends Error {
  readonly violations: readonly PostingViolation[];
  constructor(violations: readonly PostingViolation[]) {
    super(`Entry cannot be posted: ${violations.map((v) => v.code).join(', ')}`);
    this.name = 'PostingError';
    this.violations = violations;
  }
}

/** Debit and credit totals of a set of lines, in one currency. */
export interface SideTotals {
  readonly debit: Money;
  readonly credit: Money;
  readonly difference: Money;
  readonly balanced: boolean;
}

export function totalsFor(lines: readonly DraftLine[], currencyCode: string): SideTotals {
  let debit = Money.zero(currencyCode);
  let credit = Money.zero(currencyCode);
  for (const line of lines) {
    if (line.currencyCode !== currencyCode) continue;
    const amount = Money.fromMinor(line.amountMinor, currencyCode);
    if (line.side === 'debit') debit = debit.add(amount);
    else credit = credit.add(amount);
  }
  const difference = debit.subtract(credit);
  return { debit, credit, difference, balanced: difference.isZero() };
}

/** Totals per transaction currency. An entry must balance in each one independently. */
export function totalsByCurrency(lines: readonly DraftLine[]): Map<string, SideTotals> {
  const result = new Map<string, SideTotals>();
  for (const currency of new Set(lines.map((l) => l.currencyCode))) {
    result.set(currency, totalsFor(lines, currency));
  }
  return result;
}

/** Totals of the base-currency amounts, which must balance as well. */
export function baseTotals(lines: readonly DraftLine[], baseCurrency: string): SideTotals {
  let debit = Money.zero(baseCurrency);
  let credit = Money.zero(baseCurrency);
  for (const line of lines) {
    const amount = Money.fromMinor(line.baseAmountMinor, baseCurrency);
    if (line.side === 'debit') debit = debit.add(amount);
    else credit = credit.add(amount);
  }
  const difference = debit.subtract(credit);
  return { debit, credit, difference, balanced: difference.isZero() };
}

export interface ValidationContext {
  readonly accounts: ReadonlyMap<string, AccountRef>;
  readonly periodStatus: PeriodStatus;
}

/**
 * Every rule that must hold before an entry may be posted.
 *
 * This mirrors the database triggers rather than replacing them: it exists so
 * the UI can refuse to submit and the API can return a useful error, while the
 * database stays the authority that no writer can bypass.
 */
export function validateEntry(entry: DraftEntry, ctx: ValidationContext): readonly PostingViolation[] {
  const violations: PostingViolation[] = [];

  if (entry.lines.length === 0) {
    return [{ code: 'NO_LINES', message: 'An entry must have at least two lines' }];
  }
  if (entry.lines.length === 1) {
    violations.push({ code: 'SINGLE_LINE', message: 'An entry must have at least two lines' });
  }

  const seenLineNos = new Set<number>();
  for (const line of entry.lines) {
    if (seenLineNos.has(line.lineNo)) {
      violations.push({
        code: 'DUPLICATE_LINE_NO',
        message: `Duplicate line_no ${line.lineNo}`,
        lineNo: line.lineNo,
      });
    }
    seenLineNos.add(line.lineNo);

    if (line.amountMinor < 0n) {
      violations.push({
        code: 'NEGATIVE_AMOUNT',
        message: 'Line amounts are non-negative; use the opposite side instead of a negative amount',
        lineNo: line.lineNo,
      });
    } else if (line.amountMinor === 0n) {
      violations.push({
        code: 'ZERO_AMOUNT',
        message: 'Line amount must be greater than zero',
        lineNo: line.lineNo,
      });
    }

    const account = ctx.accounts.get(line.accountId);
    if (!account) {
      violations.push({
        code: 'UNKNOWN_ACCOUNT',
        message: `Unknown account ${line.accountId}`,
        lineNo: line.lineNo,
      });
      continue;
    }
    if (!account.isPostable) {
      violations.push({
        code: 'NON_POSTABLE_ACCOUNT',
        message: `Account ${account.code} is a summary account and cannot be posted to`,
        lineNo: line.lineNo,
      });
    }
    if (!account.isActive) {
      violations.push({
        code: 'INACTIVE_ACCOUNT',
        message: `Account ${account.code} is inactive`,
        lineNo: line.lineNo,
      });
    }
    if (account.currencyCode !== null && account.currencyCode !== line.currencyCode) {
      violations.push({
        code: 'ACCOUNT_CURRENCY_MISMATCH',
        message: `Account ${account.code} only accepts ${account.currencyCode}, line is ${line.currencyCode}`,
        lineNo: line.lineNo,
      });
    }
  }

  for (const [currency, totals] of totalsByCurrency(entry.lines)) {
    if (!totals.balanced) {
      violations.push({
        code: 'UNBALANCED',
        message:
          `Debits and credits must be equal in ${currency}: debit ${totals.debit.toString()}, ` +
          `credit ${totals.credit.toString()}, out of balance by ${totals.difference.toString()}`,
      });
    }
  }

  const base = baseTotals(entry.lines, entry.baseCurrencyCode);
  if (!base.balanced) {
    violations.push({
      code: 'UNBALANCED_BASE',
      message: `Base-currency amounts must balance too: out of balance by ${base.difference.toString()} ${entry.baseCurrencyCode}`,
    });
  }

  if (ctx.periodStatus !== 'open') {
    violations.push({
      code: 'PERIOD_CLOSED',
      message: `The fiscal period for ${entry.entryDate} is ${ctx.periodStatus} and will not accept postings`,
    });
  }

  return violations;
}

export function assertPostable(entry: DraftEntry, ctx: ValidationContext): void {
  const violations = validateEntry(entry, ctx);
  if (violations.length > 0) throw new PostingError(violations);
}

/**
 * The mirror image of an entry: every debit becomes a credit and vice versa at
 * the same amounts. Corrections are made this way, never by editing a posting.
 */
export function buildReversal(
  entry: DraftEntry,
  options: { entryDate: string; memo?: string | undefined },
): DraftEntry {
  return {
    ...entry,
    entryDate: options.entryDate,
    memo: options.memo ?? `Reversal of ${entry.memo ?? 'entry'}`,
    lines: entry.lines.map((line) => ({
      ...line,
      side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
    })),
  };
}
