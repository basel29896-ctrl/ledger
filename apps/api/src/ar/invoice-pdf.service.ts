import { HttpStatus, Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { Money } from '@acct/domain';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';

interface DocRow {
  doc_ref: string | null;
  doc_type: string;
  issue_date: string;
  due_date: string;
  currency_code: string;
  subtotal_minor: string;
  tax_total_minor: string;
  total_minor: string;
  status: string;
  reference: string | null;
  notes: string | null;
  contact_name: string;
  contact_tax_number: string | null;
  billing_address: string | null;
  jofotara_uuid: string | null;
  jofotara_qr: string | null;
}

interface LineRow {
  line_no: number;
  description: string;
  quantity: string;
  unit_price_minor: string;
  line_total_minor: string;
  tax_amount_minor: string;
  tax_code: string | null;
  tax_rate: string | null;
}

/**
 * Server-side invoice PDF.
 *
 * The field list is the one a Jordanian tax invoice must carry: supplier name,
 * address and tax number; a sequential invoice number; the issue date; an
 * itemised description with quantity and value; the buyer name and TIN for
 * B2B; totals; and the tax rate and amount. The JoFotara QR code is printed
 * once the invoice has been cleared — that arrives with M7.
 */
@Injectable()
export class InvoicePdfService {
  constructor(private readonly db: Database) {}

  async render(tenantId: string, documentId: string): Promise<{ filename: string; bytes: Buffer }> {
    const { doc, lines, company } = await this.db.read(tenantId, async (tx) => {
      const [document] = await tx<DocRow[]>`
        SELECT d.doc_ref, d.doc_type::text AS doc_type, d.issue_date::text AS issue_date,
               d.due_date::text AS due_date, d.currency_code,
               d.subtotal_minor::text AS subtotal_minor, d.tax_total_minor::text AS tax_total_minor,
               d.total_minor::text AS total_minor, d.status::text AS status,
               d.reference, d.notes,
               c.name AS contact_name, c.tax_number AS contact_tax_number,
               c.billing_address,
               NULL::text AS jofotara_uuid, NULL::text AS jofotara_qr
          FROM sales_documents d JOIN contacts c ON c.id = d.contact_id
         WHERE d.id = ${documentId}`;

      if (!document) {
        throw new LedgerError('DOCUMENT_NOT_FOUND', `No document ${documentId}`, HttpStatus.NOT_FOUND);
      }

      const documentLines = await tx<LineRow[]>`
        SELECT l.line_no, l.description, l.quantity::text AS quantity,
               l.unit_price_minor::text AS unit_price_minor,
               l.line_total_minor::text AS line_total_minor,
               l.tax_amount_minor::text AS tax_amount_minor,
               t.code AS tax_code, t.rate_percent::text AS tax_rate
          FROM sales_document_lines l LEFT JOIN tax_codes t ON t.id = l.tax_code_id
         WHERE l.document_id = ${documentId} ORDER BY l.line_no`;

      const [settings] = await tx<
        {
          legal_name: string;
          tax_number: string | null;
          address: string | null;
          phone: string | null;
          email: string | null;
        }[]
      >`SELECT legal_name, tax_number, address, phone, email FROM company_settings`;

      return { doc: document, lines: documentLines, company: settings };
    });

    const currency = doc.currency_code;
    const money = (minor: string): string => `${Money.fromMinor(minor, currency).toString()} ${currency}`;

    const pdf = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve) => {
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
    });

    const title = doc.doc_type === 'credit_note' ? 'CREDIT NOTE' : 'TAX INVOICE';

    // --- supplier block (required: name, address, tax number) ---
    pdf.fontSize(18).text(company?.legal_name ?? 'Company', { continued: false });
    pdf.fontSize(9).fillColor('#444');
    if (company?.address) pdf.text(company.address);
    if (company?.tax_number) pdf.text(`Tax number: ${company.tax_number}`);
    if (company?.phone) pdf.text(`Tel: ${company.phone}`);
    if (company?.email) pdf.text(company.email);

    pdf.moveDown(1).fillColor('#000').fontSize(16).text(title, { align: 'right' });
    pdf.fontSize(10);
    pdf.text(`Number: ${doc.doc_ref ?? '(draft — not a valid tax document)'}`, { align: 'right' });
    pdf.text(`Issue date: ${doc.issue_date}`, { align: 'right' });
    pdf.text(`Due date: ${doc.due_date}`, { align: 'right' });
    if (doc.reference) pdf.text(`Reference: ${doc.reference}`, { align: 'right' });

    // --- buyer block (name and TIN, required for B2B) ---
    pdf.moveDown(1).fontSize(11).text('Bill to');
    pdf.fontSize(10).fillColor('#333').text(doc.contact_name);
    if (doc.billing_address) pdf.text(doc.billing_address);
    if (doc.contact_tax_number) pdf.text(`Tax number: ${doc.contact_tax_number}`);
    pdf.fillColor('#000');

    // --- itemised lines ---
    pdf.moveDown(1);
    const top = pdf.y;
    const columns = { desc: 48, qty: 300, price: 350, tax: 430, total: 490 };
    pdf.fontSize(9).fillColor('#555');
    pdf.text('Description', columns.desc, top);
    pdf.text('Qty', columns.qty, top, { width: 40, align: 'right' });
    pdf.text('Unit price', columns.price, top, { width: 70, align: 'right' });
    pdf.text('Tax', columns.tax, top, { width: 50, align: 'right' });
    pdf.text('Amount', columns.total, top, { width: 60, align: 'right' });
    pdf.moveTo(48, pdf.y + 2).lineTo(548, pdf.y + 2).strokeColor('#bbb').stroke();
    pdf.fillColor('#000').moveDown(0.5);

    for (const line of lines) {
      const y = pdf.y + 4;
      pdf.fontSize(9);
      pdf.text(line.description, columns.desc, y, { width: 240 });
      pdf.text(line.quantity, columns.qty, y, { width: 40, align: 'right' });
      pdf.text(Money.fromMinor(line.unit_price_minor, currency).toString(), columns.price, y, {
        width: 70,
        align: 'right',
      });
      pdf.text(
        line.tax_code ? `${line.tax_code} ${Number(line.tax_rate ?? 0)}%` : '—',
        columns.tax,
        y,
        { width: 50, align: 'right' },
      );
      pdf.text(Money.fromMinor(line.line_total_minor, currency).toString(), columns.total, y, {
        width: 60,
        align: 'right',
      });
      pdf.moveDown(0.6);
    }

    pdf.moveTo(48, pdf.y + 4).lineTo(548, pdf.y + 4).strokeColor('#bbb').stroke();
    pdf.moveDown(0.8);

    // --- totals, with the tax rate and amount stated separately ---
    const totalsX = 350;
    pdf.fontSize(10);
    pdf.text('Net total', totalsX, pdf.y, { width: 120, align: 'right', continued: true });
    pdf.text(`  ${money(doc.subtotal_minor)}`, { align: 'right' });
    pdf.text('Tax', totalsX, pdf.y, { width: 120, align: 'right', continued: true });
    pdf.text(`  ${money(doc.tax_total_minor)}`, { align: 'right' });
    pdf.fontSize(12).text('Total', totalsX, pdf.y + 2, { width: 120, align: 'right', continued: true });
    pdf.text(`  ${money(doc.total_minor)}`, { align: 'right' });

    if (doc.notes) {
      pdf.moveDown(1.5).fontSize(9).fillColor('#444').text(doc.notes, 48, pdf.y, { width: 500 });
    }

    // --- e-invoicing clearance ---
    pdf.moveDown(1.5).fontSize(8).fillColor('#666');
    if (doc.jofotara_uuid) {
      pdf.text(`JoFotara clearance UUID: ${doc.jofotara_uuid}`);
    } else {
      pdf.text(
        'Not yet cleared by the national e-invoicing system. Until clearance this document is not a valid tax invoice.',
      );
    }

    pdf.end();
    const bytes = await finished;
    return { filename: `${doc.doc_ref ?? 'draft'}.pdf`, bytes };
  }
}
