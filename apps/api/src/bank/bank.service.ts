import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { minorUnitExponent } from '@acct/shared';
import {
  Money,
  applyRules,
  parseStatement,
  reconcile,
  suggestMatches,
  type BankRule,
  type CsvMapping,
  type LedgerCandidate,
  type StatementFormat,
  type StatementLineForMatch,
} from '@acct/domain';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { requirePeriodFor } from '../ledger/ledger.service';

/** The CSV column mapping as it arrives from a Zod-parsed request body. */
export type CsvMappingInput = {
  [K in keyof CsvMapping]: CsvMapping[K] | undefined;
};

export interface ImportStatementInput {
  bankAccountId: string;
  format: StatementFormat;
  content: string;
  filename?: string | undefined;
  csvMapping?: CsvMappingInput | undefined;
}

/**
 * Banking.
 *
 * Importing a statement records what the bank says. Matching links a statement
 * line to a ledger entry that already exists. Categorising creates the entry
 * the ledger was missing. Reconciling asserts the two agree and locks the
 * lines that were cleared.
 */
@Injectable()
export class BankService {
  constructor(private readonly db: Database) {}

  async createBankAccount(
    tenantId: string,
    input: {
      accountId: string;
      name: string;
      bankName?: string | undefined;
      accountNumber?: string | undefined;
      iban?: string | undefined;
      currencyCode: string;
      openingBalanceMinor?: string | undefined;
      openingBalanceDate?: string | undefined;
    },
    actorId: string,
  ): Promise<{ id: string }> {
    const rows = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
          INSERT INTO bank_accounts (
            tenant_id, account_id, name, bank_name, account_number, iban, currency_code,
            opening_balance_minor, opening_balance_date, created_by
          ) VALUES (
            ${tenantId}, ${input.accountId}, ${input.name}, ${input.bankName ?? null},
            ${input.accountNumber ?? null}, ${input.iban ?? null}, ${input.currencyCode},
            ${input.openingBalanceMinor ?? '0'}, ${input.openingBalanceDate ?? null}, ${actorId}
          ) RETURNING id`,
      { userId: actorId },
    );
    return rows[0]!;
  }

  async listBankAccounts(tenantId: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT b.id, b.name, b.bank_name, b.account_number, b.iban, b.currency_code,
               b.opening_balance_minor::text AS opening_balance_minor,
               b.opening_balance_date::text AS opening_balance_date,
               a.code AS account_code, a.name AS account_name, b.account_id,
               COALESCE((
                 SELECT SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor ELSE -l.amount_minor END)
                   FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                  WHERE l.account_id = b.account_id AND e.status IN ('posted','reversed')
               ), 0)::text AS ledger_balance_minor,
               (SELECT count(*) FROM bank_statement_lines sl
                 WHERE sl.bank_account_id = b.id AND sl.status = 'unmatched')::text AS unmatched_count
          FROM bank_accounts b JOIN accounts a ON a.id = b.account_id
         ORDER BY b.name`,
    ) as unknown as Promise<unknown[]>;
  }

  /** Import a statement file. Re-importing the same bytes is refused. */
  async importStatement(
    tenantId: string,
    input: ImportStatementInput,
    actorId: string,
  ): Promise<{ statementId: string; imported: number; suggested: number }> {
    const hash = createHash('sha256').update(input.content).digest('hex');

    return this.db.transaction(
      tenantId,
      async (tx) => {
        const [account] = await tx<{ id: string; currency_code: string; account_id: string }[]>`
          SELECT id, currency_code, account_id FROM bank_accounts WHERE id = ${input.bankAccountId}`;
        if (!account) {
          throw new LedgerError('BANK_ACCOUNT_NOT_FOUND', 'No such bank account', HttpStatus.NOT_FOUND);
        }

        const duplicate = await tx`
          SELECT 1 FROM bank_statements
           WHERE bank_account_id = ${input.bankAccountId} AND content_hash = ${hash}`;
        if (duplicate.length > 0) {
          throw new LedgerError(
            'STATEMENT_ALREADY_IMPORTED',
            'This exact statement file has already been imported for this account',
            HttpStatus.CONFLICT,
          );
        }

        const exponent = minorUnitExponent(account.currency_code);
        const parsed = parseStatement(input.format, input.content, {
          exponent,
          ...(input.csvMapping ? { csvMapping: input.csvMapping as CsvMapping } : {}),
        });

        const [statement] = await tx<{ id: string }[]>`
          INSERT INTO bank_statements (
            tenant_id, bank_account_id, format, filename, statement_date,
            opening_balance_minor, closing_balance_minor, content_hash, imported_by
          ) VALUES (
            ${tenantId}, ${input.bankAccountId}, ${input.format}::statement_format,
            ${input.filename ?? null}, ${parsed.statementDate},
            ${parsed.openingBalanceMinor?.toString() ?? null},
            ${parsed.closingBalanceMinor?.toString() ?? null}, ${hash}, ${actorId}
          ) RETURNING id`;

        let lineNo = 1;
        for (const line of parsed.lines) {
          await tx`
            INSERT INTO bank_statement_lines (
              tenant_id, statement_id, bank_account_id, line_no, external_id, booking_date,
              value_date, description, reference, counterparty, amount_minor
            ) VALUES (
              ${tenantId}, ${statement!.id}, ${input.bankAccountId}, ${lineNo},
              ${line.externalId}, ${line.bookingDate}, ${line.valueDate}, ${line.description},
              ${line.reference}, ${line.counterparty}, ${line.amountMinor.toString()}
            )`;
          lineNo += 1;
        }

        const suggested = await this.runAutoMatch(tx, tenantId, input.bankAccountId, actorId);
        return { statementId: statement!.id, imported: parsed.lines.length, suggested };
      },
      { userId: actorId },
    );
  }

  /**
   * Suggest matches for every unmatched line on an account.
   * Suggestions are recorded, not applied: a person confirms them.
   */
  private async runAutoMatch(
    tx: postgres.TransactionSql,
    tenantId: string,
    bankAccountId: string,
    actorId: string,
  ): Promise<number> {
    const lines = await tx<
      {
        id: string;
        booking_date: string;
        description: string;
        reference: string | null;
        counterparty: string | null;
        amount_minor: string;
      }[]
    >`
      SELECT id, booking_date::text AS booking_date, description, reference, counterparty,
             amount_minor::text AS amount_minor
        FROM bank_statement_lines
       WHERE bank_account_id = ${bankAccountId} AND status = 'unmatched'`;

    if (lines.length === 0) return 0;

    const [account] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM bank_accounts WHERE id = ${bankAccountId}`;

    // Candidates: postings to the bank's GL account not already claimed.
    const candidates = await tx<
      {
        entry_id: string;
        entry_date: string;
        memo: string | null;
        description: string | null;
        contact_name: string | null;
        signed_minor: string;
        payment_ref: string | null;
      }[]
    >`
      SELECT e.id AS entry_id, e.entry_date::text AS entry_date, e.memo, l.description,
             c.name AS contact_name,
             SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor ELSE -l.amount_minor END)::text
               AS signed_minor,
             p.payment_ref
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        LEFT JOIN contacts c ON c.id = l.contact_id
        LEFT JOIN payments p ON p.journal_entry_id = e.id
       WHERE l.account_id = ${account!.account_id}
         AND e.status IN ('posted', 'reversed')
         AND e.id NOT IN (
           SELECT matched_entry_id FROM bank_statement_lines WHERE matched_entry_id IS NOT NULL)
       GROUP BY e.id, e.entry_date, e.memo, l.description, c.name, p.payment_ref`;

    const forMatch: StatementLineForMatch[] = lines.map((l) => ({
      id: l.id,
      bookingDate: l.booking_date,
      description: l.description,
      reference: l.reference,
      counterparty: l.counterparty,
      amountMinor: BigInt(l.amount_minor),
    }));

    const ledgerCandidates: LedgerCandidate[] = candidates.map((c) => ({
      id: c.entry_id,
      kind: 'journal_entry',
      date: c.entry_date,
      description: c.description ?? c.memo ?? '',
      reference: c.payment_ref,
      counterpartyName: c.contact_name,
      amountMinor: BigInt(c.signed_minor),
    }));

    const suggestions = suggestMatches(forMatch, ledgerCandidates);
    for (const suggestion of suggestions) {
      await tx`
        UPDATE bank_statement_lines
           SET status = 'suggested', matched_entry_id = ${suggestion.candidateId},
               match_confidence = ${suggestion.confidence}, match_reason = ${suggestion.reason},
               updated_at = now()
         WHERE id = ${suggestion.statementLineId}`;
    }

    // Rules only decide what an unmatched line *is*; they never claim an entry.
    const rules = await this.loadRules(tx, bankAccountId);
    if (rules.length > 0) {
      const stillUnmatched = forMatch.filter(
        (l) => !suggestions.some((s) => s.statementLineId === l.id),
      );
      for (const line of stillUnmatched) {
        const ruleMatch = applyRules(line, rules);
        if (!ruleMatch) continue;
        await tx`
          UPDATE bank_statement_lines
             SET match_confidence = 'rule',
                 match_reason = ${`Bank rule: ${ruleMatch.rule.description ?? ruleMatch.rule.id}`},
                 updated_at = now()
           WHERE id = ${line.id}`;
      }
    }

    void actorId;
    return suggestions.length;
  }

  private async loadRules(
    tx: postgres.TransactionSql,
    bankAccountId: string,
  ): Promise<BankRule[]> {
    const rows = await tx<
      {
        id: string;
        priority: number;
        description_contains: string | null;
        reference_contains: string | null;
        min_amount_minor: string | null;
        max_amount_minor: string | null;
        direction: string | null;
        account_id: string;
        contact_id: string | null;
        tax_code_id: string | null;
        set_description: string | null;
        name: string;
      }[]
    >`
      SELECT id, priority, description_contains, reference_contains,
             min_amount_minor::text AS min_amount_minor,
             max_amount_minor::text AS max_amount_minor,
             direction, account_id, contact_id, tax_code_id, set_description, name
        FROM bank_rules
       WHERE is_active AND (bank_account_id IS NULL OR bank_account_id = ${bankAccountId})
       ORDER BY priority`;

    return rows.map((r) => ({
      id: r.id,
      priority: r.priority,
      descriptionContains: r.description_contains,
      referenceContains: r.reference_contains,
      minAmountMinor: r.min_amount_minor === null ? null : BigInt(r.min_amount_minor),
      maxAmountMinor: r.max_amount_minor === null ? null : BigInt(r.max_amount_minor),
      direction: r.direction as 'in' | 'out' | null,
      accountId: r.account_id,
      contactId: r.contact_id,
      taxCodeId: r.tax_code_id,
      description: r.set_description ?? r.name,
    }));
  }

  async listStatementLines(
    tenantId: string,
    bankAccountId: string,
    status?: string,
  ): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT sl.id, sl.line_no, sl.booking_date::text AS booking_date, sl.description,
               sl.reference, sl.counterparty, sl.amount_minor::text AS amount_minor,
               sl.status::text AS status, sl.match_confidence, sl.match_reason,
               sl.matched_entry_id, e.entry_ref AS matched_entry_ref,
               EXISTS (SELECT 1 FROM reconciliation_lines rl
                        JOIN reconciliation_sessions rs ON rs.id = rl.session_id
                       WHERE rl.statement_line_id = sl.id AND rs.status = 'completed') AS locked
          FROM bank_statement_lines sl
          LEFT JOIN journal_entries e ON e.id = sl.matched_entry_id
         WHERE sl.bank_account_id = ${bankAccountId}
           ${status ? tx`AND sl.status = ${status}::statement_line_status` : tx``}
         ORDER BY sl.booking_date, sl.line_no`,
    ) as unknown as Promise<unknown[]>;
  }

  /** Confirm a suggestion, or match a line to an entry by hand. */
  async confirmMatch(
    tenantId: string,
    statementLineId: string,
    entryId: string | undefined,
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const [line] = await tx<{ matched_entry_id: string | null; status: string }[]>`
          SELECT matched_entry_id, status::text AS status
            FROM bank_statement_lines WHERE id = ${statementLineId}`;
        if (!line) {
          throw new LedgerError('LINE_NOT_FOUND', 'No such statement line', HttpStatus.NOT_FOUND);
        }
        const target = entryId ?? line.matched_entry_id;
        if (!target) {
          throw new LedgerError(
            'NO_MATCH_TARGET',
            'This line has no suggestion; name the journal entry to match',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        await tx`
          UPDATE bank_statement_lines
             SET status = 'matched', matched_entry_id = ${target},
                 matched_at = now(), matched_by = ${actorId}, updated_at = now()
           WHERE id = ${statementLineId}`;
      },
      { userId: actorId },
    );
  }

  async unmatch(tenantId: string, statementLineId: string, actorId: string): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        await tx`
          UPDATE bank_statement_lines
             SET status = 'unmatched', matched_entry_id = NULL, match_confidence = NULL,
                 match_reason = NULL, matched_at = NULL, matched_by = NULL, updated_at = now()
           WHERE id = ${statementLineId}`;
      },
      { userId: actorId },
    );
  }

  /**
   * Categorise an unmatched line: post the entry the ledger was missing and
   * match the line to it, in one transaction.
   */
  async categorise(
    tenantId: string,
    statementLineId: string,
    input: { accountId: string; contactId?: string | undefined; description?: string | undefined },
    actorId: string,
  ): Promise<{ entryId: string }> {
    return this.db.transaction(
      tenantId,
      async (tx) => {
        const [line] = await tx<
          {
            id: string;
            bank_account_id: string;
            booking_date: string;
            description: string;
            amount_minor: string;
            status: string;
          }[]
        >`
          SELECT id, bank_account_id, booking_date::text AS booking_date, description,
                 amount_minor::text AS amount_minor, status::text AS status
            FROM bank_statement_lines WHERE id = ${statementLineId}`;

        if (!line) {
          throw new LedgerError('LINE_NOT_FOUND', 'No such statement line', HttpStatus.NOT_FOUND);
        }
        if (line.status === 'matched') {
          throw new LedgerError('LINE_ALREADY_MATCHED', 'This line is already matched', HttpStatus.CONFLICT);
        }

        const [bank] = await tx<{ account_id: string; currency_code: string }[]>`
          SELECT account_id, currency_code FROM bank_accounts WHERE id = ${line.bank_account_id}`;

        const amount = BigInt(line.amount_minor);
        const magnitude = (amount < 0n ? -amount : amount).toString();
        const bankSide = amount > 0n ? 'debit' : 'credit';
        const otherSide = amount > 0n ? 'credit' : 'debit';
        const period = await requirePeriodFor(tx, line.booking_date);

        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (
            tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
            memo, base_currency, created_by, posted_by
          ) VALUES (
            ${tenantId}, ${line.booking_date}, ${period.id}, ${period.fiscal_year_id},
            'posted', 'bank', ${input.description ?? line.description},
            ${bank!.currency_code}, ${actorId}, ${actorId}
          ) RETURNING id`;

        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, created_by
          ) VALUES
            (${tenantId}, ${entry!.id}, 1, ${bank!.account_id}, ${bankSide}::entry_side,
             ${magnitude}, ${bank!.currency_code}, 1, ${magnitude},
             ${input.description ?? line.description}, ${input.contactId ?? null}, ${actorId}),
            (${tenantId}, ${entry!.id}, 2, ${input.accountId}, ${otherSide}::entry_side,
             ${magnitude}, ${bank!.currency_code}, 1, ${magnitude},
             ${input.description ?? line.description}, ${input.contactId ?? null}, ${actorId})`;

        await tx`
          UPDATE bank_statement_lines
             SET status = 'matched', matched_entry_id = ${entry!.id},
                 match_confidence = 'manual', match_reason = 'Categorised from the statement',
                 matched_at = now(), matched_by = ${actorId}, updated_at = now()
           WHERE id = ${statementLineId}`;

        return { entryId: entry!.id };
      },
      { userId: actorId },
    );
  }

  // --- transfers -------------------------------------------------------

  /**
   * Move money between two of the company's own accounts.
   *
   * A single journal entry cannot express a cross-currency transfer: invariant
   * 1 requires debits to equal credits *in each currency*, and the two legs are
   * in different currencies by definition. So the transfer posts one entry per
   * currency through a currency-exchange clearing account, and a third entry in
   * the base currency for whatever spread the bank took. The clearing account
   * nets to zero across the three, which is exactly the property that makes the
   * transfer auditable.
   */
  async transfer(
    tenantId: string,
    input: {
      fromBankAccountId: string;
      toBankAccountId: string;
      transferDate: string;
      amountMinor: string;
      receivedAmountMinor?: string | undefined;
      /** Base-currency value of one unit of the receiving currency. */
      fxRate?: string | undefined;
      memo?: string | undefined;
    },
    actorId: string,
  ): Promise<{ entryIds: string[] }> {
    return this.db.transaction(
      tenantId,
      async (tx) => {
        const [from] = await tx<{ account_id: string; currency_code: string }[]>`
          SELECT account_id, currency_code FROM bank_accounts WHERE id = ${input.fromBankAccountId}`;
        const [to] = await tx<{ account_id: string; currency_code: string }[]>`
          SELECT account_id, currency_code FROM bank_accounts WHERE id = ${input.toBankAccountId}`;
        if (!from || !to) {
          throw new LedgerError('BANK_ACCOUNT_NOT_FOUND', 'No such bank account', HttpStatus.NOT_FOUND);
        }
        if (input.fromBankAccountId === input.toBankAccountId) {
          throw new LedgerError(
            'SAME_ACCOUNT',
            'A transfer needs two different accounts',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const base = await baseCurrency(tx, tenantId);
        const sent = BigInt(input.amountMinor);
        const period = await requirePeriodFor(tx, input.transferDate);
        const memo = input.memo ?? 'Bank transfer';
        const sameCurrency = from.currency_code === to.currency_code;

        const newEntry = async (): Promise<string> => {
          const [entry] = await tx<{ id: string }[]>`
            INSERT INTO journal_entries (
              tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
              memo, base_currency, created_by, posted_by
            ) VALUES (
              ${tenantId}, ${input.transferDate}, ${period.id}, ${period.fiscal_year_id},
              'posted', 'bank', ${memo}, ${base}, ${actorId}, ${actorId}
            ) RETURNING id`;
          return entry!.id;
        };

        const line = async (
          entryId: string,
          lineNo: number,
          accountId: string,
          side: 'debit' | 'credit',
          amountMinor: bigint,
          currency: string,
          fxRate: string,
          baseMinor: bigint,
          description: string,
        ): Promise<void> => {
          await tx`
            INSERT INTO journal_lines (
              tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
              fx_rate, base_amount_minor, description, created_by
            ) VALUES (
              ${tenantId}, ${entryId}, ${lineNo}, ${accountId}, ${side}::entry_side,
              ${amountMinor.toString()}, ${currency}, ${fxRate}, ${baseMinor.toString()},
              ${description}, ${actorId}
            )`;
        };

        // --- same currency: one ordinary entry ---
        if (sameCurrency) {
          const received =
            input.receivedAmountMinor === undefined ? sent : BigInt(input.receivedAmountMinor);
          if (received !== sent) {
            throw new LedgerError(
              'AMOUNT_MISMATCH',
              'A same-currency transfer must receive exactly what was sent',
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          const entryId = await newEntry();
          await line(entryId, 1, from.account_id, 'credit', sent, from.currency_code, '1', sent, 'Transfer out');
          await line(entryId, 2, to.account_id, 'debit', sent, to.currency_code, '1', sent, 'Transfer in');
          return { entryIds: [entryId] };
        }

        // --- cross currency ---
        if (input.receivedAmountMinor === undefined) {
          throw new LedgerError(
            'RECEIVED_AMOUNT_REQUIRED',
            'A cross-currency transfer must state the amount received',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        if (input.fxRate === undefined) {
          throw new LedgerError(
            'FX_RATE_REQUIRED',
            'A cross-currency transfer must state the rate used to value the receiving leg',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const [clearing] = await tx<{ id: string }[]>`
          SELECT id FROM accounts
           WHERE subtype = 'fx_clearing' AND is_postable ORDER BY code LIMIT 1`;
        if (!clearing) {
          throw new LedgerError(
            'NO_FX_CLEARING_ACCOUNT',
            'No currency-exchange clearing account is configured (subtype fx_clearing)',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        const received = BigInt(input.receivedAmountMinor);
        // Base value of the receiving leg, rounded once, at the stated rate.
        const receivedBase = Money.fromDecimal(
          Money.fromMinor(received, to.currency_code)
            .toDecimal()
            .mul(input.fxRate)
            .toFixed(Money.zero(base).exponent),
          base,
        ).minor;
        const sentBase = from.currency_code === base ? sent : sent;

        const outEntry = await newEntry();
        await line(outEntry, 1, from.account_id, 'credit', sent, from.currency_code, '1', sentBase, 'Transfer out');
        await line(outEntry, 2, clearing.id, 'debit', sent, from.currency_code, '1', sentBase, 'Currency exchange');

        const inEntry = await newEntry();
        await line(inEntry, 1, to.account_id, 'debit', received, to.currency_code, input.fxRate, receivedBase, 'Transfer in');
        await line(inEntry, 2, clearing.id, 'credit', received, to.currency_code, input.fxRate, receivedBase, 'Currency exchange');

        const entryIds = [outEntry, inEntry];

        // Whatever the bank kept is the spread, and it belongs in FX, not in a
        // bank balance and not left sitting in the clearing account.
        const spread = sentBase - receivedBase;
        if (spread !== 0n) {
          const loss = spread > 0n;
          const [fxAccount] = await tx<{ id: string }[]>`
            SELECT id FROM accounts
             WHERE subtype = ${loss ? 'other_expense' : 'other_income'} AND is_postable
             ORDER BY code LIMIT 1`;
          if (!fxAccount) {
            throw new LedgerError(
              'NO_FX_ACCOUNT',
              `No ${loss ? 'FX loss' : 'FX gain'} account is configured`,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          const magnitude = loss ? spread : -spread;
          const fxEntry = await newEntry();
          await line(
            fxEntry, 1, fxAccount.id, loss ? 'debit' : 'credit', magnitude, base, '1', magnitude,
            loss ? 'Realised FX loss on transfer' : 'Realised FX gain on transfer',
          );
          await line(
            fxEntry, 2, clearing.id, loss ? 'credit' : 'debit', magnitude, base, '1', magnitude,
            'Currency exchange clearing',
          );
          entryIds.push(fxEntry);
        }

        return { entryIds };
      },
      { userId: actorId },
    );
  }

  // --- reconciliation --------------------------------------------------

  async startReconciliation(
    tenantId: string,
    input: { bankAccountId: string; statementDate: string; statementClosingMinor: string },
    actorId: string,
  ): Promise<unknown> {
    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const [session] = await tx<{ id: string }[]>`
          INSERT INTO reconciliation_sessions (
            tenant_id, bank_account_id, statement_date, statement_closing_minor, created_by
          ) VALUES (
            ${tenantId}, ${input.bankAccountId}, ${input.statementDate},
            ${input.statementClosingMinor}, ${actorId}
          ) RETURNING id`;
        return session!.id;
      },
      { userId: actorId },
    );
    return this.reconciliationStatus(tenantId, id);
  }

  async reconciliationStatus(tenantId: string, sessionId: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [session] = await tx<
        {
          id: string;
          bank_account_id: string;
          statement_date: string;
          statement_closing_minor: string;
          status: string;
        }[]
      >`
        SELECT id, bank_account_id, statement_date::text AS statement_date,
               statement_closing_minor::text AS statement_closing_minor, status::text AS status
          FROM reconciliation_sessions WHERE id = ${sessionId}`;
      if (!session) {
        throw new LedgerError('SESSION_NOT_FOUND', 'No such reconciliation', HttpStatus.NOT_FOUND);
      }

      const [bank] = await tx<{ account_id: string; currency_code: string }[]>`
        SELECT account_id, currency_code FROM bank_accounts WHERE id = ${session.bank_account_id}`;

      const [ledger] = await tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text
                 AS balance
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = ${bank!.account_id}
           AND e.status IN ('posted','reversed')
           AND e.entry_date <= ${session.statement_date}`;

      // Statement lines the ledger has never seen are NOT reconciling items:
      // they are work still to do. Counting them as an adjustment would make
      // every reconciliation appear to balance, which is the opposite of the
      // control's purpose.
      const [unmatchedStatement] = await tx<{ total: string; count: string }[]>`
        SELECT COALESCE(SUM(amount_minor), 0)::text AS total, count(*)::text AS count
          FROM bank_statement_lines
         WHERE bank_account_id = ${session.bank_account_id}
           AND status <> 'matched' AND status <> 'ignored'
           AND booking_date <= ${session.statement_date}`;

      const [unmatchedLedger] = await tx<{ total: string }[]>`
        SELECT COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text
                 AS total
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = ${bank!.account_id}
           AND e.status IN ('posted','reversed')
           AND e.entry_date <= ${session.statement_date}
           AND e.id NOT IN (
             SELECT matched_entry_id FROM bank_statement_lines
              WHERE matched_entry_id IS NOT NULL AND status = 'matched')`;

      const result = reconcile({
        statementClosingMinor: BigInt(session.statement_closing_minor),
        ledgerBalanceMinor: BigInt(ledger!.balance),
        unmatchedStatementMinor: 0n,
        // Ledger entries the bank has not shown yet — cheques in transit.
        // They are already in the ledger balance, so they come back out.
        unmatchedLedgerMinor: -BigInt(unmatchedLedger!.total),
      });

      const outstandingLines = Number(unmatchedStatement!.count);
      const currency = bank!.currency_code;
      return {
        id: session.id,
        bankAccountId: session.bank_account_id,
        statementDate: session.statement_date,
        status: session.status,
        statementClosing: Money.fromMinor(result.statementClosingMinor, currency).toJSON(),
        ledgerBalance: Money.fromMinor(result.ledgerBalanceMinor, currency).toJSON(),
        adjustedLedger: Money.fromMinor(result.adjustedLedgerMinor, currency).toJSON(),
        inTransit: Money.fromMinor(BigInt(unmatchedLedger!.total), currency).toJSON(),
        unmatchedStatementLines: outstandingLines,
        unmatchedStatementTotal: Money.fromMinor(unmatchedStatement!.total, currency).toJSON(),
        difference: Money.fromMinor(result.differenceMinor, currency).toJSON(),
        // Both conditions, not just the arithmetic one.
        reconciled: result.reconciled && outstandingLines === 0,
      };
    });
  }

  /** Complete a session. Refused unless the difference is exactly zero. */
  async completeReconciliation(
    tenantId: string,
    sessionId: string,
    actorId: string,
  ): Promise<unknown> {
    const status = (await this.reconciliationStatus(tenantId, sessionId)) as {
      reconciled: boolean;
      difference: { amount: string; currency: string };
      bankAccountId: string;
      statementDate: string;
      ledgerBalance: { minor: string };
      unmatchedStatementLines: number;
    };

    if (status.unmatchedStatementLines > 0) {
      throw new LedgerError(
        'NOT_RECONCILED',
        `${status.unmatchedStatementLines} statement line(s) up to this date are still unmatched`,
        HttpStatus.CONFLICT,
      );
    }
    if (!status.reconciled) {
      throw new LedgerError(
        'NOT_RECONCILED',
        `The account is out by ${status.difference.amount} ${status.difference.currency}; clear the difference before completing`,
        HttpStatus.CONFLICT,
      );
    }

    await this.db.transaction(
      tenantId,
      async (tx) => {
        await tx`
          INSERT INTO reconciliation_lines (session_id, statement_line_id, tenant_id)
          SELECT ${sessionId}, sl.id, ${tenantId}
            FROM bank_statement_lines sl
           WHERE sl.bank_account_id = ${status.bankAccountId}
             AND sl.status = 'matched'
             AND sl.booking_date <= ${status.statementDate}
          ON CONFLICT DO NOTHING`;

        await tx`
          UPDATE reconciliation_sessions
             SET status = 'completed', completed_at = now(), completed_by = ${actorId},
                 ledger_balance_minor = ${status.ledgerBalance.minor}, difference_minor = 0,
                 updated_at = now()
           WHERE id = ${sessionId}`;
      },
      { userId: actorId },
    );

    return this.reconciliationStatus(tenantId, sessionId);
  }

  async createRule(
    tenantId: string,
    input: Record<string, unknown>,
    actorId: string,
  ): Promise<{ id: string }> {
    const rows = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
          INSERT INTO bank_rules (
            tenant_id, bank_account_id, name, priority, description_contains, reference_contains,
            min_amount_minor, max_amount_minor, direction, account_id, contact_id, tax_code_id,
            set_description, created_by
          ) VALUES (
            ${tenantId}, ${(input['bankAccountId'] as string) ?? null}, ${input['name'] as string},
            ${(input['priority'] as number) ?? 100},
            ${(input['descriptionContains'] as string) ?? null},
            ${(input['referenceContains'] as string) ?? null},
            ${(input['minAmountMinor'] as string) ?? null},
            ${(input['maxAmountMinor'] as string) ?? null},
            ${(input['direction'] as string) ?? null}, ${input['accountId'] as string},
            ${(input['contactId'] as string) ?? null}, ${(input['taxCodeId'] as string) ?? null},
            ${(input['setDescription'] as string) ?? null}, ${actorId}
          ) RETURNING id`,
      { userId: actorId },
    );
    return rows[0]!;
  }

  async listRules(tenantId: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT r.id, r.name, r.priority, r.description_contains, r.reference_contains,
               r.min_amount_minor::text AS min_amount_minor,
               r.max_amount_minor::text AS max_amount_minor,
               r.direction, r.is_active, a.code AS account_code, a.name AS account_name
          FROM bank_rules r JOIN accounts a ON a.id = r.account_id
         ORDER BY r.priority, r.name`,
    ) as unknown as Promise<unknown[]>;
  }
}

async function baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
    SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
  return row!.base_currency;
}
