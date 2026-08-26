import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BudgetError,
  budgetVariance,
  Money,
  spreadAnnualBudget,
  type AccountType,
  type VarianceReport,
} from '@acct/domain';
import type { MoneyDto } from '@acct/shared';
import type postgres from 'postgres';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

export interface BudgetDto {
  id: string;
  name: string;
  fiscalYearId: string;
  status: string;
  lineCount: number;
  total: MoneyDto;
}

@Injectable()
export class BudgetService {
  constructor(private readonly db: Database) {}

  private async baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
    const [row] = await tx<{ base_currency: string }[]>`
      SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
    return row!.base_currency;
  }

  async list(tenantId: string): Promise<BudgetDto[]> {
    return this.db.read(tenantId, async (tx) => {
      const currency = await this.baseCurrency(tx, tenantId);
      const rows = await tx<
        { id: string; name: string; fiscal_year_id: string; status: string; lines: string; total: string }[]
      >`
        SELECT b.id, b.name, b.fiscal_year_id, b.status,
               count(l.id)::text AS lines,
               COALESCE(SUM(l.amount_minor), 0)::text AS total
          FROM budgets b LEFT JOIN budget_lines l ON l.budget_id = b.id
         GROUP BY b.id, b.name, b.fiscal_year_id, b.status
         ORDER BY b.name`;
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        fiscalYearId: r.fiscal_year_id,
        status: r.status,
        lineCount: Number(r.lines),
        total: Money.fromMinor(r.total, currency).toJSON(),
      }));
    });
  }

  async create(
    tenantId: string,
    input: { name: string; fiscalYearId: string },
    actorId?: string,
  ): Promise<BudgetDto> {
    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          const [row] = await tx<{ id: string; name: string; fiscal_year_id: string; status: string }[]>`
            INSERT INTO budgets (tenant_id, fiscal_year_id, name, currency_code, created_by)
            VALUES (${tenantId}, ${input.fiscalYearId}, ${input.name}, ${currency}, ${actorId ?? null})
            RETURNING id, name, fiscal_year_id, status`;
          return {
            id: row!.id,
            name: row!.name,
            fiscalYearId: row!.fiscal_year_id,
            status: row!.status,
            lineCount: 0,
            total: Money.zero(currency).toJSON(),
          };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Set an account's budget for a year, either period by period or as an annual
   * figure spread across the periods.
   */
  async setAccountBudget(
    tenantId: string,
    budgetId: string,
    input: {
      accountId: string;
      annualAmountMinor?: string | undefined;
      method?: 'even' | 'weighted' | undefined;
      weights?: number[] | undefined;
      periods?: { periodId: string; amountMinor: string }[] | undefined;
    },
    actorId?: string,
  ): Promise<{ lines: { periodId: string; amountMinor: string }[] }> {
    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          const [budget] = await tx<{ id: string; fiscal_year_id: string; status: string }[]>`
            SELECT id, fiscal_year_id, status FROM budgets WHERE id = ${budgetId}`;
          if (!budget) {
            throw new LedgerError('BUDGET_NOT_FOUND', `No budget ${budgetId}`, HttpStatus.NOT_FOUND);
          }

          const periods = await tx<{ id: string }[]>`
            SELECT id FROM fiscal_periods WHERE fiscal_year_id = ${budget.fiscal_year_id}
             ORDER BY period_no`;

          let lines: { periodId: string; amountMinor: string }[];
          if (input.periods) {
            lines = input.periods;
          } else {
            if (input.annualAmountMinor === undefined) {
              throw new LedgerError(
                'AMOUNT_REQUIRED',
                'Give either an annual amount to spread or an amount per period',
                HttpStatus.UNPROCESSABLE_ENTITY,
              );
            }
            const spread = spreadAnnualBudget({
              currency,
              amountMinor: input.annualAmountMinor,
              periods: periods.length,
              method: input.method ?? 'even',
              ...(input.weights ? { weights: input.weights } : {}),
            });
            lines = spread.map((row) => ({
              periodId: periods[row.periodNo - 1]!.id,
              amountMinor: row.amountMinor,
            }));
          }

          for (const line of lines) {
            await tx`
              INSERT INTO budget_lines (tenant_id, budget_id, account_id, period_id, amount_minor, created_by)
              VALUES (${tenantId}, ${budgetId}, ${input.accountId}, ${line.periodId},
                      ${line.amountMinor}, ${actorId ?? null})
              ON CONFLICT (tenant_id, budget_id, account_id, period_id)
                DO UPDATE SET amount_minor = EXCLUDED.amount_minor, updated_at = now()`;
          }

          return { lines };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  async approve(tenantId: string, budgetId: string, actorId?: string): Promise<BudgetDto> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const rows = await tx`
          UPDATE budgets SET status = 'approved', approved_at = now(), approved_by = ${actorId ?? null}
           WHERE id = ${budgetId} AND status = 'draft'
           RETURNING id`;
        if (rows.length === 0) {
          throw new LedgerError(
            'BUDGET_NOT_DRAFT',
            'Only a draft budget can be approved; an approved budget is superseded, not edited',
            HttpStatus.CONFLICT,
          );
        }
      },
      { userId: actorId },
    );
    const budgets = await this.list(tenantId);
    return budgets.find((b) => b.id === budgetId)!;
  }

  /** Budget against actual for a date range, from posted journal lines. */
  async variance(
    tenantId: string,
    budgetId: string,
    range: { fromDate: string; toDate: string },
  ): Promise<VarianceReport> {
    return this.db.read(tenantId, async (tx) => {
      const currency = await this.baseCurrency(tx, tenantId);

      const budgetRows = await tx<
        { account_id: string; code: string; name: string; type: AccountType; amount: string }[]
      >`
        SELECT l.account_id, a.code, a.name, a.type, SUM(l.amount_minor)::text AS amount
          FROM budget_lines l
          JOIN accounts a ON a.id = l.account_id
          JOIN fiscal_periods p ON p.id = l.period_id
         WHERE l.budget_id = ${budgetId}
           AND p.start_date >= ${range.fromDate} AND p.end_date <= ${range.toDate}
         GROUP BY l.account_id, a.code, a.name, a.type`;

      /*
       * Actuals are signed the natural way for the account type, so they line up
       * with a budget expressed the way a manager would write it: revenue as a
       * positive number, not as a credit.
       */
      const actualRows = await tx<
        { account_id: string; code: string; name: string; type: AccountType; amount: string }[]
      >`
        SELECT l.account_id, a.code, a.name, a.type,
               SUM(CASE WHEN l.side::text = a.normal_balance::text THEN l.base_amount_minor
                        ELSE -l.base_amount_minor END)::text AS amount
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
         WHERE e.status IN ('posted', 'reversed')
           AND e.entry_date BETWEEN ${range.fromDate} AND ${range.toDate}
           AND a.type IN ('revenue', 'expense')
         GROUP BY l.account_id, a.code, a.name, a.type`;

      try {
        return budgetVariance(
          budgetRows.map((r) => ({
            accountId: r.account_id,
            code: r.code,
            name: r.name,
            type: r.type,
            amountMinor: r.amount,
          })),
          actualRows.map((r) => ({
            accountId: r.account_id,
            code: r.code,
            name: r.name,
            type: r.type,
            amountMinor: r.amount,
          })),
          { currency, fromDate: range.fromDate, toDate: range.toDate },
        );
      } catch (error) {
        throw translate(error);
      }
    });
  }
}

function translate(error: unknown): unknown {
  if (error instanceof BudgetError) {
    return new LedgerError(error.code, error.message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (error instanceof LedgerError) return error;
  const message = String((error as { message?: string }).message ?? error);
  if (/lines are fixed/.test(message)) {
    return new LedgerError('BUDGET_APPROVED', message, HttpStatus.CONFLICT);
  }
  if (/budgets_tenant_id_fiscal_year_id_name_key/.test(message)) {
    return new LedgerError('BUDGET_NAME_TAKEN', message, HttpStatus.CONFLICT);
  }
  return error;
}
