import { HttpStatus, Injectable } from '@nestjs/common';
import {
  buildBalanceSheet,
  buildCashFlowStatement,
  buildEquityStatement,
  buildIncomeStatement,
  StatementError,
  type AccountBalanceRow,
  type BalanceSheet,
  type CashFlowStatement,
  type EquityStatement,
  type IncomeStatement,
  type StatementSection,
} from '@acct/domain';
import type { BalanceSheetQuery, StatementPeriodQuery } from '@acct/shared';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

interface BalanceQueryRow {
  account_id: string;
  code: string;
  name: string;
  name_ar: string | null;
  type: AccountBalanceRow['type'];
  subtype: string | null;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
}

/**
 * Financial statements, all four built from the same balance query so they
 * cannot disagree with each other or with the trial balance. Nothing is read
 * from a cache: the numbers come from posted journal lines every time.
 */
@Injectable()
export class StatementsService {
  constructor(private readonly db: Database) {}

  private async baseCurrency(tenantId: string): Promise<string> {
    const [row] = await this.db.read(
      tenantId,
      (tx) => tx<{ base_currency: string }[]>`SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`,
    );
    if (!row) throw new LedgerError('TENANT_NOT_FOUND', `No tenant ${tenantId}`, HttpStatus.NOT_FOUND);
    return row.base_currency;
  }

  /**
   * Every account that moved either before or inside the window, with its
   * balance split at `fromDate`. Reversed entries stay in — a reversal is a
   * posting of its own and both sides must show.
   */
  private async balanceRows(
    tenantId: string,
    fromDate: string,
    toDate: string,
  ): Promise<AccountBalanceRow[]> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<BalanceQueryRow[]>`
        SELECT a.id AS account_id, a.code, a.name, a.name_ar, a.type, a.subtype,
               COALESCE(SUM(l.base_amount_minor)
                 FILTER (WHERE l.side = 'debit'  AND e.entry_date < ${fromDate}), 0)::text AS opening_debit,
               COALESCE(SUM(l.base_amount_minor)
                 FILTER (WHERE l.side = 'credit' AND e.entry_date < ${fromDate}), 0)::text AS opening_credit,
               COALESCE(SUM(l.base_amount_minor)
                 FILTER (WHERE l.side = 'debit'  AND e.entry_date BETWEEN ${fromDate} AND ${toDate}), 0)::text
                 AS period_debit,
               COALESCE(SUM(l.base_amount_minor)
                 FILTER (WHERE l.side = 'credit' AND e.entry_date BETWEEN ${fromDate} AND ${toDate}), 0)::text
                 AS period_credit
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
         WHERE e.status IN ('posted', 'reversed')
           AND e.entry_date <= ${toDate}
         GROUP BY a.id, a.code, a.name, a.name_ar, a.type, a.subtype
         ORDER BY a.code`,
    );

    return rows.map((r) => ({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      nameAr: r.name_ar,
      type: r.type,
      subtype: r.subtype,
      openingDebitMinor: r.opening_debit,
      openingCreditMinor: r.opening_credit,
      periodDebitMinor: r.period_debit,
      periodCreditMinor: r.period_credit,
    }));
  }

  /** The fiscal year containing a date, so a balance sheet splits at year start. */
  private async fiscalYearStart(tenantId: string, asOfDate: string): Promise<string> {
    const [year] = await this.db.read(tenantId, (tx) =>
      tx<{ start_date: string }[]>`
        SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date
          FROM fiscal_years
         WHERE ${asOfDate}::date BETWEEN start_date AND end_date
         LIMIT 1`,
    );
    if (!year) {
      throw new LedgerError(
        'NO_FISCAL_YEAR',
        `No fiscal year covers ${asOfDate}; a balance sheet needs one to separate ` +
          `this year's result from prior years`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return year.start_date;
  }

  private rethrow<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof StatementError) {
        // A statement that will not balance is reported as a fault, never rendered.
        throw new LedgerError(error.code, error.message, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw error;
    }
  }

  async incomeStatement(tenantId: string, query: StatementPeriodQuery): Promise<IncomeStatement> {
    const currency = await this.baseCurrency(tenantId);
    const rows = await this.balanceRows(tenantId, query.fromDate, query.toDate);

    let comparative: IncomeStatement | undefined;
    if (query.compareFromDate && query.compareToDate) {
      const priorRows = await this.balanceRows(tenantId, query.compareFromDate, query.compareToDate);
      comparative = this.rethrow(() =>
        buildIncomeStatement(priorRows, {
          currency,
          fromDate: query.compareFromDate!,
          toDate: query.compareToDate!,
        }),
      );
    }

    return this.rethrow(() =>
      buildIncomeStatement(rows, {
        currency,
        fromDate: query.fromDate,
        toDate: query.toDate,
        ...(comparative ? { comparative } : {}),
      }),
    );
  }

  async balanceSheet(tenantId: string, query: BalanceSheetQuery): Promise<BalanceSheet> {
    const currency = await this.baseCurrency(tenantId);
    const yearStart = await this.fiscalYearStart(tenantId, query.asOfDate);
    const rows = await this.balanceRows(tenantId, yearStart, query.asOfDate);
    return this.rethrow(() => buildBalanceSheet(rows, { currency, asOfDate: query.asOfDate }));
  }

  async cashFlow(tenantId: string, query: StatementPeriodQuery): Promise<CashFlowStatement> {
    const currency = await this.baseCurrency(tenantId);
    const rows = await this.balanceRows(tenantId, query.fromDate, query.toDate);
    return this.rethrow(() =>
      buildCashFlowStatement(rows, { currency, fromDate: query.fromDate, toDate: query.toDate }),
    );
  }

  async equity(tenantId: string, query: StatementPeriodQuery): Promise<EquityStatement> {
    const currency = await this.baseCurrency(tenantId);
    const rows = await this.balanceRows(tenantId, query.fromDate, query.toDate);
    return this.rethrow(() =>
      buildEquityStatement(rows, { currency, fromDate: query.fromDate, toDate: query.toDate }),
    );
  }
}

/** CSV export. Values are quoted so a name containing a comma cannot shift a column. */
export function sectionsToCsv(title: string, sections: readonly StatementSection[]): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const lines: string[] = [escape(title), ['Section', 'Code', 'Account', 'Amount'].map(escape).join(',')];
  for (const s of sections) {
    for (const line of s.lines) {
      lines.push([s.label, line.code, line.name, line.amount.amount].map(escape).join(','));
    }
    lines.push([s.label, '', 'Total', s.total.amount].map(escape).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
