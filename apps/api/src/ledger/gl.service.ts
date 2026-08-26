import { HttpStatus, Injectable } from '@nestjs/common';
import { Money } from '@acct/domain';
import type { MoneyDto } from '@acct/shared';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

export interface GeneralLedgerRow {
  entryId: string;
  entryRef: string | null;
  entryDate: string;
  memo: string | null;
  lineDescription: string | null;
  side: 'debit' | 'credit';
  debit: MoneyDto;
  credit: MoneyDto;
  runningBalance: MoneyDto;
  sourceModule: string;
  status: string;
}

export interface GeneralLedgerReport {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  currency: string;
  openingBalance: MoneyDto;
  closingBalance: MoneyDto;
  totalDebit: MoneyDto;
  totalCredit: MoneyDto;
  rows: GeneralLedgerRow[];
}

/**
 * General ledger detail: every posted line hitting one account, in date order,
 * with a running balance. This is the drill-down target from the trial balance,
 * and each row carries the entry id so the UI can reach the source document.
 */
@Injectable()
export class GeneralLedgerService {
  constructor(private readonly db: Database) {}

  async forAccount(
    tenantId: string,
    accountId: string,
    range: { fromDate?: string | undefined; toDate?: string | undefined },
  ): Promise<GeneralLedgerReport> {
    return this.db.read(tenantId, async (tx) => {
      const [account] = await tx<
        { id: string; code: string; name: string; type: string; normal_balance: 'debit' | 'credit' }[]
      >`SELECT id, code, name, type, normal_balance FROM accounts WHERE id = ${accountId}`;

      if (!account) {
        throw new LedgerError('ACCOUNT_NOT_FOUND', `No account ${accountId}`, HttpStatus.NOT_FOUND);
      }

      const [tenant] = await tx<{ base_currency: string }[]>`
        SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
      const currency = tenant!.base_currency;

      // Everything before the window start collapses into the opening balance.
      const [opening] = await tx<{ debit: string; credit: string }[]>`
        SELECT COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'debit'), 0)::text AS debit,
               COALESCE(SUM(l.base_amount_minor) FILTER (WHERE l.side = 'credit'), 0)::text AS credit
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = ${accountId}
           AND e.status IN ('posted', 'reversed')
           ${range.fromDate ? tx`AND e.entry_date < ${range.fromDate}` : tx`AND false`}`;

      const rows = await tx<
        {
          entry_id: string;
          entry_ref: string | null;
          entry_date: string;
          memo: string | null;
          description: string | null;
          side: 'debit' | 'credit';
          base_amount_minor: string;
          source_module: string;
          status: string;
        }[]
      >`
        SELECT e.id AS entry_id, e.entry_ref, e.entry_date::text AS entry_date, e.memo,
               l.description, l.side, l.base_amount_minor::text AS base_amount_minor,
               e.source_module, e.status
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = ${accountId}
           AND e.status IN ('posted', 'reversed')
           ${range.fromDate ? tx`AND e.entry_date >= ${range.fromDate}` : tx``}
           ${range.toDate ? tx`AND e.entry_date <= ${range.toDate}` : tx``}
         ORDER BY e.entry_date, e.entry_no, l.line_no`;

      const signed = (debit: Money, credit: Money): Money =>
        account.normal_balance === 'debit' ? debit.subtract(credit) : credit.subtract(debit);

      const openingBalance = signed(
        Money.fromMinor(opening?.debit ?? '0', currency),
        Money.fromMinor(opening?.credit ?? '0', currency),
      );

      let running = openingBalance;
      let totalDebit = Money.zero(currency);
      let totalCredit = Money.zero(currency);
      const zero = Money.zero(currency);

      const detail: GeneralLedgerRow[] = rows.map((row) => {
        const amount = Money.fromMinor(row.base_amount_minor, currency);
        const debit = row.side === 'debit' ? amount : zero;
        const credit = row.side === 'credit' ? amount : zero;
        totalDebit = totalDebit.add(debit);
        totalCredit = totalCredit.add(credit);
        running = running.add(signed(debit, credit));
        return {
          entryId: row.entry_id,
          entryRef: row.entry_ref,
          entryDate: row.entry_date,
          memo: row.memo,
          lineDescription: row.description,
          side: row.side,
          debit: debit.toJSON(),
          credit: credit.toJSON(),
          runningBalance: running.toJSON(),
          sourceModule: row.source_module,
          status: row.status,
        };
      });

      return {
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.type,
        currency,
        openingBalance: openingBalance.toJSON(),
        closingBalance: running.toJSON(),
        totalDebit: totalDebit.toJSON(),
        totalCredit: totalCredit.toJSON(),
        rows: detail,
      };
    });
  }
}
