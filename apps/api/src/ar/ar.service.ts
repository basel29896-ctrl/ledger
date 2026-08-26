import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type postgres from 'postgres';
import {
  Money,
  allocateOldestFirst,
  buildAgingReport,
  calculateInvoice,
  dueDateFor,
  validateAllocation,
  type InvoiceLineInput,
  type OutstandingDocument,
} from '@acct/domain';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { requirePeriodFor } from '../ledger/ledger.service';

export interface CreateContactInput {
  code: string;
  name: string;
  nameAr?: string | undefined;
  isCustomer?: boolean | undefined;
  isVendor?: boolean | undefined;
  taxNumber?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  billingAddress?: string | undefined;
  paymentTermsDays?: number | undefined;
  creditLimitMinor?: string | undefined;
  defaultCurrency?: string | undefined;
}

export interface CreateInvoiceLineInput {
  description: string;
  quantity: string;
  unitPriceMinor: string;
  revenueAccountId: string;
  taxCodeId?: string | undefined;
  taxInclusive?: boolean | undefined;
}

export interface CreateInvoiceInput {
  contactId: string;
  issueDate: string;
  dueDate?: string | undefined;
  currencyCode?: string | undefined;
  reference?: string | undefined;
  notes?: string | undefined;
  docType?: 'invoice' | 'credit_note' | undefined;
  creditsDocumentId?: string | undefined;
  lines: CreateInvoiceLineInput[];
}

export interface CreateReceiptInput {
  contactId: string;
  paymentDate: string;
  amountMinor: string;
  bankAccountId: string;
  method?: string | undefined;
  reference?: string | undefined;
  memo?: string | undefined;
  /** Omit to let the receipt settle the oldest invoices first. */
  allocations?: { documentId: string; amountMinor: string }[] | undefined;
}

/**
 * Accounts Receivable.
 *
 * Every document posts an ordinary journal entry through the same tables the
 * manual entry screen uses, so the sub-ledger cannot drift from the GL: there
 * is only one ledger.
 */
@Injectable()
export class ArService {
  constructor(private readonly db: Database) {}

  // --- contacts --------------------------------------------------------

  async listContacts(tenantId: string, kind: 'customer' | 'vendor' | 'all'): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT c.id, c.code, c.name, c.name_ar, c.is_customer, c.is_vendor, c.tax_number,
               c.email, c.phone, c.payment_terms_days, c.credit_limit_minor::text,
               c.default_currency, c.is_active,
               COALESCE((
                 SELECT SUM(b.outstanding_minor) FROM sales_document_balances b
                  WHERE b.contact_id = c.id AND b.status = 'open'
               ), 0)::text AS outstanding_minor
          FROM contacts c
         WHERE (${kind === 'all'} OR (${kind === 'customer'} AND c.is_customer)
                OR (${kind === 'vendor'} AND c.is_vendor))
         ORDER BY c.code`,
    ) as unknown as Promise<unknown[]>;
  }

  async createContact(
    tenantId: string,
    input: CreateContactInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const rows = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
          INSERT INTO contacts (
            tenant_id, code, name, name_ar, is_customer, is_vendor, tax_number, email, phone,
            billing_address, payment_terms_days, credit_limit_minor, default_currency, created_by
          ) VALUES (
            ${tenantId}, ${input.code}, ${input.name}, ${input.nameAr ?? null},
            ${input.isCustomer ?? true}, ${input.isVendor ?? false}, ${input.taxNumber ?? null},
            ${input.email ?? null}, ${input.phone ?? null}, ${input.billingAddress ?? null},
            ${input.paymentTermsDays ?? 30}, ${input.creditLimitMinor ?? null},
            ${input.defaultCurrency ?? null}, ${actorId}
          ) RETURNING id`,
      { userId: actorId },
    );
    return rows[0]!;
  }

  // --- invoices --------------------------------------------------------

  /**
   * Create a draft or post immediately.
   *
   * Posting writes the journal entry in the same transaction as the document,
   * so an invoice can never exist without its ledger effect, or vice versa.
   */
  async createDocument(
    tenantId: string,
    input: CreateInvoiceInput,
    options: { post: boolean; actorId: string; idempotencyKey?: string | undefined },
  ): Promise<{ id: string; replayed: boolean }> {
    if (options.idempotencyKey) {
      const existing = await this.findDocumentByExternalId(tenantId, options.idempotencyKey);
      if (existing) return { id: existing, replayed: true };
    }

    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const contact = await this.requireContact(tx, input.contactId);
        const currency = input.currencyCode ?? contact.default_currency ?? (await baseCurrency(tx, tenantId));
        const isCredit = input.docType === 'credit_note';

        // Resolve tax rates before any arithmetic; the domain does the maths.
        const taxRates = await this.loadTaxRates(tx, input.lines);
        const calculated = calculateInvoice(
          input.lines.map(
            (line): InvoiceLineInput => ({
              quantity: line.quantity,
              unitPriceMinor: BigInt(line.unitPriceMinor),
              ...(line.taxCodeId ? { taxRate: taxRates.get(line.taxCodeId) } : {}),
              ...(line.taxInclusive === undefined ? {} : { taxInclusive: line.taxInclusive }),
            }),
          ),
          currency,
        );

        const dueDate = input.dueDate ?? dueDateFor(input.issueDate, contact.payment_terms_days);

        const [doc] = await tx<{ id: string }[]>`
          INSERT INTO sales_documents (
            tenant_id, doc_type, contact_id, issue_date, due_date, currency_code,
            subtotal_minor, tax_total_minor, total_minor, status, reference, notes,
            credits_document_id, created_by
          ) VALUES (
            ${tenantId}, ${isCredit ? 'credit_note' : 'invoice'}::sales_doc_type,
            ${input.contactId}, ${input.issueDate}, ${dueDate}, ${currency},
            ${calculated.subtotalMinor.toString()}, ${calculated.taxTotalMinor.toString()},
            ${calculated.totalMinor.toString()}, 'draft', ${input.reference ?? null},
            ${input.notes ?? null}, ${input.creditsDocumentId ?? null}, ${options.actorId}
          ) RETURNING id`;

        let lineNo = 1;
        for (const [index, line] of input.lines.entries()) {
          const computed = calculated.lines[index]!;
          await tx`
            INSERT INTO sales_document_lines (
              tenant_id, document_id, line_no, description, quantity, unit_price_minor,
              line_total_minor, tax_code_id, tax_amount_minor, revenue_account_id
            ) VALUES (
              ${tenantId}, ${doc!.id}, ${lineNo}, ${line.description}, ${line.quantity},
              ${line.unitPriceMinor}, ${computed.netMinor.toString()},
              ${line.taxCodeId ?? null}, ${computed.taxMinor.toString()}, ${line.revenueAccountId}
            )`;
          lineNo += 1;
        }

        if (options.post) {
          await this.postDocumentInTx(tx, tenantId, doc!.id, options.actorId, options.idempotencyKey);
        }
        return doc!.id;
      },
      { userId: options.actorId },
    );

    return { id, replayed: false };
  }

  async postDocument(tenantId: string, documentId: string, actorId: string): Promise<void> {
    await this.db.transaction(
      tenantId,
      (tx) => this.postDocumentInTx(tx, tenantId, documentId, actorId),
      { userId: actorId },
    );
  }

  /**
   * Post the document to the ledger.
   *
   * Invoice: Dr Receivables (gross) / Cr Revenue (net per line) / Cr Output tax.
   * Credit note: the exact mirror.
   */
  private async postDocumentInTx(
    tx: postgres.TransactionSql,
    tenantId: string,
    documentId: string,
    actorId: string,
    externalId?: string | undefined,
  ): Promise<void> {
    const [doc] = await tx<
      {
        id: string;
        doc_type: 'invoice' | 'credit_note';
        contact_id: string;
        issue_date: string;
        currency_code: string;
        total_minor: string;
        status: string;
        fx_rate: string;
      }[]
    >`
      SELECT id, doc_type, contact_id, issue_date::text AS issue_date, currency_code,
             total_minor::text AS total_minor, status, fx_rate::text AS fx_rate
        FROM sales_documents WHERE id = ${documentId}`;

    if (!doc) {
      throw new LedgerError('DOCUMENT_NOT_FOUND', `No document ${documentId}`, HttpStatus.NOT_FOUND);
    }
    if (doc.status !== 'draft') {
      throw new LedgerError(
        'DOCUMENT_NOT_DRAFT',
        `Document is ${doc.status} and cannot be posted again`,
        HttpStatus.CONFLICT,
      );
    }

    const lines = await tx<
      {
        line_total_minor: string;
        tax_amount_minor: string;
        revenue_account_id: string;
        tax_code_id: string | null;
        description: string;
      }[]
    >`
      SELECT line_total_minor::text AS line_total_minor, tax_amount_minor::text AS tax_amount_minor,
             revenue_account_id, tax_code_id, description
        FROM sales_document_lines WHERE document_id = ${documentId} ORDER BY line_no`;

    if (lines.length === 0) {
      throw new LedgerError('DOCUMENT_EMPTY', 'A document needs at least one line', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const receivableId = await this.receivableAccountFor(tx, doc.contact_id);
    const period = await requirePeriodFor(tx, doc.issue_date);
    const base = await baseCurrency(tx, tenantId);
    const isCredit = doc.doc_type === 'credit_note';

    const [entry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
        source_document_id, memo, base_currency, source_system, external_id, created_by, posted_by
      ) VALUES (
        ${tenantId}, ${doc.issue_date}, ${period.id}, ${period.fiscal_year_id},
        'posted', 'ar', ${documentId},
        ${`${isCredit ? 'Credit note' : 'Invoice'} to customer`}, ${base},
        ${externalId ? 'ar' : null}, ${externalId ?? null}, ${actorId}, ${actorId}
      ) RETURNING id`;

    const receivableSide = isCredit ? 'credit' : 'debit';
    const incomeSide = isCredit ? 'debit' : 'credit';
    let lineNo = 1;

    await tx`
      INSERT INTO journal_lines (
        tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
        fx_rate, base_amount_minor, description, contact_id, created_by
      ) VALUES (
        ${tenantId}, ${entry!.id}, ${lineNo}, ${receivableId}, ${receivableSide}::entry_side,
        ${doc.total_minor}, ${doc.currency_code}, ${doc.fx_rate},
        ${await toBase(tx, doc.total_minor, doc.currency_code, base, doc.fx_rate)},
        'Accounts receivable', ${doc.contact_id}, ${actorId}
      )`;
    lineNo += 1;

    for (const line of lines) {
      if (BigInt(line.line_total_minor) > 0n) {
        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, tax_code_id, created_by
          ) VALUES (
            ${tenantId}, ${entry!.id}, ${lineNo}, ${line.revenue_account_id}, ${incomeSide}::entry_side,
            ${line.line_total_minor}, ${doc.currency_code}, ${doc.fx_rate},
            ${await toBase(tx, line.line_total_minor, doc.currency_code, base, doc.fx_rate)},
            ${line.description}, ${doc.contact_id}, ${line.tax_code_id}, ${actorId}
          )`;
        lineNo += 1;
      }

      if (BigInt(line.tax_amount_minor) > 0n && line.tax_code_id) {
        const outputAccount = await this.outputTaxAccountFor(tx, line.tax_code_id);
        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, tax_code_id, created_by
          ) VALUES (
            ${tenantId}, ${entry!.id}, ${lineNo}, ${outputAccount}, ${incomeSide}::entry_side,
            ${line.tax_amount_minor}, ${doc.currency_code}, ${doc.fx_rate},
            ${await toBase(tx, line.tax_amount_minor, doc.currency_code, base, doc.fx_rate)},
            'Output tax', ${doc.contact_id}, ${line.tax_code_id}, ${actorId}
          )`;
        lineNo += 1;
      }
    }

    const [allocated] = await tx<{ formatted: string; allocated_value: string }[]>`
      SELECT formatted, allocated_value::text FROM allocate_document_number(
        ${tenantId}::uuid, ${doc.doc_type === 'invoice' ? 'sales_invoice' : 'credit_note'}, '')`;

    await tx`
      UPDATE sales_documents
         SET status = 'open', doc_no = ${allocated!.allocated_value},
             doc_ref = ${allocated!.formatted}, journal_entry_id = ${entry!.id}, updated_at = now()
       WHERE id = ${documentId}`;
  }

  async voidDocument(
    tenantId: string,
    documentId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const [doc] = await tx<{ status: string; journal_entry_id: string | null }[]>`
          SELECT status, journal_entry_id FROM sales_documents WHERE id = ${documentId}`;
        if (!doc) {
          throw new LedgerError('DOCUMENT_NOT_FOUND', `No document ${documentId}`, HttpStatus.NOT_FOUND);
        }
        const [balance] = await tx<{ allocated_minor: string }[]>`
          SELECT allocated_minor::text AS allocated_minor FROM sales_document_balances
           WHERE document_id = ${documentId}`;
        if (balance && BigInt(balance.allocated_minor) > 0n) {
          throw new LedgerError(
            'DOCUMENT_HAS_PAYMENTS',
            'Unallocate the receipts against this document before voiding it',
            HttpStatus.CONFLICT,
          );
        }
        await tx`
          UPDATE sales_documents SET status = 'void', void_reason = ${reason}, updated_at = now()
           WHERE id = ${documentId}`;
      },
      { userId: actorId },
    );
  }

  async getDocument(tenantId: string, documentId: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [doc] = await tx<Record<string, unknown>[]>`
        SELECT d.*, d.total_minor::text AS total_minor, d.subtotal_minor::text AS subtotal_minor,
               d.tax_total_minor::text AS tax_total_minor,
               d.issue_date::text AS issue_date, d.due_date::text AS due_date,
               d.doc_no::text AS doc_no,
               c.name AS contact_name, c.code AS contact_code, c.tax_number AS contact_tax_number,
               b.outstanding_minor::text AS outstanding_minor,
               b.allocated_minor::text AS allocated_minor
          FROM sales_documents d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN sales_document_balances b ON b.document_id = d.id
         WHERE d.id = ${documentId}`;
      if (!doc) {
        throw new LedgerError('DOCUMENT_NOT_FOUND', `No document ${documentId}`, HttpStatus.NOT_FOUND);
      }
      const lines = await tx`
        SELECT l.line_no, l.description, l.quantity::text AS quantity,
               l.unit_price_minor::text AS unit_price_minor,
               l.line_total_minor::text AS line_total_minor,
               l.tax_amount_minor::text AS tax_amount_minor,
               l.tax_code_id, t.code AS tax_code, t.rate_percent::text AS tax_rate,
               a.code AS revenue_account_code, a.name AS revenue_account_name
          FROM sales_document_lines l
          LEFT JOIN tax_codes t ON t.id = l.tax_code_id
          JOIN accounts a ON a.id = l.revenue_account_id
         WHERE l.document_id = ${documentId} ORDER BY l.line_no`;
      const allocations = await tx`
        SELECT pa.amount_minor::text AS amount_minor, p.payment_ref, p.payment_date::text AS payment_date
          FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
         WHERE pa.document_id = ${documentId} ORDER BY p.payment_date`;
      return { ...doc, lines, allocations };
    });
  }

  async listDocuments(
    tenantId: string,
    filter: { contactId?: string | undefined; status?: string | undefined; limit: number },
  ): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT d.id, d.doc_type, d.doc_ref, d.issue_date::text AS issue_date,
               d.due_date::text AS due_date, d.currency_code, d.status,
               d.total_minor::text AS total_minor,
               COALESCE(b.outstanding_minor, d.total_minor)::text AS outstanding_minor,
               c.name AS contact_name, c.code AS contact_code
          FROM sales_documents d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN sales_document_balances b ON b.document_id = d.id
         WHERE TRUE
           ${filter.contactId ? tx`AND d.contact_id = ${filter.contactId}` : tx``}
           ${filter.status ? tx`AND d.status = ${filter.status}::sales_doc_status` : tx``}
         ORDER BY d.issue_date DESC, d.doc_no DESC NULLS FIRST
         LIMIT ${filter.limit}`,
    ) as unknown as Promise<unknown[]>;
  }

  // --- receipts --------------------------------------------------------

  /**
   * Record money received and apply it to invoices.
   *
   * The GL effect is the receipt itself (Dr bank, Cr receivables). Allocation
   * decides which invoices stopped being owed and has no GL effect of its own.
   */
  async createReceipt(
    tenantId: string,
    input: CreateReceiptInput,
    options: { actorId: string; idempotencyKey?: string | undefined },
  ): Promise<{ id: string; replayed: boolean }> {
    if (options.idempotencyKey) {
      const existing = await this.findPaymentByExternalId(tenantId, options.idempotencyKey);
      if (existing) return { id: existing, replayed: true };
    }

    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const contact = await this.requireContact(tx, input.contactId);
        const base = await baseCurrency(tx, tenantId);
        const currency = contact.default_currency ?? base;
        const amount = BigInt(input.amountMinor);
        if (amount <= 0n) {
          throw new LedgerError('AMOUNT_INVALID', 'A receipt must be greater than zero', HttpStatus.UNPROCESSABLE_ENTITY);
        }

        const open = await this.openDocumentsFor(tx, input.contactId);
        const allocations: { documentId: string; amountMinor: bigint }[] = input.allocations
          ? input.allocations.map((a) => ({
              documentId: a.documentId,
              amountMinor: BigInt(a.amountMinor),
            }))
          : [...allocateOldestFirst(amount, open).allocations];

        const problems = validateAllocation(amount, allocations, open);
        if (problems.length > 0) {
          throw new LedgerError(
            'ALLOCATION_INVALID',
            'The allocation does not fit the payment or the invoices',
            HttpStatus.UNPROCESSABLE_ENTITY,
            problems.map((message) => ({ path: 'allocations', message })),
          );
        }

        const receivableId = await this.receivableAccountFor(tx, input.contactId);
        const period = await requirePeriodFor(tx, input.paymentDate);

        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (
            tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
            memo, base_currency, source_system, external_id, created_by, posted_by
          ) VALUES (
            ${tenantId}, ${input.paymentDate}, ${period.id}, ${period.fiscal_year_id},
            'posted', 'ar', ${input.memo ?? 'Customer receipt'}, ${base},
            ${options.idempotencyKey ? 'ar' : null}, ${options.idempotencyKey ?? null},
            ${options.actorId}, ${options.actorId}
          ) RETURNING id`;

        const baseAmount = await toBase(tx, amount.toString(), currency, base, '1');
        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, created_by
          ) VALUES
            (${tenantId}, ${entry!.id}, 1, ${input.bankAccountId}, 'debit', ${amount.toString()},
             ${currency}, 1, ${baseAmount}, 'Customer receipt', ${input.contactId}, ${options.actorId}),
            (${tenantId}, ${entry!.id}, 2, ${receivableId}, 'credit', ${amount.toString()},
             ${currency}, 1, ${baseAmount}, 'Accounts receivable', ${input.contactId}, ${options.actorId})`;

        const [allocatedNo] = await tx<{ formatted: string; allocated_value: string }[]>`
          SELECT formatted, allocated_value::text FROM allocate_document_number(
            ${tenantId}::uuid, 'customer_receipt', '')`;

        const [payment] = await tx<{ id: string }[]>`
          INSERT INTO payments (
            tenant_id, direction, payment_no, payment_ref, contact_id, payment_date,
            currency_code, amount_minor, bank_account_id, method, reference, memo,
            status, journal_entry_id, created_by
          ) VALUES (
            ${tenantId}, 'received', ${allocatedNo!.allocated_value}, ${allocatedNo!.formatted},
            ${input.contactId}, ${input.paymentDate}, ${currency}, ${amount.toString()},
            ${input.bankAccountId}, ${input.method ?? 'bank_transfer'}, ${input.reference ?? null},
            ${input.memo ?? null}, 'posted', ${entry!.id}, ${options.actorId}
          ) RETURNING id`;

        for (const allocation of allocations) {
          await tx`
            INSERT INTO payment_allocations (tenant_id, payment_id, document_id, amount_minor, allocated_by)
            VALUES (${tenantId}, ${payment!.id}, ${allocation.documentId},
                    ${allocation.amountMinor.toString()}, ${options.actorId})`;
        }

        await this.settleFullyPaidDocuments(tx, allocations.map((a) => a.documentId));
        return payment!.id;
      },
      { userId: options.actorId },
    );

    return { id, replayed: false };
  }

  /** Apply an existing unapplied receipt to documents. */
  async allocatePayment(
    tenantId: string,
    paymentId: string,
    allocations: { documentId: string; amountMinor: string }[],
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const [payment] = await tx<{ contact_id: string; unapplied_minor: string }[]>`
          SELECT p.contact_id, b.unapplied_minor::text AS unapplied_minor
            FROM payments p JOIN payment_balances b ON b.payment_id = p.id
           WHERE p.id = ${paymentId}`;
        if (!payment) {
          throw new LedgerError('PAYMENT_NOT_FOUND', `No payment ${paymentId}`, HttpStatus.NOT_FOUND);
        }

        const open = await this.openDocumentsFor(tx, payment.contact_id);
        const parsed = allocations.map((a) => ({
          documentId: a.documentId,
          amountMinor: BigInt(a.amountMinor),
        }));
        const problems = validateAllocation(BigInt(payment.unapplied_minor), parsed, open);
        if (problems.length > 0) {
          throw new LedgerError(
            'ALLOCATION_INVALID',
            'The allocation does not fit the unapplied amount or the invoices',
            HttpStatus.UNPROCESSABLE_ENTITY,
            problems.map((message) => ({ path: 'allocations', message })),
          );
        }

        for (const allocation of parsed) {
          await tx`
            INSERT INTO payment_allocations (tenant_id, payment_id, document_id, amount_minor, allocated_by)
            VALUES (${tenantId}, ${paymentId}, ${allocation.documentId},
                    ${allocation.amountMinor.toString()}, ${actorId})
            ON CONFLICT (payment_id, document_id) DO UPDATE
              SET amount_minor = payment_allocations.amount_minor + EXCLUDED.amount_minor`;
        }
        await this.settleFullyPaidDocuments(tx, parsed.map((a) => a.documentId));
      },
      { userId: actorId },
    );
  }

  async listReceipts(tenantId: string, contactId?: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT p.id, p.payment_ref, p.payment_date::text AS payment_date, p.currency_code,
               p.amount_minor::text AS amount_minor, p.method, p.reference, p.status,
               b.allocated_minor::text AS allocated_minor,
               b.unapplied_minor::text AS unapplied_minor,
               c.name AS contact_name, c.code AS contact_code
          FROM payments p
          JOIN contacts c ON c.id = p.contact_id
          LEFT JOIN payment_balances b ON b.payment_id = p.id
         WHERE p.direction = 'received'
           ${contactId ? tx`AND p.contact_id = ${contactId}` : tx``}
         ORDER BY p.payment_date DESC, p.payment_no DESC`,
    ) as unknown as Promise<unknown[]>;
  }

  // --- reports ---------------------------------------------------------

  async agingReport(tenantId: string, asOf: string): Promise<unknown> {
    const { rows, currency, names } = await this.db.read(tenantId, async (tx) => {
      const base = await baseCurrency(tx, tenantId);
      const balances = await tx<
        {
          document_id: string;
          contact_id: string;
          doc_ref: string | null;
          issue_date: string;
          due_date: string;
          currency_code: string;
          outstanding_minor: string;
        }[]
      >`
        SELECT document_id, contact_id, doc_ref, issue_date::text AS issue_date,
               due_date::text AS due_date, currency_code, outstanding_minor::text AS outstanding_minor
          FROM sales_document_balances
         WHERE status = 'open' AND doc_type = 'invoice' AND outstanding_minor > 0
           AND issue_date <= ${asOf}`;
      const contacts = await tx<{ id: string; name: string; code: string }[]>`
        SELECT id, name, code FROM contacts WHERE is_customer`;
      return {
        rows: balances,
        currency: base,
        names: new Map(contacts.map((c) => [c.id, { name: c.name, code: c.code }])),
      };
    });

    const documents: OutstandingDocument[] = rows.map((r) => ({
      documentId: r.document_id,
      contactId: r.contact_id,
      docRef: r.doc_ref,
      issueDate: r.issue_date,
      dueDate: r.due_date,
      currency: r.currency_code,
      outstandingMinor: BigInt(r.outstanding_minor),
    }));

    const report = buildAgingReport(documents, asOf, currency);

    return {
      asOf: report.asOf,
      currency: report.currency,
      buckets: Object.fromEntries(
        Object.entries(report.buckets).map(([k, v]) => [k, v.toJSON()]),
      ),
      total: report.total.toJSON(),
      contacts: report.contacts.map((c) => ({
        contactId: c.contactId,
        contactName: names.get(c.contactId)?.name ?? c.contactId,
        contactCode: names.get(c.contactId)?.code ?? '',
        buckets: Object.fromEntries(Object.entries(c.buckets).map(([k, v]) => [k, v.toJSON()])),
        total: c.total.toJSON(),
        documents: c.documents.map((d) => ({
          documentId: d.documentId,
          docRef: d.docRef,
          issueDate: d.issueDate,
          dueDate: d.dueDate,
          daysOverdue: d.daysOverdue,
          bucket: d.bucket,
          outstanding: Money.fromMinor(d.outstandingMinor, c.currency).toJSON(),
        })),
      })),
    };
  }

  /** Statement of account: every document and receipt in date order. */
  async statement(
    tenantId: string,
    contactId: string,
    range: { fromDate: string; toDate: string },
  ): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [contact] = await tx<{ name: string; code: string; email: string | null }[]>`
        SELECT name, code, email FROM contacts WHERE id = ${contactId}`;
      if (!contact) {
        throw new LedgerError('CONTACT_NOT_FOUND', `No contact ${contactId}`, HttpStatus.NOT_FOUND);
      }
      const base = await baseCurrency(tx, tenantId);

      const [openingRow] = await tx<{ opening: string }[]>`
        SELECT COALESCE((
          SELECT SUM(total_minor) FROM sales_documents
           WHERE contact_id = ${contactId} AND status <> 'void'
             AND doc_type = 'invoice' AND issue_date < ${range.fromDate}
        ), 0) - COALESCE((
          SELECT SUM(total_minor) FROM sales_documents
           WHERE contact_id = ${contactId} AND status <> 'void'
             AND doc_type = 'credit_note' AND issue_date < ${range.fromDate}
        ), 0) - COALESCE((
          SELECT SUM(amount_minor) FROM payments
           WHERE contact_id = ${contactId} AND status = 'posted'
             AND direction = 'received' AND payment_date < ${range.fromDate}
        ), 0) AS opening`;

      const rows = await tx<
        { date: string; kind: string; ref: string | null; debit: string; credit: string }[]
      >`
        SELECT issue_date::text AS date,
               CASE WHEN doc_type = 'invoice' THEN 'invoice' ELSE 'credit_note' END AS kind,
               doc_ref AS ref,
               CASE WHEN doc_type = 'invoice' THEN total_minor ELSE 0 END::text AS debit,
               CASE WHEN doc_type = 'credit_note' THEN total_minor ELSE 0 END::text AS credit
          FROM sales_documents
         WHERE contact_id = ${contactId} AND status <> 'void'
           AND issue_date BETWEEN ${range.fromDate} AND ${range.toDate}
        UNION ALL
        SELECT payment_date::text, 'receipt', payment_ref, '0', amount_minor::text
          FROM payments
         WHERE contact_id = ${contactId} AND status = 'posted' AND direction = 'received'
           AND payment_date BETWEEN ${range.fromDate} AND ${range.toDate}
         ORDER BY 1, 2`;

      let running = Money.fromMinor(openingRow?.opening ?? '0', base);
      const opening = running;
      const entries = rows.map((row) => {
        running = running
          .add(Money.fromMinor(row.debit, base))
          .subtract(Money.fromMinor(row.credit, base));
        return {
          date: row.date,
          kind: row.kind,
          reference: row.ref,
          debit: Money.fromMinor(row.debit, base).toJSON(),
          credit: Money.fromMinor(row.credit, base).toJSON(),
          balance: running.toJSON(),
        };
      });

      return {
        contact: { id: contactId, ...contact },
        fromDate: range.fromDate,
        toDate: range.toDate,
        currency: base,
        openingBalance: opening.toJSON(),
        closingBalance: running.toJSON(),
        entries,
      };
    });
  }

  // --- internals -------------------------------------------------------

  private async requireContact(
    tx: postgres.TransactionSql,
    contactId: string,
  ): Promise<{ id: string; payment_terms_days: number; default_currency: string | null }> {
    const [contact] = await tx<
      { id: string; payment_terms_days: number; default_currency: string | null }[]
    >`SELECT id, payment_terms_days, default_currency FROM contacts WHERE id = ${contactId}`;
    if (!contact) {
      throw new LedgerError('CONTACT_NOT_FOUND', `No contact ${contactId}`, HttpStatus.NOT_FOUND);
    }
    return contact;
  }

  private async loadTaxRates(
    tx: postgres.TransactionSql,
    lines: readonly CreateInvoiceLineInput[],
  ): Promise<Map<string, { code: string; ratePercent: Decimal }>> {
    const ids = [...new Set(lines.map((l) => l.taxCodeId).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const rows = await tx<{ id: string; code: string; rate_percent: string }[]>`
      SELECT id, code, rate_percent::text AS rate_percent FROM tax_codes WHERE id = ANY(${ids})`;
    if (rows.length !== ids.length) {
      throw new LedgerError('TAX_CODE_NOT_FOUND', 'A tax code on a line does not exist', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return new Map(
      rows.map((r) => [r.id, { code: r.code, ratePercent: new Decimal(r.rate_percent) }]),
    );
  }

  private async receivableAccountFor(
    tx: postgres.TransactionSql,
    contactId: string,
  ): Promise<string> {
    const [row] = await tx<{ account_id: string | null }[]>`
      SELECT COALESCE(
        c.receivable_account_id,
        (SELECT id FROM accounts WHERE subtype = 'receivable' AND is_postable ORDER BY code LIMIT 1)
      ) AS account_id
      FROM contacts c WHERE c.id = ${contactId}`;
    if (!row?.account_id) {
      throw new LedgerError(
        'NO_RECEIVABLE_ACCOUNT',
        'No receivable control account is configured for this customer',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return row.account_id;
  }

  private async outputTaxAccountFor(
    tx: postgres.TransactionSql,
    taxCodeId: string,
  ): Promise<string> {
    const [row] = await tx<{ account_id: string | null }[]>`
      SELECT COALESCE(
        t.output_account_id,
        (SELECT id FROM accounts WHERE subtype = 'tax_payable' AND is_postable ORDER BY code LIMIT 1)
      ) AS account_id
      FROM tax_codes t WHERE t.id = ${taxCodeId}`;
    if (!row?.account_id) {
      throw new LedgerError(
        'NO_TAX_ACCOUNT',
        'No output tax account is configured for this tax code',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return row.account_id;
  }

  private async openDocumentsFor(
    tx: postgres.TransactionSql,
    contactId: string,
  ): Promise<{ documentId: string; dueDate: string; outstandingMinor: bigint }[]> {
    const rows = await tx<{ document_id: string; due_date: string; outstanding_minor: string }[]>`
      SELECT document_id, due_date::text AS due_date, outstanding_minor::text AS outstanding_minor
        FROM sales_document_balances
       WHERE contact_id = ${contactId} AND status = 'open' AND outstanding_minor > 0
       ORDER BY due_date`;
    return rows.map((r) => ({
      documentId: r.document_id,
      dueDate: r.due_date,
      outstandingMinor: BigInt(r.outstanding_minor),
    }));
  }

  /** Flip a document to `paid` once nothing is outstanding. */
  private async settleFullyPaidDocuments(
    tx: postgres.TransactionSql,
    documentIds: readonly string[],
  ): Promise<void> {
    const ids = documentIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    await tx`
      UPDATE sales_documents d SET status = 'paid', updated_at = now()
       WHERE d.id = ANY(${ids})
         AND d.status = 'open'
         AND (SELECT b.outstanding_minor FROM sales_document_balances b WHERE b.document_id = d.id) <= 0`;
  }

  private async findDocumentByExternalId(tenantId: string, key: string): Promise<string | null> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<{ id: string }[]>`
        SELECT d.id FROM sales_documents d
          JOIN journal_entries e ON e.id = d.journal_entry_id
         WHERE e.source_system = 'ar' AND e.external_id = ${key}`,
    );
    return rows[0]?.id ?? null;
  }

  private async findPaymentByExternalId(tenantId: string, key: string): Promise<string | null> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<{ id: string }[]>`
        SELECT p.id FROM payments p
          JOIN journal_entries e ON e.id = p.journal_entry_id
         WHERE e.source_system = 'ar' AND e.external_id = ${key}`,
    );
    return rows[0]?.id ?? null;
  }
}

async function baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
    SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
  return row!.base_currency;
}

/** Convert a document-currency amount into base-currency minor units. */
async function toBase(
  _tx: postgres.TransactionSql,
  amountMinor: string,
  currency: string,
  base: string,
  fxRate: string,
): Promise<string> {
  if (currency === base) return amountMinor;
  const converted = Money.fromMinor(amountMinor, currency).toDecimal().mul(new Decimal(fxRate));
  return Money.fromDecimal(converted.toFixed(Money.zero(base).exponent), base).minor.toString();
}
