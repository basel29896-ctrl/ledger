import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  buildAccrualEntries,
  buildFxRevaluation,
  buildYearEndClosingEntry,
  CloseError,
  makeRate,
  Money,
  type ClosingLine,
  type ExchangeRate,
} from '@acct/domain';
import type { MoneyDto } from '@acct/shared';
import type postgres from 'postgres';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { insertLines, requirePeriodFor } from '../ledger/ledger.service';

/**
 * The default close checklist. It is seeded per period the first time the
 * checklist is read, so an item added later does not rewrite history for
 * periods already closed.
 */
const DEFAULT_CHECKLIST: { code: string; label: string; labelAr: string; blocking: boolean }[] = [
  { code: 'bank_reconciled', label: 'All bank accounts reconciled', labelAr: 'تسوية الحسابات البنكية', blocking: true },
  { code: 'ar_reviewed', label: 'Receivables aging reviewed', labelAr: 'مراجعة أعمار الذمم المدينة', blocking: true },
  { code: 'ap_reviewed', label: 'Payables aging reviewed', labelAr: 'مراجعة أعمار الذمم الدائنة', blocking: true },
  { code: 'accruals_posted', label: 'Accruals and prepayments posted', labelAr: 'قيود الاستحقاق والمصاريف المدفوعة مقدماً', blocking: true },
  { code: 'fx_revalued', label: 'Foreign currency balances revalued', labelAr: 'إعادة تقييم أرصدة العملات الأجنبية', blocking: false },
  { code: 'tax_return_filed', label: 'Sales tax return prepared', labelAr: 'إعداد إقرار ضريبة المبيعات', blocking: false },
  { code: 'trial_balance_checked', label: 'Trial balance agreed', labelAr: 'مطابقة ميزان المراجعة', blocking: true },
];

export interface ChecklistItem {
  id: string;
  itemCode: string;
  label: string;
  labelAr: string | null;
  isBlocking: boolean;
  status: 'pending' | 'done' | 'skipped';
  notes: string | null;
  completedAt: string | null;
}

export interface PeriodStatus {
  id: string;
  periodNo: number;
  startDate: string;
  endDate: string;
  status: 'open' | 'soft_closed' | 'closed';
  fiscalYearId: string;
  fiscalYearName: string;
  draftEntries: number;
  checklist: ChecklistItem[];
}

@Injectable()
export class CloseService {
  constructor(private readonly db: Database) {}

  private async baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
    const [row] = await tx<{ base_currency: string }[]>`
      SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
    return row!.base_currency;
  }

  // --- checklist --------------------------------------------------------

  async periodStatus(tenantId: string, periodId: string): Promise<PeriodStatus> {
    return this.db.transaction(tenantId, async (tx) => {
      const [period] = await tx<
        {
          id: string;
          period_no: number;
          start_date: string;
          end_date: string;
          status: PeriodStatus['status'];
          fiscal_year_id: string;
          year_name: string;
        }[]
      >`
        SELECT p.id, p.period_no, to_char(p.start_date,'YYYY-MM-DD') AS start_date,
               to_char(p.end_date,'YYYY-MM-DD') AS end_date, p.status,
               p.fiscal_year_id, y.name AS year_name
          FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id
         WHERE p.id = ${periodId}`;
      if (!period) {
        throw new LedgerError('PERIOD_NOT_FOUND', `No fiscal period ${periodId}`, HttpStatus.NOT_FOUND);
      }

      // Seed the checklist once, on first read, so the items are stable per period.
      for (const [index, item] of DEFAULT_CHECKLIST.entries()) {
        await tx`
          INSERT INTO period_close_checklist
            (tenant_id, period_id, item_code, label, label_ar, sort_order, is_blocking)
          VALUES (${tenantId}, ${periodId}, ${item.code}, ${item.label}, ${item.labelAr},
                  ${index * 10}, ${item.blocking})
          ON CONFLICT (tenant_id, period_id, item_code) DO NOTHING`;
      }

      const items = await tx<
        {
          id: string;
          item_code: string;
          label: string;
          label_ar: string | null;
          is_blocking: boolean;
          status: ChecklistItem['status'];
          notes: string | null;
          completed_at: string | null;
        }[]
      >`
        SELECT id, item_code, label, label_ar, is_blocking, status, notes, completed_at
          FROM period_close_checklist WHERE period_id = ${periodId} ORDER BY sort_order`;

      const [drafts] = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM journal_entries
         WHERE period_id = ${periodId} AND status = 'draft'`;

      return {
        id: period.id,
        periodNo: period.period_no,
        startDate: period.start_date,
        endDate: period.end_date,
        status: period.status,
        fiscalYearId: period.fiscal_year_id,
        fiscalYearName: period.year_name,
        draftEntries: Number(drafts!.count),
        checklist: items.map((i) => ({
          id: i.id,
          itemCode: i.item_code,
          label: i.label,
          labelAr: i.label_ar,
          isBlocking: i.is_blocking,
          status: i.status,
          notes: i.notes,
          completedAt: i.completed_at,
        })),
      };
    });
  }

  async setChecklistItem(
    tenantId: string,
    periodId: string,
    itemCode: string,
    input: { status: ChecklistItem['status']; notes?: string | undefined },
    actorId?: string,
  ): Promise<PeriodStatus> {
    if (input.status === 'skipped' && !input.notes?.trim()) {
      throw new LedgerError(
        'SKIP_NEEDS_REASON',
        'Skipping a close checklist item requires a reason, which is kept with the period',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    await this.periodStatus(tenantId, periodId); // seeds the items if missing
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const rows = await tx`
          UPDATE period_close_checklist
             SET status = ${input.status}::checklist_status,
                 notes = ${input.notes ?? null},
                 completed_at = ${input.status === 'pending' ? null : new Date()},
                 completed_by = ${input.status === 'pending' ? null : (actorId ?? null)}
           WHERE period_id = ${periodId} AND item_code = ${itemCode}
           RETURNING id`;
        if (rows.length === 0) {
          throw new LedgerError(
            'CHECKLIST_ITEM_NOT_FOUND',
            `No checklist item ${itemCode} on this period`,
            HttpStatus.NOT_FOUND,
          );
        }
      },
      { userId: actorId },
    );
    return this.periodStatus(tenantId, periodId);
  }

  // --- open, soft close, close, reopen ---------------------------------

  async setPeriodStatus(
    tenantId: string,
    periodId: string,
    status: PeriodStatus['status'],
    actorId?: string,
  ): Promise<PeriodStatus> {
    try {
      await this.db.transaction(
        tenantId,
        async (tx) => {
          const rows = await tx`
            UPDATE fiscal_periods
               SET status = ${status}::fiscal_status,
                   closed_at = ${status === 'closed' ? new Date() : null},
                   closed_by = ${status === 'closed' ? (actorId ?? null) : null}
             WHERE id = ${periodId}
             RETURNING id`;
          if (rows.length === 0) {
            throw new LedgerError('PERIOD_NOT_FOUND', `No fiscal period ${periodId}`, HttpStatus.NOT_FOUND);
          }
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
    return this.periodStatus(tenantId, periodId);
  }

  // --- accruals ---------------------------------------------------------

  async createAccrual(
    tenantId: string,
    input: {
      kind: 'accrual' | 'prepayment';
      memo: string;
      amountMinor: string;
      plAccountId: string;
      balanceAccountId: string;
      accrualDate: string;
      reversalDate: string;
    },
    actorId?: string,
  ): Promise<{ id: string; accrualEntryId: string; reversalEntryId: string }> {
    return this.db.transaction(
      tenantId,
      async (tx) => {
        const currency = await this.baseCurrency(tx, tenantId);
        let pair;
        try {
          pair = buildAccrualEntries({
            currency,
            kind: input.kind,
            amountMinor: input.amountMinor,
            expenseAccountId: input.plAccountId,
            balanceAccountId: input.balanceAccountId,
            accrualDate: input.accrualDate,
            reversalDate: input.reversalDate,
            memo: input.memo,
          });
        } catch (error) {
          throw translate(error);
        }

        /*
         * Both legs are posted now, not left as a promise to post later. An
         * accrual whose reversal depends on a job that never runs overstates
         * the following period for as long as nobody notices.
         */
        const accrualEntryId = await this.postAdjustment(tx, tenantId, pair.accrual, currency, actorId);
        const reversalEntryId = await this.postAdjustment(tx, tenantId, pair.reversal, currency, actorId);

        const [row] = await tx<{ id: string }[]>`
          INSERT INTO accruals (tenant_id, kind, memo, amount_minor, currency_code,
                                pl_account_id, balance_account_id, accrual_date, reversal_date,
                                accrual_entry_id, reversal_entry_id, created_by)
          VALUES (${tenantId}, ${input.kind}::accrual_kind, ${input.memo}, ${input.amountMinor},
                  ${currency}, ${input.plAccountId}, ${input.balanceAccountId},
                  ${input.accrualDate}, ${input.reversalDate},
                  ${accrualEntryId}, ${reversalEntryId}, ${actorId ?? null})
          RETURNING id`;

        return { id: row!.id, accrualEntryId, reversalEntryId };
      },
      { userId: actorId },
    );
  }

  async listAccruals(tenantId: string): Promise<
    {
      id: string;
      kind: string;
      memo: string;
      amount: MoneyDto;
      accrualDate: string;
      reversalDate: string;
      accrualEntryId: string | null;
      reversalEntryId: string | null;
    }[]
  > {
    return this.db.read(tenantId, async (tx) => {
      const rows = await tx<
        {
          id: string;
          kind: string;
          memo: string;
          amount_minor: string;
          currency_code: string;
          accrual_date: string;
          reversal_date: string;
          accrual_entry_id: string | null;
          reversal_entry_id: string | null;
        }[]
      >`
        SELECT id, kind, memo, amount_minor::text, currency_code,
               to_char(accrual_date,'YYYY-MM-DD') AS accrual_date,
               to_char(reversal_date,'YYYY-MM-DD') AS reversal_date,
               accrual_entry_id, reversal_entry_id
          FROM accruals ORDER BY accrual_date DESC, id DESC`;
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        memo: r.memo,
        amount: Money.fromMinor(r.amount_minor, r.currency_code).toJSON(),
        accrualDate: r.accrual_date,
        reversalDate: r.reversal_date,
        accrualEntryId: r.accrual_entry_id,
        reversalEntryId: r.reversal_entry_id,
      }));
    });
  }

  // --- FX revaluation ---------------------------------------------------

  async revalueForeignCurrency(
    tenantId: string,
    input: { asOfDate: string },
    actorId?: string,
  ): Promise<{ runId: string; entryId: string | null; netGain: MoneyDto; details: unknown }> {
    return this.db.transaction(
      tenantId,
      async (tx) => {
        const currency = await this.baseCurrency(tx, tenantId);

        /*
         * Monetary balances only: receivables, payables, bank and loan accounts
         * denominated in a foreign currency. Inventory and fixed assets are
         * non-monetary and stay at the rate they were bought at.
         */
        const balances = await tx<
          {
            account_id: string;
            code: string;
            currency_code: string;
            normal_balance: 'debit' | 'credit';
            foreign_minor: string;
            base_minor: string;
          }[]
        >`
          SELECT l.account_id, a.code, l.currency_code, a.normal_balance,
                 SUM(CASE WHEN l.side::text = a.normal_balance::text THEN l.amount_minor
                          ELSE -l.amount_minor END)::text AS foreign_minor,
                 SUM(CASE WHEN l.side::text = a.normal_balance::text THEN l.base_amount_minor
                          ELSE -l.base_amount_minor END)::text AS base_minor
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            JOIN accounts a ON a.id = l.account_id
           WHERE e.status IN ('posted', 'reversed')
             AND e.entry_date <= ${input.asOfDate}
             AND l.currency_code <> ${currency}
             AND a.subtype IN ('receivable','payable','bank','cash','long_term_liability','current_liability')
           GROUP BY l.account_id, a.code, l.currency_code, a.normal_balance
          HAVING SUM(CASE WHEN l.side::text = a.normal_balance::text THEN l.amount_minor
                          ELSE -l.amount_minor END) <> 0`;

        const rateRows = await tx<{ from_currency: string; rate: string }[]>`
          SELECT DISTINCT ON (from_currency) from_currency, rate::text
            FROM exchange_rates
           WHERE to_currency = ${currency} AND rate_date <= ${input.asOfDate}
           ORDER BY from_currency, rate_date DESC`;
        const rates: ExchangeRate[] = rateRows.map((r) =>
          makeRate(r.from_currency, currency, new Decimal(r.rate), input.asOfDate),
        );

        const [gainAccount] = await tx<{ id: string }[]>`
          SELECT id FROM accounts WHERE type = 'revenue' AND subtype = 'other_income' ORDER BY code LIMIT 1`;
        const [lossAccount] = await tx<{ id: string }[]>`
          SELECT id FROM accounts WHERE type = 'expense' AND subtype = 'other_expense' ORDER BY code LIMIT 1`;
        if (!gainAccount || !lossAccount) {
          throw new LedgerError(
            'NO_FX_RESULT_ACCOUNT',
            'The chart of accounts needs an other-income and an other-expense account to ' +
              'carry the revaluation result',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        let run;
        try {
          run = buildFxRevaluation(
            balances.map((b) => ({
              accountId: b.account_id,
              code: b.code,
              currency: b.currency_code,
              foreignMinor: b.foreign_minor,
              baseMinor: b.base_minor,
              normalBalance: b.normal_balance,
            })),
            {
              currency,
              asOfDate: input.asOfDate,
              rates,
              gainAccountId: gainAccount.id,
              lossAccountId: lossAccount.id,
              unrealisedOnly: true,
            },
          );
        } catch (error) {
          throw translate(error);
        }

        const entryId = run.isEmpty
          ? null
          : await this.postAdjustment(
              tx,
              tenantId,
              { entryDate: input.asOfDate, memo: run.memo, lines: run.lines },
              currency,
              actorId,
            );

        const [saved] = await tx<{ id: string }[]>`
          INSERT INTO fx_revaluation_runs
            (tenant_id, as_of_date, base_currency, net_gain_minor, entry_id, detail, created_by)
          VALUES (${tenantId}, ${input.asOfDate}, ${currency}, ${run.netGain.minor},
                  ${entryId}, ${JSON.stringify(run.details)}::jsonb, ${actorId ?? null})
          RETURNING id`;

        return { runId: saved!.id, entryId, netGain: run.netGain, details: run.details };
      },
      { userId: actorId },
    );
  }

  // --- year end ---------------------------------------------------------

  async closeYear(
    tenantId: string,
    fiscalYearId: string,
    actorId?: string,
  ): Promise<{ entryId: string; profit: MoneyDto }> {
    return this.db.transaction(
      tenantId,
      async (tx) => {
        const currency = await this.baseCurrency(tx, tenantId);
        const [year] = await tx<{ id: string; name: string; end_date: string; status: string }[]>`
          SELECT id, name, to_char(end_date,'YYYY-MM-DD') AS end_date, status
            FROM fiscal_years WHERE id = ${fiscalYearId}`;
        if (!year) {
          throw new LedgerError('FISCAL_YEAR_NOT_FOUND', `No fiscal year ${fiscalYearId}`, HttpStatus.NOT_FOUND);
        }
        if (year.status === 'closed') {
          throw new LedgerError(
            'YEAR_ALREADY_CLOSED',
            `Fiscal year ${year.name} is already closed`,
            HttpStatus.CONFLICT,
          );
        }

        const [retained] = await tx<{ id: string }[]>`
          SELECT id FROM accounts WHERE type = 'equity' AND subtype = 'retained_earnings'
           ORDER BY code LIMIT 1`;
        if (!retained) {
          throw new LedgerError(
            'NO_RETAINED_EARNINGS_ACCOUNT',
            'The chart of accounts needs a retained earnings account to close the year into',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const balances = await tx<
          { account_id: string; code: string; type: 'revenue' | 'expense'; debit: string; credit: string }[]
        >`
          SELECT l.account_id, a.code, a.type,
                 COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)::text AS debit,
                 COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)::text AS credit
            FROM journal_lines l
            JOIN journal_entries e ON e.id = l.entry_id
            JOIN accounts a ON a.id = l.account_id
           WHERE e.status IN ('posted', 'reversed')
             AND e.fiscal_year_id = ${fiscalYearId}
             AND a.type IN ('revenue', 'expense')
           GROUP BY l.account_id, a.code, a.type
           ORDER BY a.code`;

        let closing;
        try {
          closing = buildYearEndClosingEntry(
            balances.map((b) => ({
              accountId: b.account_id,
              code: b.code,
              type: b.type,
              debitMinor: b.debit,
              creditMinor: b.credit,
            })),
            { currency, entryDate: year.end_date, retainedEarningsAccountId: retained.id },
          );
        } catch (error) {
          throw translate(error);
        }

        const entryId = await this.postAdjustment(
          tx,
          tenantId,
          { entryDate: closing.entryDate, memo: closing.memo, lines: closing.lines },
          currency,
          actorId,
          { isClosingEntry: true },
        );

        return { entryId, profit: closing.profit };
      },
      { userId: actorId },
    );
  }

  async setYearStatus(
    tenantId: string,
    fiscalYearId: string,
    status: 'open' | 'soft_closed' | 'closed',
    actorId?: string,
  ): Promise<{ id: string; status: string }> {
    try {
      const [row] = await this.db.transaction(
        tenantId,
        (tx) =>
          tx<{ id: string; status: string }[]>`
            UPDATE fiscal_years SET status = ${status}::fiscal_status
             WHERE id = ${fiscalYearId} RETURNING id, status`,
        { userId: actorId },
      );
      if (!row) {
        throw new LedgerError('FISCAL_YEAR_NOT_FOUND', `No fiscal year ${fiscalYearId}`, HttpStatus.NOT_FOUND);
      }
      return row;
    } catch (error) {
      throw translate(error);
    }
  }

  /** Post a close entry. Every one is an adjustment, so a soft-closed period takes it. */
  private async postAdjustment(
    tx: postgres.TransactionSql,
    tenantId: string,
    entry: { entryDate: string; memo: string; lines: ClosingLine[] },
    currency: string,
    actorId?: string,
    opts: { isClosingEntry?: boolean } = {},
  ): Promise<string> {
    const period = await requirePeriodFor(tx, entry.entryDate);
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
        memo, base_currency, is_adjustment, is_closing_entry, created_by, posted_by
      ) VALUES (
        ${tenantId}, ${entry.entryDate}, ${period.id}, ${period.fiscal_year_id},
        'posted', 'manual'::source_module, ${entry.memo}, ${currency},
        true, ${opts.isClosingEntry ?? false}, ${actorId ?? null}, ${actorId ?? null}
      ) RETURNING id`;

    await insertLines(
      tx,
      tenantId,
      row!.id,
      entry.lines.map((l) => ({ accountId: l.accountId, side: l.side, amountMinor: l.amountMinor })),
      currency,
      actorId,
    );
    return row!.id;
  }
}

/** Domain and database refusals both become problem+json with a stable code. */
function translate(error: unknown): unknown {
  if (error instanceof CloseError) {
    return new LedgerError(error.code, error.message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (error instanceof LedgerError) return error;
  const message = String((error as { message?: string }).message ?? error);
  if (/outstanding checklist items/.test(message)) {
    return new LedgerError('CHECKLIST_INCOMPLETE', message, HttpStatus.CONFLICT);
  }
  if (/earlier period\(s\) are still open/.test(message)) {
    return new LedgerError('EARLIER_PERIOD_OPEN', message, HttpStatus.CONFLICT);
  }
  if (/draft/.test(message) && /period/.test(message)) {
    return new LedgerError('DRAFT_ENTRIES_IN_PERIOD', message, HttpStatus.CONFLICT);
  }
  if (/closing entry has not been posted/.test(message)) {
    return new LedgerError('CLOSING_ENTRY_MISSING', message, HttpStatus.CONFLICT);
  }
  if (/period\(s\) are not closed/.test(message)) {
    return new LedgerError('PERIODS_NOT_CLOSED', message, HttpStatus.CONFLICT);
  }
  if (/closed fiscal year/.test(message)) {
    return new LedgerError('YEAR_CLOSED', message, HttpStatus.CONFLICT);
  }
  return error;
}
