/**
 * The demo backend.
 *
 * GitHub Pages serves static files, so there is no PostgreSQL, no Redis and no
 * NestJS behind this build. What there is instead is the real `@acct/domain`
 * package running in the browser over a dataset captured from a real API.
 *
 * The split is deliberate and worth stating plainly, because a demo that lies
 * about what it computes is worse than no demo:
 *
 *   - **Computed live, by the same code the server runs.** The trial balance,
 *     the general ledger, the income statement, the balance sheet, the cash
 *     flow statement and entry balancing all run through `@acct/domain` here.
 *     Post an entry in the demo and every one of those reports moves, because
 *     they are derived from the entry list rather than read from a snapshot.
 *
 *   - **Replayed from the captured dataset.** Inventory costing, depreciation
 *     schedules, budget variance and period-close state are served as the API
 *     returned them. Those computations live in the database transaction on the
 *     server — cost layers, the once-per-period depreciation constraint — and
 *     reproducing them here would mean writing a second implementation, which
 *     is precisely the kind of thing that drifts and starts telling comfortable
 *     lies. They are shown as captured, and the demo says so.
 *
 * What is *not* enforced here is everything the database enforces: no triggers,
 * no constraints, no row-level security, no immutability of posted entries.
 * Balance is checked, because that check lives in the domain layer; the rest of
 * the ten invariants are the server's, and the demo cannot stand in for them.
 */

import {
  Money,
  buildBalanceSheet,
  buildCashFlowStatement,
  buildEquityStatement,
  buildIncomeStatement,
  computeTrialBalance,
  type AccountBalanceRow,
  type AccountType,
  type Side,
} from '@acct/domain';
import fixture from './fixture.json';

/* ------------------------------------------------------------------ types -- */

interface MoneyDto {
  amount: string;
  minor: string;
  currency: string;
}

interface DemoAccount {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: AccountType;
  subtype: string | null;
  normalBalance: Side;
  parentAccountId: string | null;
  isPostable: boolean;
  isActive: boolean;
}

interface DemoLine {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  side: Side;
  amount: MoneyDto;
  baseAmount: MoneyDto;
  description: string | null;
}

interface DemoEntry {
  id: string;
  entryNo: number;
  entryRef: string | null;
  entryDate: string;
  periodId: string | null;
  status: 'draft' | 'posted' | 'reversed' | 'void';
  sourceModule: string;
  memo: string | null;
  baseCurrency: string;
  postedAt: string | null;
  reversesEntryId: string | null;
  reversedByEntryId: string | null;
  totalDebit: MoneyDto;
  totalCredit: MoneyDto;
  lines: DemoLine[];
}

type Fixture = typeof fixture;

/* ------------------------------------------------------------------ state -- */

const CURRENCY: string = fixture.tenants[0]?.baseCurrency ?? 'JOD';

/**
 * Ids reserved for entries posted during the demo.
 *
 * A static export can only serve pages it built, so `/journal/<id>` exists only
 * for ids known at build time. Drawing new entries from a fixed pool keeps the
 * detail page reachable for anything posted in the demo — and caps the session
 * at twenty new entries, which is more than a demo needs.
 */
export const DEMO_ENTRY_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_, i) => `demo-entry-${String(i + 1).padStart(2, '0')}`,
);

interface State {
  entries: DemoEntry[];
  periods: Fixture['periods'];
  closeStatus: Record<string, unknown>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const freshState = (): State => ({
  entries: clone(fixture.entries as unknown as DemoEntry[]),
  periods: clone(fixture.periods),
  closeStatus: clone(fixture.closeStatus),
});

let state: State = freshState();

/** Throws the session's edits away and returns to the captured dataset. */
export const resetDemo = (): void => {
  state = freshState();
};

const accounts = fixture.accounts as unknown as DemoAccount[];
const accountById = new Map(accounts.map((a) => [a.id, a]));

/* ------------------------------------------------------------- primitives -- */

class DemoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const money = (minor: bigint): MoneyDto => Money.fromMinor(minor.toString(), CURRENCY).toJSON();

/** Posted and reversed lines both count: a reversal is a posting of its own. */
const ledgerEntries = (): DemoEntry[] =>
  state.entries.filter((e) => e.status === 'posted' || e.status === 'reversed');

const inRange = (date: string, from?: string, to?: string): boolean =>
  (from === undefined || date >= from) && (to === undefined || date <= to);

/**
 * Reproduces the server's balance query: every account that moved before or
 * inside the window, split at `fromDate`.
 */
const balanceRows = (fromDate: string, toDate: string): AccountBalanceRow[] => {
  const totals = new Map(
    accounts.map((a) => [
      a.id,
      { openingDebit: 0n, openingCredit: 0n, periodDebit: 0n, periodCredit: 0n },
    ]),
  );

  for (const entry of ledgerEntries()) {
    if (entry.entryDate > toDate) continue;
    for (const line of entry.lines) {
      const bucket = totals.get(line.accountId);
      if (!bucket) continue;
      const amount = BigInt(line.baseAmount.minor);
      const opening = entry.entryDate < fromDate;
      if (line.side === 'debit') {
        if (opening) bucket.openingDebit += amount;
        else bucket.periodDebit += amount;
      } else if (opening) bucket.openingCredit += amount;
      else bucket.periodCredit += amount;
    }
  }

  return accounts
    .map((account) => {
      const t = totals.get(account.id);
      return {
        accountId: account.id,
        code: account.code,
        name: account.name,
        nameAr: account.nameAr,
        type: account.type,
        subtype: account.subtype,
        openingDebitMinor: (t?.openingDebit ?? 0n).toString(),
        openingCreditMinor: (t?.openingCredit ?? 0n).toString(),
        periodDebitMinor: (t?.periodDebit ?? 0n).toString(),
        periodCreditMinor: (t?.periodCredit ?? 0n).toString(),
      };
    })
    .filter(
      (r) =>
        r.openingDebitMinor !== '0' ||
        r.openingCreditMinor !== '0' ||
        r.periodDebitMinor !== '0' ||
        r.periodCreditMinor !== '0',
    )
    .sort((a, b) => a.code.localeCompare(b.code));
};

/** The fiscal year containing a date, so a balance sheet splits at year start. */
const fiscalYearStart = (asOfDate: string): string => {
  const containing = state.periods.filter((p) => p.startDate <= asOfDate);
  const first = state.periods[0];
  return containing.length > 0 ? (first?.startDate ?? `${asOfDate.slice(0, 4)}-01-01`) : asOfDate;
};

/* ---------------------------------------------------------------- reports -- */

const trialBalance = (fromDate?: string, toDate?: string) => {
  const lines = ledgerEntries()
    .filter((e) => inRange(e.entryDate, fromDate, toDate))
    .flatMap((entry) =>
      entry.lines.map((line) => {
        const account = accountById.get(line.accountId);
        return {
          accountId: line.accountId,
          accountType: account?.type ?? ('asset' as AccountType),
          side: line.side,
          baseAmountMinor: BigInt(line.baseAmount.minor),
        };
      }),
    );

  const tb = computeTrialBalance(lines, CURRENCY);

  return {
    currency: tb.currency,
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    rows: tb.rows
      .map((row) => {
        const account = accountById.get(row.accountId);
        return {
          accountId: row.accountId,
          accountCode: account?.code ?? '',
          accountName: account?.name ?? '',
          accountType: row.accountType,
          debitTotal: row.debitTotal.toJSON(),
          creditTotal: row.creditTotal.toJSON(),
          closingBalance: row.closingBalance.toJSON(),
        };
      })
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode)),
    totalDebit: tb.debitTotal.toJSON(),
    totalCredit: tb.creditTotal.toJSON(),
    difference: tb.difference.toJSON(),
    balanced: tb.balanced,
  };
};

const generalLedger = (accountId: string, fromDate?: string, toDate?: string) => {
  const account = accountById.get(accountId);
  if (!account) throw new DemoError(404, 'ACCOUNT_NOT_FOUND', 'No such account');

  const signed = (debit: Money, credit: Money): Money =>
    account.normalBalance === 'debit' ? debit.subtract(credit) : credit.subtract(debit);

  let openingDebit = 0n;
  let openingCredit = 0n;
  const detail: {
    entry: DemoEntry;
    line: DemoLine;
  }[] = [];

  for (const entry of ledgerEntries()) {
    for (const line of entry.lines) {
      if (line.accountId !== accountId) continue;
      if (fromDate !== undefined && entry.entryDate < fromDate) {
        if (line.side === 'debit') openingDebit += BigInt(line.baseAmount.minor);
        else openingCredit += BigInt(line.baseAmount.minor);
        continue;
      }
      if (toDate !== undefined && entry.entryDate > toDate) continue;
      detail.push({ entry, line });
    }
  }

  detail.sort(
    (a, b) =>
      a.entry.entryDate.localeCompare(b.entry.entryDate) || a.entry.entryNo - b.entry.entryNo,
  );

  const zero = Money.zero(CURRENCY);
  const openingBalance = signed(money2(openingDebit), money2(openingCredit));
  let running = openingBalance;
  let totalDebit = zero;
  let totalCredit = zero;

  const rows = detail.map(({ entry, line }) => {
    const amount = Money.fromMinor(line.baseAmount.minor, CURRENCY);
    const debit = line.side === 'debit' ? amount : zero;
    const credit = line.side === 'credit' ? amount : zero;
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
    running = running.add(signed(debit, credit));
    return {
      entryId: entry.id,
      entryRef: entry.entryRef,
      entryDate: entry.entryDate,
      memo: entry.memo,
      lineDescription: line.description,
      side: line.side,
      debit: debit.toJSON(),
      credit: credit.toJSON(),
      runningBalance: running.toJSON(),
      sourceModule: entry.sourceModule,
      status: entry.status,
    };
  });

  return {
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.type,
    currency: CURRENCY,
    openingBalance: openingBalance.toJSON(),
    closingBalance: running.toJSON(),
    totalDebit: totalDebit.toJSON(),
    totalCredit: totalCredit.toJSON(),
    rows,
  };
};

const money2 = (minor: bigint): Money => Money.fromMinor(minor.toString(), CURRENCY);

/* --------------------------------------------------------------- mutation -- */

const nextEntryNo = (): number =>
  state.entries.reduce((max, e) => Math.max(max, e.entryNo), 0) + 1;

interface CreateEntryBody {
  entryDate: string;
  memo?: string;
  status?: 'draft' | 'posted';
  sourceModule?: string;
  lines: { accountId: string; side: Side; amountMinor: string; description?: string }[];
}

const createEntry = (body: CreateEntryBody): DemoEntry => {
  if (body.lines.length < 2) {
    throw new DemoError(400, 'VALIDATION_FAILED', 'An entry needs at least two lines');
  }

  let debit = 0n;
  let credit = 0n;
  for (const line of body.lines) {
    const amount = BigInt(line.amountMinor);
    if (amount < 0n) {
      throw new DemoError(400, 'NEGATIVE_AMOUNT', 'Amounts are unsigned; the side carries direction');
    }
    if (line.side === 'debit') debit += amount;
    else credit += amount;
  }

  const status = body.status ?? 'draft';
  // The balance rule is the domain's, and it applies here exactly as it does on
  // the server: an unbalanced entry may be saved as a draft, never posted.
  if (status === 'posted' && debit !== credit) {
    throw new DemoError(
      422,
      'ENTRY_NOT_BALANCED',
      `Debits ${money(debit).amount} do not equal credits ${money(credit).amount}`,
    );
  }

  const used = new Set(state.entries.map((e) => e.id));
  const id = DEMO_ENTRY_IDS.find((candidate) => !used.has(candidate));
  if (!id) {
    throw new DemoError(
      507,
      'DEMO_LIMIT',
      'The demo holds twenty new entries per session. Reload to start again.',
    );
  }

  const entryNo = nextEntryNo();
  const period = state.periods.find(
    (p) => p.startDate <= body.entryDate && body.entryDate <= p.endDate,
  );

  const entry: DemoEntry = {
    id,
    entryNo,
    entryRef: `JE-${body.entryDate.slice(0, 4)}-${String(entryNo).padStart(5, '0')}`,
    entryDate: body.entryDate,
    periodId: period?.id ?? null,
    status,
    sourceModule: body.sourceModule ?? 'manual',
    memo: body.memo ?? null,
    baseCurrency: CURRENCY,
    postedAt: status === 'posted' ? new Date().toISOString() : null,
    reversesEntryId: null,
    reversedByEntryId: null,
    totalDebit: money(debit),
    totalCredit: money(credit),
    lines: body.lines.map((line, index) => {
      const account = accountById.get(line.accountId);
      const amount = money(BigInt(line.amountMinor));
      return {
        id: `${id}-line-${index + 1}`,
        lineNo: index + 1,
        accountId: line.accountId,
        accountCode: account?.code ?? '',
        accountName: account?.name ?? '',
        side: line.side,
        amount,
        baseAmount: amount,
        description: line.description ?? null,
      };
    }),
  };

  state.entries.unshift(entry);
  return entry;
};

const postEntry = (id: string): DemoEntry => {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) throw new DemoError(404, 'ENTRY_NOT_FOUND', 'No such entry');
  if (entry.status !== 'draft') {
    throw new DemoError(409, 'ENTRY_NOT_DRAFT', 'Only a draft can be posted');
  }
  if (entry.totalDebit.minor !== entry.totalCredit.minor) {
    throw new DemoError(422, 'ENTRY_NOT_BALANCED', 'Debits do not equal credits');
  }
  entry.status = 'posted';
  entry.postedAt = new Date().toISOString();
  return entry;
};

/* ---------------------------------------------------------------- routing -- */

/** The list endpoint returns entries without their lines, as the API does. */
const summary = (entry: DemoEntry): Omit<DemoEntry, 'lines'> => {
  const rest: Partial<DemoEntry> = { ...entry };
  delete rest.lines;
  return rest as Omit<DemoEntry, 'lines'>;
};

const notImplemented = (what: string): never => {
  throw new DemoError(
    501,
    'DEMO_READ_ONLY',
    `${what} runs inside a database transaction on the server, so the static demo shows the captured result rather than recomputing it.`,
  );
};

/**
 * Routes one request. Paths arrive exactly as the API client would send them,
 * so the screens are unmodified: they cannot tell which backend answered.
 */
export const handle = (method: string, rawPath: string, body?: unknown): unknown => {
  const [path, search = ''] = rawPath.split('?');
  const q = new URLSearchParams(search);
  const from = q.get('fromDate') ?? undefined;
  const to = q.get('toDate') ?? undefined;
  const segments = (path ?? '').split('/').filter(Boolean);

  const at = (i: number): string => segments[i] ?? '';

  if (method === 'GET') {
    if (path === '/auth/me') return fixture.user;
    if (path === '/auth/tenants') return fixture.tenants;
    if (path === '/accounts') return fixture.accounts;
    if (path === '/fiscal-periods') return state.periods;

    if (path === '/journal-entries') {
      const limit = Number(q.get('limit') ?? '50');
      return { items: state.entries.slice(0, limit).map(summary), nextCursor: null };
    }
    if (at(0) === 'journal-entries' && segments.length === 2) {
      const entry = state.entries.find((e) => e.id === at(1));
      if (!entry) throw new DemoError(404, 'ENTRY_NOT_FOUND', 'No such entry');
      return entry;
    }

    if (path === '/reports/trial-balance') return trialBalance(from, to);
    if (at(0) === 'reports' && at(1) === 'general-ledger') return generalLedger(at(2), from, to);

    if (path === '/reports/income-statement') {
      const period = { currency: CURRENCY, fromDate: from ?? '', toDate: to ?? '' };
      const statement = buildIncomeStatement(balanceRows(period.fromDate, period.toDate), period);
      if (q.get('comparative') !== 'true') return statement;
      // Same window, one year earlier — the comparison the screen offers.
      const shift = (d: string): string => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
      const priorFrom = shift(period.fromDate);
      const priorTo = shift(period.toDate);
      return {
        ...statement,
        comparative: buildIncomeStatement(balanceRows(priorFrom, priorTo), {
          currency: CURRENCY,
          fromDate: priorFrom,
          toDate: priorTo,
        }),
      };
    }
    if (path === '/reports/balance-sheet') {
      const asOfDate = q.get('asOfDate') ?? '';
      return buildBalanceSheet(balanceRows(fiscalYearStart(asOfDate), asOfDate), {
        currency: CURRENCY,
        asOfDate,
      });
    }
    if (path === '/reports/cash-flow') {
      return buildCashFlowStatement(balanceRows(from ?? '', to ?? ''), {
        currency: CURRENCY,
        fromDate: from ?? '',
        toDate: to ?? '',
      });
    }
    if (path === '/reports/equity') {
      return buildEquityStatement(balanceRows(from ?? '', to ?? ''), {
        currency: CURRENCY,
        fromDate: from ?? '',
        toDate: to ?? '',
      });
    }

    if (at(0) === 'fiscal-periods' && at(2) === 'close-status') {
      const status = state.closeStatus[at(1)];
      if (!status) throw new DemoError(404, 'PERIOD_NOT_FOUND', 'No such period');
      return status;
    }

    if (path === '/inventory/valuation') return fixture.inventory.valuation;
    if (path === '/inventory/items') return fixture.inventory.items;
    if (path === '/inventory/warehouses') return fixture.inventory.warehouses;
    if (at(0) === 'inventory' && at(1) === 'items' && at(3) === 'movements') {
      return (fixture.inventory.movements as Record<string, unknown>)[at(2)] ?? [];
    }

    if (path === '/assets/register') return fixture.assets.register;
    if (at(0) === 'assets' && at(2) === 'schedule') {
      return (fixture.assets.schedules as Record<string, unknown>)[at(1)] ?? { rows: [] };
    }

    if (path === '/budgets') return fixture.budgets.list;
    if (at(0) === 'budgets' && at(2) === 'variance') {
      const report = (fixture.budgets.variance as Record<string, unknown>)[at(1)];
      if (!report) throw new DemoError(404, 'BUDGET_NOT_FOUND', 'No such budget');
      return report;
    }
  }

  if (method === 'POST') {
    if (path === '/auth/login') return { expiresIn: 900, user: fixture.user };
    if (path === '/auth/logout') return undefined;
    if (path === '/journal-entries') return createEntry(body as CreateEntryBody);
    if (at(0) === 'journal-entries' && at(2) === 'post') return postEntry(at(1));

    if (at(0) === 'assets' && at(1) === 'depreciation-runs') return notImplemented('A depreciation run');
    if (at(0) === 'close') return notImplemented('The close routine');
    if (at(0) === 'fiscal-periods' && at(2) === 'status') return notImplemented('Changing period status');
  }

  if (method === 'PUT' && at(0) === 'fiscal-periods') return notImplemented('Updating the checklist');

  throw new DemoError(
    501,
    'DEMO_UNSUPPORTED',
    `${method} ${path} is part of the API but not of the static demo.`,
  );
};

export { DemoError };
