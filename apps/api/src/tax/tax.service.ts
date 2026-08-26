import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { Money, buildTaxReturn, type TaxReturnLineInput } from '@acct/domain';
import {
  EInvoiceSubmissionError,
  buildUblXml,
  createProvider,
  type EInvoiceDocument,
  type EInvoiceProvider,
} from '@acct/einvoice-jo';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

/**
 * Tax codes, the tax return, and e-invoicing clearance.
 *
 * Clearance is deliberately a separate step from posting: the ledger entry is
 * a fact the moment the invoice is issued, while clearance is an external
 * system's verdict that may take time or fail. Until it succeeds the invoice
 * is not a valid tax document, and the record says so.
 */
@Injectable()
export class TaxService {
  private readonly provider: EInvoiceProvider = createProvider({
    JOFOTARA_CLIENT_ID: process.env['JOFOTARA_CLIENT_ID'],
    JOFOTARA_SECRET_KEY: process.env['JOFOTARA_SECRET_KEY'],
    JOFOTARA_ENDPOINT: process.env['JOFOTARA_ENDPOINT'],
  });

  constructor(private readonly db: Database) {}

  async listTaxCodes(tenantId: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT t.id, t.code, t.name, t.name_ar, t.kind::text AS kind,
               t.rate_percent::text AS rate_percent, t.treatment::text AS treatment,
               t.is_withholding, t.is_recoverable, t.compound_on, t.jurisdiction, t.is_active,
               o.code AS output_account_code, i.code AS input_account_code
          FROM tax_codes t
          LEFT JOIN accounts o ON o.id = t.output_account_id
          LEFT JOIN accounts i ON i.id = t.input_account_id
         ORDER BY t.sort_order, t.code`,
    ) as unknown as Promise<unknown[]>;
  }

  async createTaxCode(
    tenantId: string,
    input: Record<string, unknown>,
    actorId: string,
  ): Promise<{ id: string }> {
    const rows = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ id: string }[]>`
          INSERT INTO tax_codes (
            tenant_id, code, name, name_ar, kind, rate_percent, treatment, is_withholding,
            is_recoverable, compound_on, output_account_id, input_account_id, sort_order
          ) VALUES (
            ${tenantId}, ${input['code'] as string}, ${input['name'] as string},
            ${(input['nameAr'] as string) ?? null}, ${(input['kind'] as string) ?? 'both'}::tax_kind,
            ${input['ratePercent'] as string},
            ${(input['treatment'] as string) ?? 'standard'}::tax_treatment,
            ${(input['isWithholding'] as boolean) ?? false},
            ${(input['isRecoverable'] as boolean) ?? true},
            ${(input['compoundOn'] as string[]) ?? []},
            ${(input['outputAccountId'] as string) ?? null},
            ${(input['inputAccountId'] as string) ?? null},
            ${(input['sortOrder'] as number) ?? 100}
          ) RETURNING id`,
      { userId: actorId },
    );
    return rows[0]!;
  }

  /**
   * The tax return for a period.
   *
   * Built from posted journal lines that carry a tax code, so it reports what
   * the ledger actually holds rather than what the documents intended.
   */
  async taxReturn(
    tenantId: string,
    range: { fromDate: string; toDate: string },
  ): Promise<unknown> {
    return this.db.read(tenantId, async (tx) => {
      const [tenant] = await tx<{ base_currency: string }[]>`
        SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
      const currency = tenant!.base_currency;

      // Net amounts: revenue and expense lines carrying a tax code.
      const netRows = await tx<
        {
          code: string;
          treatment: string;
          is_recoverable: boolean;
          direction: string;
          net_minor: string;
        }[]
      >`
        SELECT t.code, t.treatment::text AS treatment, t.is_recoverable,
               CASE WHEN a.type = 'revenue' THEN 'output' ELSE 'input' END AS direction,
               SUM(CASE WHEN a.type = 'revenue'
                        THEN (CASE WHEN l.side = 'credit' THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                        ELSE (CASE WHEN l.side = 'debit'  THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                   END)::text AS net_minor
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
          JOIN tax_codes t ON t.id = l.tax_code_id
         WHERE e.status IN ('posted', 'reversed')
           AND e.entry_date BETWEEN ${range.fromDate} AND ${range.toDate}
           AND a.type IN ('revenue', 'expense')
         GROUP BY t.code, t.treatment, t.is_recoverable, a.type`;

      // Tax amounts: lines hitting a tax control account.
      const taxRows = await tx<
        {
          code: string;
          treatment: string;
          is_recoverable: boolean;
          direction: string;
          tax_minor: string;
        }[]
      >`
        SELECT t.code, t.treatment::text AS treatment, t.is_recoverable,
               CASE WHEN a.subtype = 'tax_payable' THEN 'output' ELSE 'input' END AS direction,
               SUM(CASE WHEN a.subtype = 'tax_payable'
                        THEN (CASE WHEN l.side = 'credit' THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                        ELSE (CASE WHEN l.side = 'debit'  THEN l.base_amount_minor ELSE -l.base_amount_minor END)
                   END)::text AS tax_minor
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
          JOIN tax_codes t ON t.id = l.tax_code_id
         WHERE e.status IN ('posted', 'reversed')
           AND e.entry_date BETWEEN ${range.fromDate} AND ${range.toDate}
           AND a.subtype IN ('tax_payable', 'tax_receivable')
         GROUP BY t.code, t.treatment, t.is_recoverable, a.subtype`;

      const lines: TaxReturnLineInput[] = [];
      for (const row of netRows) {
        lines.push({
          taxCode: row.code,
          treatment: row.treatment as 'standard' | 'zero_rated' | 'exempt',
          direction: row.direction as 'output' | 'input',
          netMinor: BigInt(row.net_minor),
          taxMinor: 0n,
          isRecoverable: row.is_recoverable,
        });
      }
      for (const row of taxRows) {
        lines.push({
          taxCode: row.code,
          treatment: row.treatment as 'standard' | 'zero_rated' | 'exempt',
          direction: row.direction as 'output' | 'input',
          netMinor: 0n,
          taxMinor: BigInt(row.tax_minor),
          isRecoverable: row.is_recoverable,
        });
      }

      const result = buildTaxReturn(lines, { ...range, currency });
      const money = (minor: bigint): unknown => Money.fromMinor(minor, currency).toJSON();

      return {
        fromDate: result.fromDate,
        toDate: result.toDate,
        currency,
        standardRatedSales: {
          label: result.standardRatedSales.label,
          net: money(result.standardRatedSales.netMinor),
          tax: money(result.standardRatedSales.taxMinor),
        },
        zeroRatedSales: {
          label: result.zeroRatedSales.label,
          net: money(result.zeroRatedSales.netMinor),
          tax: money(result.zeroRatedSales.taxMinor),
        },
        exemptSales: {
          label: result.exemptSales.label,
          net: money(result.exemptSales.netMinor),
          tax: money(result.exemptSales.taxMinor),
        },
        totalSales: {
          label: result.totalSales.label,
          net: money(result.totalSales.netMinor),
          tax: money(result.totalSales.taxMinor),
        },
        purchases: {
          label: result.purchases.label,
          net: money(result.purchases.netMinor),
          tax: money(result.purchases.taxMinor),
        },
        outputTax: money(result.outputTaxMinor),
        recoverableInputTax: money(result.recoverableInputTaxMinor),
        irrecoverableInputTax: money(result.irrecoverableInputTaxMinor),
        netPayable: money(result.netPayableMinor),
        position: result.netPayableMinor >= 0n ? 'payable' : 'refundable',
        byCode: result.byCode.map((b) => ({
          code: b.code,
          direction: b.direction,
          net: money(b.netMinor),
          tax: money(b.taxMinor),
        })),
      };
    });
  }

  // --- e-invoicing -----------------------------------------------------

  /** Build the UBL document for an invoice, without submitting it. */
  async buildEInvoice(tenantId: string, documentId: string): Promise<{ xml: string }> {
    const document = await this.loadEInvoiceDocument(tenantId, documentId);
    return { xml: buildUblXml(document) };
  }

  /**
   * Submit an invoice for clearance.
   *
   * A transient failure increments the attempt counter and leaves the document
   * in `failed` so the retry endpoint (and, in production, the queue) can pick
   * it up. A rejection is terminal until the invoice is corrected.
   */
  async submitForClearance(
    tenantId: string,
    documentId: string,
    actorId: string,
  ): Promise<unknown> {
    const document = await this.loadEInvoiceDocument(tenantId, documentId);

    const [current] = await this.db.read(tenantId, (tx) =>
      tx<{ clearance_status: string; status: string }[]>`
        SELECT clearance_status::text AS clearance_status, status::text AS status
          FROM sales_documents WHERE id = ${documentId}`,
    );
    if (current?.status === 'draft') {
      throw new LedgerError(
        'DOCUMENT_NOT_POSTED',
        'Post the invoice before submitting it for clearance',
        HttpStatus.CONFLICT,
      );
    }
    if (current?.clearance_status === 'cleared') {
      throw new LedgerError(
        'ALREADY_CLEARED',
        'This invoice has already been cleared',
        HttpStatus.CONFLICT,
      );
    }

    try {
      const result = await this.provider.submit(document);
      await this.db.transaction(
        tenantId,
        async (tx) => {
          await tx`
            UPDATE sales_documents
               SET clearance_status = ${result.status}::clearance_status,
                   clearance_uuid = ${result.clearanceUuid},
                   clearance_qr = ${result.qrCode},
                   clearance_message = ${result.message},
                   clearance_attempts = clearance_attempts + 1,
                   last_submitted_at = now(),
                   cleared_at = ${result.status === 'cleared' ? new Date().toISOString() : null},
                   updated_at = now()
             WHERE id = ${documentId}`;
        },
        { userId: actorId },
      );
      return {
        status: result.status,
        clearanceUuid: result.clearanceUuid,
        qrCode: result.qrCode,
        message: result.message,
        isValidTaxDocument: result.isValidTaxDocument,
      };
    } catch (err) {
      const retryable = err instanceof EInvoiceSubmissionError ? err.retryable : true;
      const message = err instanceof Error ? err.message : 'Submission failed';

      await this.db.transaction(
        tenantId,
        async (tx) => {
          await tx`
            UPDATE sales_documents
               SET clearance_status = 'failed',
                   clearance_message = ${message},
                   clearance_attempts = clearance_attempts + 1,
                   last_submitted_at = now(),
                   updated_at = now()
             WHERE id = ${documentId}`;
        },
        { userId: actorId },
      );

      throw new LedgerError(
        retryable ? 'CLEARANCE_RETRYABLE' : 'CLEARANCE_FAILED',
        message,
        retryable ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /** Invoices awaiting clearance or in a failed state — the retry queue. */
  async clearanceQueue(tenantId: string): Promise<unknown[]> {
    return this.db.read(tenantId, (tx) =>
      tx`
        SELECT id, doc_ref, issue_date::text AS issue_date, total_minor::text AS total_minor,
               clearance_status::text AS clearance_status, clearance_attempts,
               clearance_message, last_submitted_at::text AS last_submitted_at
          FROM sales_documents
         WHERE doc_type = 'invoice' AND status <> 'void'
           AND clearance_status IN ('not_submitted', 'pending', 'failed')
         ORDER BY issue_date`,
    ) as unknown as Promise<unknown[]>;
  }

  private async loadEInvoiceDocument(
    tenantId: string,
    documentId: string,
  ): Promise<EInvoiceDocument> {
    return this.db.read(tenantId, async (tx) => {
      const [doc] = await tx<
        {
          id: string;
          doc_ref: string | null;
          doc_type: string;
          issue_date: string;
          currency_code: string;
          subtotal_minor: string;
          tax_total_minor: string;
          total_minor: string;
          contact_name: string;
          contact_tax_number: string | null;
          billing_address: string | null;
          corrects_ref: string | null;
        }[]
      >`
        SELECT d.id, d.doc_ref, d.doc_type::text AS doc_type, d.issue_date::text AS issue_date,
               d.currency_code, d.subtotal_minor::text AS subtotal_minor,
               d.tax_total_minor::text AS tax_total_minor, d.total_minor::text AS total_minor,
               c.name AS contact_name, c.tax_number AS contact_tax_number, c.billing_address,
               credited.doc_ref AS corrects_ref
          FROM sales_documents d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN sales_documents credited ON credited.id = d.credits_document_id
         WHERE d.id = ${documentId}`;

      if (!doc) {
        throw new LedgerError('DOCUMENT_NOT_FOUND', `No document ${documentId}`, HttpStatus.NOT_FOUND);
      }

      const [settings] = await tx<
        { legal_name: string; tax_number: string | null; address: string | null }[]
      >`SELECT legal_name, tax_number, address FROM company_settings`;

      const [currency] = await tx<{ minor_unit_exponent: number }[]>`
        SELECT minor_unit_exponent FROM currencies WHERE code = ${doc.currency_code}`;

      const lines = await tx<
        {
          line_no: number;
          description: string;
          quantity: string;
          unit_price_minor: string;
          line_total_minor: string;
          tax_amount_minor: string;
          tax_code: string | null;
          rate_percent: string | null;
        }[]
      >`
        SELECT l.line_no, l.description, l.quantity::text AS quantity,
               l.unit_price_minor::text AS unit_price_minor,
               l.line_total_minor::text AS line_total_minor,
               l.tax_amount_minor::text AS tax_amount_minor,
               t.code AS tax_code, t.rate_percent::text AS rate_percent
          FROM sales_document_lines l LEFT JOIN tax_codes t ON t.id = l.tax_code_id
         WHERE l.document_id = ${documentId} ORDER BY l.line_no`;

      return {
        id: doc.id,
        documentNumber: doc.doc_ref ?? doc.id,
        issueDate: doc.issue_date,
        currency: doc.currency_code,
        minorUnitExponent: currency?.minor_unit_exponent ?? 3,
        documentType: doc.doc_type === 'credit_note' ? 'credit_note' : 'invoice',
        supplier: {
          name: settings?.legal_name ?? 'Company',
          taxNumber: settings?.tax_number ?? null,
          address: settings?.address ?? null,
          countryCode: 'JO',
        },
        customer: {
          name: doc.contact_name,
          taxNumber: doc.contact_tax_number,
          address: doc.billing_address,
        },
        lines: lines.map((l) => ({
          lineNo: l.line_no,
          description: l.description,
          quantity: new Decimal(l.quantity).toString(),
          unitPriceMinor: l.unit_price_minor,
          netMinor: l.line_total_minor,
          taxMinor: l.tax_amount_minor,
          taxCode: l.tax_code,
          taxRatePercent: l.rate_percent,
        })),
        netMinor: doc.subtotal_minor,
        taxMinor: doc.tax_total_minor,
        grossMinor: doc.total_minor,
        correctsDocumentNumber: doc.corrects_ref,
      };
    });
  }
}
