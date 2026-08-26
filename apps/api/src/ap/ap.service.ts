import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import type postgres from 'postgres';
import {
  Money,
  allocateOldestFirst,
  buildAgingReport,
  calculateInvoice,
  canApprove,
  cashRequirements,
  dueDateFor,
  threeWayMatch,
  validateAllocation,
  type InvoiceLineInput,
  type MatchTolerance,
  type OutstandingDocument,
} from '@acct/domain';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { requirePeriodFor } from '../ledger/ledger.service';

export interface PurchaseLineInput {
  description: string;
  quantity: string;
  unitPriceMinor: string;
  expenseAccountId: string;
  taxCodeId?: string | undefined;
  orderLineId?: string | undefined;
}

export interface CreatePurchaseOrderInput {
  contactId: string;
  orderDate: string;
  expectedDate?: string | undefined;
  notes?: string | undefined;
  lines: PurchaseLineInput[];
}

export interface CreateGoodsReceiptInput {
  orderId: string;
  receivedDate: string;
  notes?: string | undefined;
  lines: { orderLineId: string; quantityReceived: string; description?: string | undefined }[];
}

export interface CreateBillInput {
  contactId: string;
  issueDate: string;
  dueDate?: string | undefined;
  vendorInvoiceNo?: string | undefined;
  orderId?: string | undefined;
  notes?: string | undefined;
  docType?: 'bill' | 'debit_note' | undefined;
  lines: PurchaseLineInput[];
}

export interface CreateVendorPaymentInput {
  contactId: string;
  paymentDate: string;
  amountMinor: string;
  bankAccountId: string;
  method?: string | undefined;
  reference?: string | undefined;
  memo?: string | undefined;
  allocations?: { documentId: string; amountMinor: string }[] | undefined;
}

const DEFAULT_TOLERANCE: MatchTolerance = {
  quantityPercent: new Decimal(0),
  pricePercent: new Decimal(0),
  absoluteMinor: 0n,
};

/**
 * Accounts Payable.
 *
 * A bill reaches the ledger only after it has been matched and approved.
 * The match and the approval are separate gates on purpose: matching says the
 * goods arrived at the agreed price, approval says a person accepts the spend.
 */
@Injectable()
export class ApService {
  constructor(private readonly db: Database) {}

  // --- purchase orders -------------------------------------------------

  async createOrder(
    tenantId: string,
    input: CreatePurchaseOrderInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const base = await baseCurrency(tx, tenantId);
        const taxRates = await loadTaxRates(tx, input.lines);
        const calculated = calculateInvoice(
          input.lines.map(
            (line): InvoiceLineInput => ({
              quantity: line.quantity,
              unitPriceMinor: BigInt(line.unitPriceMinor),
              ...(line.taxCodeId ? { taxRate: taxRates.get(line.taxCodeId) } : {}),
            }),
          ),
          base,
        );

        const [allocated] = await tx<{ formatted: string; allocated_value: string }[]>`
          SELECT formatted, allocated_value::text
            FROM allocate_document_number(${tenantId}::uuid, 'purchase_order', '')`;

        const [order] = await tx<{ id: string }[]>`
          INSERT INTO purchase_orders (
            tenant_id, po_no, po_ref, contact_id, order_date, expected_date, currency_code,
            status, subtotal_minor, tax_total_minor, total_minor, notes, created_by
          ) VALUES (
            ${tenantId}, ${allocated!.allocated_value}, ${allocated!.formatted}, ${input.contactId},
            ${input.orderDate}, ${input.expectedDate ?? null}, ${base}, 'approved',
            ${calculated.subtotalMinor.toString()}, ${calculated.taxTotalMinor.toString()},
            ${calculated.totalMinor.toString()}, ${input.notes ?? null}, ${actorId}
          ) RETURNING id`;

        let lineNo = 1;
        for (const [index, line] of input.lines.entries()) {
          const computed = calculated.lines[index]!;
          await tx`
            INSERT INTO purchase_order_lines (
              tenant_id, order_id, line_no, description, quantity, unit_price_minor,
              line_total_minor, tax_code_id, tax_amount_minor, expense_account_id
            ) VALUES (
              ${tenantId}, ${order!.id}, ${lineNo}, ${line.description}, ${line.quantity},
              ${line.unitPriceMinor}, ${computed.netMinor.toString()}, ${line.taxCodeId ?? null},
              ${computed.taxMinor.toString()}, ${line.expenseAccountId}
            )`;
          lineNo += 1;
        }
        return order!.id;
      },
      { userId: actorId },
    );
    return { id };
  }

  async getOrder(tenantId: string, orderId: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [order] = await tx<Record<string, unknown>[]>`
        SELECT o.id, o.po_ref, o.order_date::text AS order_date,
               o.expected_date::text AS expected_date, o.currency_code, o.status,
               o.subtotal_minor::text AS subtotal_minor, o.tax_total_minor::text AS tax_total_minor,
               o.total_minor::text AS total_minor, c.name AS contact_name, c.code AS contact_code
          FROM purchase_orders o JOIN contacts c ON c.id = o.contact_id
         WHERE o.id = ${orderId}`;
      if (!order) {
        throw new LedgerError('ORDER_NOT_FOUND', `No purchase order ${orderId}`, HttpStatus.NOT_FOUND);
      }
      const lines = await tx`
        SELECT p.order_line_id, p.line_no, p.description,
               p.quantity_ordered::text AS quantity_ordered,
               p.quantity_received::text AS quantity_received,
               p.quantity_billed::text AS quantity_billed,
               p.unit_price_ordered::text AS unit_price_ordered,
               p.unit_price_billed::text AS unit_price_billed
          FROM purchase_order_line_progress p
         WHERE p.order_id = ${orderId} ORDER BY p.line_no`;
      return { ...order, lines };
    });
  }

  async listOrders(tenantId: string, contactId?: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT o.id, o.po_ref, o.order_date::text AS order_date, o.status, o.currency_code,
               o.total_minor::text AS total_minor, c.name AS contact_name, c.code AS contact_code
          FROM purchase_orders o JOIN contacts c ON c.id = o.contact_id
         WHERE TRUE ${contactId ? tx`AND o.contact_id = ${contactId}` : tx``}
         ORDER BY o.order_date DESC, o.po_no DESC`,
    ) as unknown as Promise<unknown[]>;
  }

  // --- goods receipts --------------------------------------------------

  async createGoodsReceipt(
    tenantId: string,
    input: CreateGoodsReceiptInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const [order] = await tx<{ id: string; contact_id: string }[]>`
          SELECT id, contact_id FROM purchase_orders WHERE id = ${input.orderId}`;
        if (!order) {
          throw new LedgerError('ORDER_NOT_FOUND', `No purchase order ${input.orderId}`, HttpStatus.NOT_FOUND);
        }

        const [allocated] = await tx<{ formatted: string; allocated_value: string }[]>`
          SELECT formatted, allocated_value::text
            FROM allocate_document_number(${tenantId}::uuid, 'goods_receipt', '')`;

        const [receipt] = await tx<{ id: string }[]>`
          INSERT INTO goods_receipts (
            tenant_id, grn_no, grn_ref, order_id, contact_id, received_date, notes, created_by
          ) VALUES (
            ${tenantId}, ${allocated!.allocated_value}, ${allocated!.formatted}, ${input.orderId},
            ${order.contact_id}, ${input.receivedDate}, ${input.notes ?? null}, ${actorId}
          ) RETURNING id`;

        let lineNo = 1;
        for (const line of input.lines) {
          const [orderLine] = await tx<{ description: string }[]>`
            SELECT description FROM purchase_order_lines WHERE id = ${line.orderLineId}`;
          if (!orderLine) {
            throw new LedgerError(
              'ORDER_LINE_NOT_FOUND',
              `No purchase order line ${line.orderLineId}`,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          await tx`
            INSERT INTO goods_receipt_lines (
              tenant_id, receipt_id, line_no, order_line_id, description, quantity_received
            ) VALUES (
              ${tenantId}, ${receipt!.id}, ${lineNo}, ${line.orderLineId},
              ${line.description ?? orderLine.description}, ${line.quantityReceived}
            )`;
          lineNo += 1;
        }

        await this.refreshOrderStatus(tx, input.orderId);
        return receipt!.id;
      },
      { userId: actorId },
    );
    return { id };
  }

  // --- bills -----------------------------------------------------------

  async createBill(
    tenantId: string,
    input: CreateBillInput,
    actorId: string,
  ): Promise<{ id: string }> {
    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const [contact] = await tx<{ payment_terms_days: number }[]>`
          SELECT payment_terms_days FROM contacts WHERE id = ${input.contactId}`;
        if (!contact) {
          throw new LedgerError('CONTACT_NOT_FOUND', `No vendor ${input.contactId}`, HttpStatus.NOT_FOUND);
        }

        const base = await baseCurrency(tx, tenantId);
        const taxRates = await loadTaxRates(tx, input.lines);
        const calculated = calculateInvoice(
          input.lines.map(
            (line): InvoiceLineInput => ({
              quantity: line.quantity,
              unitPriceMinor: BigInt(line.unitPriceMinor),
              ...(line.taxCodeId ? { taxRate: taxRates.get(line.taxCodeId) } : {}),
            }),
          ),
          base,
        );

        const dueDate = input.dueDate ?? dueDateFor(input.issueDate, contact.payment_terms_days);

        const [bill] = await tx<{ id: string }[]>`
          INSERT INTO purchase_documents (
            tenant_id, doc_type, vendor_invoice_no, contact_id, order_id, issue_date, due_date,
            currency_code, subtotal_minor, tax_total_minor, total_minor, status, notes, created_by
          ) VALUES (
            ${tenantId}, ${input.docType ?? 'bill'}::purchase_doc_type,
            ${input.vendorInvoiceNo ?? null}, ${input.contactId}, ${input.orderId ?? null},
            ${input.issueDate}, ${dueDate}, ${base},
            ${calculated.subtotalMinor.toString()}, ${calculated.taxTotalMinor.toString()},
            ${calculated.totalMinor.toString()}, 'draft', ${input.notes ?? null}, ${actorId}
          ) RETURNING id`;

        let lineNo = 1;
        for (const [index, line] of input.lines.entries()) {
          const computed = calculated.lines[index]!;
          await tx`
            INSERT INTO purchase_document_lines (
              tenant_id, document_id, line_no, order_line_id, description, quantity,
              unit_price_minor, line_total_minor, tax_code_id, tax_amount_minor, expense_account_id
            ) VALUES (
              ${tenantId}, ${bill!.id}, ${lineNo}, ${line.orderLineId ?? null}, ${line.description},
              ${line.quantity}, ${line.unitPriceMinor}, ${computed.netMinor.toString()},
              ${line.taxCodeId ?? null}, ${computed.taxMinor.toString()}, ${line.expenseAccountId}
            )`;
          lineNo += 1;
        }

        // Run the match immediately so the exception queue is populated on entry.
        const match = await this.runMatch(tx, bill!.id);
        await tx`
          UPDATE purchase_documents
             SET status = 'pending_approval',
                 match_status = ${match.status}::match_status,
                 match_notes = ${match.notes},
                 updated_at = now()
           WHERE id = ${bill!.id}`;

        return bill!.id;
      },
      { userId: actorId },
    );
    return { id };
  }

  /** Compare order, receipt and bill for every line that names a PO line. */
  private async runMatch(
    tx: postgres.TransactionSql,
    billId: string,
  ): Promise<{ status: 'not_required' | 'matched' | 'exception'; notes: string | null }> {
    const rows = await tx<
      {
        order_line_id: string;
        description: string;
        quantity_ordered: string;
        quantity_received: string;
        quantity_billed: string;
        unit_price_ordered: string;
        unit_price_billed: string | null;
      }[]
    >`
      SELECT p.order_line_id, p.description,
             p.quantity_ordered::text AS quantity_ordered,
             p.quantity_received::text AS quantity_received,
             p.quantity_billed::text AS quantity_billed,
             p.unit_price_ordered::text AS unit_price_ordered,
             p.unit_price_billed::text AS unit_price_billed
        FROM purchase_order_line_progress p
       WHERE p.order_line_id IN (
         SELECT order_line_id FROM purchase_document_lines
          WHERE document_id = ${billId} AND order_line_id IS NOT NULL
       )`;

    if (rows.length === 0) {
      // A bill with no purchase order behind it cannot be three-way matched.
      return { status: 'not_required', notes: null };
    }

    const result = threeWayMatch(
      rows.map((r) => ({
        orderLineId: r.order_line_id,
        description: r.description,
        quantityOrdered: r.quantity_ordered,
        quantityReceived: r.quantity_received,
        quantityBilled: r.quantity_billed,
        unitPriceOrdered: BigInt(r.unit_price_ordered),
        unitPriceBilled: r.unit_price_billed === null ? null : BigInt(r.unit_price_billed),
      })),
      DEFAULT_TOLERANCE,
    );

    return result.matched
      ? { status: 'matched', notes: null }
      : { status: 'exception', notes: result.exceptions.map((e) => e.message).join('; ') };
  }

  async matchReport(tenantId: string, billId: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [bill] = await tx<{ match_status: string; match_notes: string | null }[]>`
        SELECT match_status::text AS match_status, match_notes
          FROM purchase_documents WHERE id = ${billId}`;
      if (!bill) {
        throw new LedgerError('BILL_NOT_FOUND', `No bill ${billId}`, HttpStatus.NOT_FOUND);
      }
      const lines = await tx`
        SELECT p.order_line_id, p.description,
               p.quantity_ordered::text AS quantity_ordered,
               p.quantity_received::text AS quantity_received,
               p.quantity_billed::text AS quantity_billed,
               p.unit_price_ordered::text AS unit_price_ordered,
               p.unit_price_billed::text AS unit_price_billed
          FROM purchase_order_line_progress p
         WHERE p.order_line_id IN (
           SELECT order_line_id FROM purchase_document_lines
            WHERE document_id = ${billId} AND order_line_id IS NOT NULL)`;
      return { matchStatus: bill.match_status, matchNotes: bill.match_notes, lines };
    });
  }

  /** Exception queue: bills the match refused. */
  async matchExceptions(tenantId: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT d.id, d.doc_ref, d.vendor_invoice_no, d.issue_date::text AS issue_date,
               d.total_minor::text AS total_minor, d.match_status::text AS match_status,
               d.match_notes, c.name AS contact_name
          FROM purchase_documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.match_status = 'exception' AND d.status <> 'void'
         ORDER BY d.issue_date`,
    ) as unknown as Promise<unknown[]>;
  }

  async overrideMatch(
    tenantId: string,
    billId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        await tx`
          UPDATE purchase_documents
             SET match_status = 'overridden',
                 match_notes = ${`Overridden: ${reason}`},
                 updated_at = now()
           WHERE id = ${billId} AND match_status = 'exception'`;
      },
      { userId: actorId },
    );
  }

  /**
   * Approve a bill and post it.
   *
   * The approval decision and the ledger posting happen together: an approved
   * bill that is not in the ledger is an unrecorded liability.
   */
  async approveBill(
    tenantId: string,
    billId: string,
    actor: { id: string; permissions: readonly string[] },
    reason?: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        const [bill] = await tx<
          {
            id: string;
            status: string;
            total_minor: string;
            created_by: string | null;
            match_status: string;
            contact_id: string;
            issue_date: string;
            currency_code: string;
            doc_type: string;
          }[]
        >`
          SELECT id, status::text AS status, total_minor::text AS total_minor, created_by,
                 match_status::text AS match_status, contact_id,
                 issue_date::text AS issue_date, currency_code, doc_type::text AS doc_type
            FROM purchase_documents WHERE id = ${billId}`;

        if (!bill) {
          throw new LedgerError('BILL_NOT_FOUND', `No bill ${billId}`, HttpStatus.NOT_FOUND);
        }
        if (bill.status !== 'pending_approval' && bill.status !== 'draft') {
          throw new LedgerError(
            'BILL_NOT_PENDING',
            `Bill is ${bill.status} and is not awaiting approval`,
            HttpStatus.CONFLICT,
          );
        }

        const [settings] = await tx<{ approval_threshold_minor: string }[]>`
          SELECT approval_threshold_minor::text AS approval_threshold_minor FROM company_settings`;

        const decision = canApprove(
          {
            billTotalMinor: BigInt(bill.total_minor),
            thresholdMinor: BigInt(settings?.approval_threshold_minor ?? '0'),
            createdBy: bill.created_by ?? '',
            approverId: actor.id,
            approverPermissions: actor.permissions,
          },
          { hasUnresolvedExceptions: bill.match_status === 'exception' },
        );

        if (!decision.allowed) {
          throw new LedgerError(
            decision.refusal ?? 'APPROVAL_REFUSED',
            decision.message ?? 'This bill cannot be approved',
            decision.refusal === 'MISSING_PERMISSION' ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT,
          );
        }

        await tx`
          INSERT INTO bill_approvals (tenant_id, document_id, approver_id, decision, reason)
          VALUES (${tenantId}, ${billId}, ${actor.id}, 'approved', ${reason ?? null})`;

        await this.postBillInTx(tx, tenantId, billId, actor.id);
      },
      { userId: actor.id },
    );
  }

  async rejectBill(
    tenantId: string,
    billId: string,
    reason: string,
    actorId: string,
  ): Promise<void> {
    await this.db.transaction(
      tenantId,
      async (tx) => {
        await tx`
          INSERT INTO bill_approvals (tenant_id, document_id, approver_id, decision, reason)
          VALUES (${tenantId}, ${billId}, ${actorId}, 'rejected', ${reason})`;
        await tx`
          UPDATE purchase_documents SET status = 'draft', updated_at = now()
           WHERE id = ${billId} AND status = 'pending_approval'`;
      },
      { userId: actorId },
    );
  }

  /** Bill: Dr Expense (net) / Dr Input tax / Cr Payables (gross). Debit note mirrors it. */
  private async postBillInTx(
    tx: postgres.TransactionSql,
    tenantId: string,
    billId: string,
    actorId: string,
  ): Promise<void> {
    const [bill] = await tx<
      {
        doc_type: string;
        contact_id: string;
        issue_date: string;
        currency_code: string;
        total_minor: string;
        fx_rate: string;
      }[]
    >`
      SELECT doc_type::text AS doc_type, contact_id, issue_date::text AS issue_date,
             currency_code, total_minor::text AS total_minor, fx_rate::text AS fx_rate
        FROM purchase_documents WHERE id = ${billId}`;

    const lines = await tx<
      {
        line_total_minor: string;
        tax_amount_minor: string;
        expense_account_id: string;
        tax_code_id: string | null;
        description: string;
      }[]
    >`
      SELECT line_total_minor::text AS line_total_minor, tax_amount_minor::text AS tax_amount_minor,
             expense_account_id, tax_code_id, description
        FROM purchase_document_lines WHERE document_id = ${billId} ORDER BY line_no`;

    if (lines.length === 0) {
      throw new LedgerError('BILL_EMPTY', 'A bill needs at least one line', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const payableId = await payableAccountFor(tx, bill!.contact_id);
    const period = await requirePeriodFor(tx, bill!.issue_date);
    const base = await baseCurrency(tx, tenantId);
    const isDebitNote = bill!.doc_type === 'debit_note';

    const [entry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
        source_document_id, memo, base_currency, created_by, posted_by
      ) VALUES (
        ${tenantId}, ${bill!.issue_date}, ${period.id}, ${period.fiscal_year_id}, 'posted', 'ap',
        ${billId}, ${isDebitNote ? 'Vendor debit note' : 'Vendor bill'}, ${base},
        ${actorId}, ${actorId}
      ) RETURNING id`;

    const payableSide = isDebitNote ? 'debit' : 'credit';
    const expenseSide = isDebitNote ? 'credit' : 'debit';
    let lineNo = 1;

    await tx`
      INSERT INTO journal_lines (
        tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
        fx_rate, base_amount_minor, description, contact_id, created_by
      ) VALUES (
        ${tenantId}, ${entry!.id}, ${lineNo}, ${payableId}, ${payableSide}::entry_side,
        ${bill!.total_minor}, ${bill!.currency_code}, ${bill!.fx_rate}, ${bill!.total_minor},
        'Accounts payable', ${bill!.contact_id}, ${actorId}
      )`;
    lineNo += 1;

    for (const line of lines) {
      if (BigInt(line.line_total_minor) > 0n) {
        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, tax_code_id, created_by
          ) VALUES (
            ${tenantId}, ${entry!.id}, ${lineNo}, ${line.expense_account_id}, ${expenseSide}::entry_side,
            ${line.line_total_minor}, ${bill!.currency_code}, ${bill!.fx_rate},
            ${line.line_total_minor}, ${line.description}, ${bill!.contact_id},
            ${line.tax_code_id}, ${actorId}
          )`;
        lineNo += 1;
      }

      if (BigInt(line.tax_amount_minor) > 0n && line.tax_code_id) {
        const inputAccount = await inputTaxAccountFor(tx, line.tax_code_id);
        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, tax_code_id, created_by
          ) VALUES (
            ${tenantId}, ${entry!.id}, ${lineNo}, ${inputAccount}, ${expenseSide}::entry_side,
            ${line.tax_amount_minor}, ${bill!.currency_code}, ${bill!.fx_rate},
            ${line.tax_amount_minor}, 'Input tax recoverable', ${bill!.contact_id},
            ${line.tax_code_id}, ${actorId}
          )`;
        lineNo += 1;
      }
    }

    const [allocated] = await tx<{ formatted: string; allocated_value: string }[]>`
      SELECT formatted, allocated_value::text FROM allocate_document_number(
        ${tenantId}::uuid, ${isDebitNote ? 'debit_note' : 'vendor_bill'}, '')`;

    await tx`
      UPDATE purchase_documents
         SET status = 'open', doc_no = ${allocated!.allocated_value}, doc_ref = ${allocated!.formatted},
             journal_entry_id = ${entry!.id}, approved_at = now(), approved_by = ${actorId},
             updated_at = now()
       WHERE id = ${billId}`;
  }

  async getBill(tenantId: string, billId: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [bill] = await tx<Record<string, unknown>[]>`
        SELECT d.id, d.doc_type::text AS doc_type, d.doc_ref, d.vendor_invoice_no,
               d.issue_date::text AS issue_date, d.due_date::text AS due_date,
               d.currency_code, d.status::text AS status, d.match_status::text AS match_status,
               d.match_notes, d.subtotal_minor::text AS subtotal_minor,
               d.tax_total_minor::text AS tax_total_minor, d.total_minor::text AS total_minor,
               d.journal_entry_id, d.order_id,
               c.name AS contact_name, c.code AS contact_code,
               b.outstanding_minor::text AS outstanding_minor,
               b.allocated_minor::text AS allocated_minor
          FROM purchase_documents d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN purchase_document_balances b ON b.document_id = d.id
         WHERE d.id = ${billId}`;
      if (!bill) {
        throw new LedgerError('BILL_NOT_FOUND', `No bill ${billId}`, HttpStatus.NOT_FOUND);
      }
      const lines = await tx`
        SELECT l.line_no, l.description, l.quantity::text AS quantity,
               l.unit_price_minor::text AS unit_price_minor,
               l.line_total_minor::text AS line_total_minor,
               l.tax_amount_minor::text AS tax_amount_minor, l.order_line_id,
               a.code AS expense_account_code, a.name AS expense_account_name
          FROM purchase_document_lines l JOIN accounts a ON a.id = l.expense_account_id
         WHERE l.document_id = ${billId} ORDER BY l.line_no`;
      const approvals = await tx`
        SELECT decision, reason, decided_at::text AS decided_at, approver_id
          FROM bill_approvals WHERE document_id = ${billId} ORDER BY decided_at`;
      return { ...bill, lines, approvals };
    });
  }

  async listBills(
    tenantId: string,
    filter: { contactId?: string | undefined; status?: string | undefined; limit: number },
  ): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT d.id, d.doc_type::text AS doc_type, d.doc_ref, d.vendor_invoice_no,
               d.issue_date::text AS issue_date, d.due_date::text AS due_date,
               d.status::text AS status, d.match_status::text AS match_status,
               d.total_minor::text AS total_minor,
               COALESCE(b.outstanding_minor, d.total_minor)::text AS outstanding_minor,
               c.name AS contact_name, c.code AS contact_code
          FROM purchase_documents d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN purchase_document_balances b ON b.document_id = d.id
         WHERE TRUE
           ${filter.contactId ? tx`AND d.contact_id = ${filter.contactId}` : tx``}
           ${filter.status ? tx`AND d.status = ${filter.status}::purchase_doc_status` : tx``}
         ORDER BY d.issue_date DESC, d.doc_no DESC NULLS FIRST
         LIMIT ${filter.limit}`,
    ) as unknown as Promise<unknown[]>;
  }

  // --- vendor payments -------------------------------------------------

  async payVendor(
    tenantId: string,
    input: CreateVendorPaymentInput,
    options: { actorId: string; idempotencyKey?: string | undefined },
  ): Promise<{ id: string; replayed: boolean }> {
    if (options.idempotencyKey) {
      const existing = await this.findPaymentByExternalId(tenantId, options.idempotencyKey);
      if (existing) return { id: existing, replayed: true };
    }

    const id = await this.db.transaction(
      tenantId,
      async (tx) => {
        const amount = BigInt(input.amountMinor);
        if (amount <= 0n) {
          throw new LedgerError('AMOUNT_INVALID', 'A payment must be greater than zero', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        const base = await baseCurrency(tx, tenantId);
        const open = await this.openBillsFor(tx, input.contactId);
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
            'The allocation does not fit the payment or the bills',
            HttpStatus.UNPROCESSABLE_ENTITY,
            problems.map((message) => ({ path: 'allocations', message })),
          );
        }

        const payableId = await payableAccountFor(tx, input.contactId);
        const period = await requirePeriodFor(tx, input.paymentDate);

        const [entry] = await tx<{ id: string }[]>`
          INSERT INTO journal_entries (
            tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
            memo, base_currency, source_system, external_id, created_by, posted_by
          ) VALUES (
            ${tenantId}, ${input.paymentDate}, ${period.id}, ${period.fiscal_year_id},
            'posted', 'ap', ${input.memo ?? 'Vendor payment'}, ${base},
            ${options.idempotencyKey ? 'ap' : null}, ${options.idempotencyKey ?? null},
            ${options.actorId}, ${options.actorId}
          ) RETURNING id`;

        await tx`
          INSERT INTO journal_lines (
            tenant_id, entry_id, line_no, account_id, side, amount_minor, currency_code,
            fx_rate, base_amount_minor, description, contact_id, created_by
          ) VALUES
            (${tenantId}, ${entry!.id}, 1, ${payableId}, 'debit', ${amount.toString()},
             ${base}, 1, ${amount.toString()}, 'Accounts payable', ${input.contactId}, ${options.actorId}),
            (${tenantId}, ${entry!.id}, 2, ${input.bankAccountId}, 'credit', ${amount.toString()},
             ${base}, 1, ${amount.toString()}, 'Vendor payment', ${input.contactId}, ${options.actorId})`;

        const [allocatedNo] = await tx<{ formatted: string; allocated_value: string }[]>`
          SELECT formatted, allocated_value::text
            FROM allocate_document_number(${tenantId}::uuid, 'vendor_payment', '')`;

        const [payment] = await tx<{ id: string }[]>`
          INSERT INTO payments (
            tenant_id, direction, payment_no, payment_ref, contact_id, payment_date,
            currency_code, amount_minor, bank_account_id, method, reference, memo,
            status, journal_entry_id, created_by
          ) VALUES (
            ${tenantId}, 'paid', ${allocatedNo!.allocated_value}, ${allocatedNo!.formatted},
            ${input.contactId}, ${input.paymentDate}, ${base}, ${amount.toString()},
            ${input.bankAccountId}, ${input.method ?? 'bank_transfer'}, ${input.reference ?? null},
            ${input.memo ?? null}, 'posted', ${entry!.id}, ${options.actorId}
          ) RETURNING id`;

        for (const allocation of allocations) {
          await tx`
            INSERT INTO purchase_allocations (tenant_id, payment_id, document_id, amount_minor, allocated_by)
            VALUES (${tenantId}, ${payment!.id}, ${allocation.documentId},
                    ${allocation.amountMinor.toString()}, ${options.actorId})`;
        }

        const ids = allocations.map((a) => a.documentId);
        if (ids.length > 0) {
          await tx`
            UPDATE purchase_documents d SET status = 'paid', updated_at = now()
             WHERE d.id = ANY(${ids}) AND d.status = 'open'
               AND (SELECT b.outstanding_minor FROM purchase_document_balances b
                     WHERE b.document_id = d.id) <= 0`;
        }

        return payment!.id;
      },
      { userId: options.actorId },
    );

    return { id, replayed: false };
  }

  /** A payment run: everything due by a date, grouped by vendor. */
  async paymentRun(tenantId: string, dueBy: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const base = await baseCurrency(tx, tenantId);
      const rows = await tx<
        {
          contact_id: string;
          contact_name: string;
          document_id: string;
          doc_ref: string | null;
          due_date: string;
          outstanding_minor: string;
        }[]
      >`
        SELECT b.contact_id, c.name AS contact_name, b.document_id, b.doc_ref,
               b.due_date::text AS due_date, b.outstanding_minor::text AS outstanding_minor
          FROM purchase_document_balances b JOIN contacts c ON c.id = b.contact_id
         WHERE b.status = 'open' AND b.outstanding_minor > 0 AND b.due_date <= ${dueBy}
         ORDER BY c.name, b.due_date`;

      const byVendor = new Map<string, { name: string; total: bigint; documents: unknown[] }>();
      for (const row of rows) {
        const bucket = byVendor.get(row.contact_id) ?? {
          name: row.contact_name,
          total: 0n,
          documents: [],
        };
        bucket.total += BigInt(row.outstanding_minor);
        bucket.documents.push({
          documentId: row.document_id,
          docRef: row.doc_ref,
          dueDate: row.due_date,
          outstanding: Money.fromMinor(row.outstanding_minor, base).toJSON(),
        });
        byVendor.set(row.contact_id, bucket);
      }

      let grandTotal = Money.zero(base);
      const vendors = [...byVendor.entries()].map(([contactId, v]) => {
        const total = Money.fromMinor(v.total, base);
        grandTotal = grandTotal.add(total);
        return { contactId, contactName: v.name, total: total.toJSON(), documents: v.documents };
      });

      return { dueBy, currency: base, vendors, total: grandTotal.toJSON() };
    });
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
               due_date::text AS due_date, currency_code,
               outstanding_minor::text AS outstanding_minor
          FROM purchase_document_balances
         WHERE status = 'open' AND doc_type = 'bill' AND outstanding_minor > 0
           AND issue_date <= ${asOf}`;
      const contacts = await tx<{ id: string; name: string; code: string }[]>`
        SELECT id, name, code FROM contacts WHERE is_vendor`;
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
      buckets: Object.fromEntries(Object.entries(report.buckets).map(([k, v]) => [k, v.toJSON()])),
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
          dueDate: d.dueDate,
          daysOverdue: d.daysOverdue,
          bucket: d.bucket,
          outstanding: Money.fromMinor(d.outstandingMinor, c.currency).toJSON(),
        })),
      })),
    };
  }

  async cashRequirements(tenantId: string, asOf: string): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const base = await baseCurrency(tx, tenantId);
      const rows = await tx<
        { document_id: string; contact_id: string; due_date: string; outstanding_minor: string }[]
      >`
        SELECT document_id, contact_id, due_date::text AS due_date,
               outstanding_minor::text AS outstanding_minor
          FROM purchase_document_balances
         WHERE status = 'open' AND outstanding_minor > 0`;

      const buckets = cashRequirements(
        rows.map((r) => ({
          documentId: r.document_id,
          contactId: r.contact_id,
          dueDate: r.due_date,
          outstandingMinor: BigInt(r.outstanding_minor),
        })),
        asOf,
      );

      return {
        asOf,
        currency: base,
        buckets: buckets.map((b) => ({
          label: b.label,
          untilDate: b.untilDate,
          total: Money.fromMinor(b.totalMinor, base).toJSON(),
          documentCount: b.documentIds.length,
        })),
      };
    });
  }

  // --- internals -------------------------------------------------------

  private async refreshOrderStatus(tx: postgres.TransactionSql, orderId: string): Promise<void> {
    const [progress] = await tx<{ outstanding: string }[]>`
      SELECT COALESCE(SUM(GREATEST(quantity_ordered - quantity_received, 0)), 0)::text AS outstanding
        FROM purchase_order_line_progress WHERE order_id = ${orderId}`;
    const fullyReceived = Number(progress?.outstanding ?? '0') === 0;
    await tx`
      UPDATE purchase_orders
         SET status = ${fullyReceived ? 'received' : 'partially_received'}::purchase_order_status,
             updated_at = now()
       WHERE id = ${orderId} AND status IN ('approved', 'partially_received')`;
  }

  private async openBillsFor(
    tx: postgres.TransactionSql,
    contactId: string,
  ): Promise<{ documentId: string; dueDate: string; outstandingMinor: bigint }[]> {
    const rows = await tx<{ document_id: string; due_date: string; outstanding_minor: string }[]>`
      SELECT document_id, due_date::text AS due_date, outstanding_minor::text AS outstanding_minor
        FROM purchase_document_balances
       WHERE contact_id = ${contactId} AND status = 'open' AND outstanding_minor > 0
       ORDER BY due_date`;
    return rows.map((r) => ({
      documentId: r.document_id,
      dueDate: r.due_date,
      outstandingMinor: BigInt(r.outstanding_minor),
    }));
  }

  private async findPaymentByExternalId(tenantId: string, key: string): Promise<string | null> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<{ id: string }[]>`
        SELECT p.id FROM payments p JOIN journal_entries e ON e.id = p.journal_entry_id
         WHERE e.source_system = 'ap' AND e.external_id = ${key}`,
    );
    return rows[0]?.id ?? null;
  }
}

async function baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
    SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
  return row!.base_currency;
}

async function loadTaxRates(
  tx: postgres.TransactionSql,
  lines: readonly { taxCodeId?: string | undefined }[],
): Promise<Map<string, { code: string; ratePercent: Decimal }>> {
  const ids = [...new Set(lines.map((l) => l.taxCodeId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await tx<{ id: string; code: string; rate_percent: string }[]>`
    SELECT id, code, rate_percent::text AS rate_percent FROM tax_codes WHERE id = ANY(${ids})`;
  return new Map(rows.map((r) => [r.id, { code: r.code, ratePercent: new Decimal(r.rate_percent) }]));
}

async function payableAccountFor(tx: postgres.TransactionSql, contactId: string): Promise<string> {
  const [row] = await tx<{ account_id: string | null }[]>`
    SELECT COALESCE(
      c.payable_account_id,
      (SELECT id FROM accounts WHERE subtype = 'payable' AND is_postable ORDER BY code LIMIT 1)
    ) AS account_id FROM contacts c WHERE c.id = ${contactId}`;
  if (!row?.account_id) {
    throw new LedgerError(
      'NO_PAYABLE_ACCOUNT',
      'No payable control account is configured for this vendor',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return row.account_id;
}

async function inputTaxAccountFor(tx: postgres.TransactionSql, taxCodeId: string): Promise<string> {
  const [row] = await tx<{ account_id: string | null }[]>`
    SELECT COALESCE(
      t.input_account_id,
      (SELECT id FROM accounts WHERE subtype = 'tax_receivable' AND is_postable ORDER BY code LIMIT 1)
    ) AS account_id FROM tax_codes t WHERE t.id = ${taxCodeId}`;
  if (!row?.account_id) {
    throw new LedgerError(
      'NO_TAX_ACCOUNT',
      'No input tax account is configured for this tax code',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return row.account_id;
}
