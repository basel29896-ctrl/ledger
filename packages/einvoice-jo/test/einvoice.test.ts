import { describe, expect, it } from 'vitest';
import {
  buildQrPayload,
  buildUblXml,
  createProvider,
  EInvoiceSubmissionError,
  JoFotaraProvider,
  MockJoFotaraProvider,
  toDecimal,
  type EInvoiceDocument,
} from '../src/index';

const invoice: EInvoiceDocument = {
  id: 'doc-1',
  documentNumber: 'INV-2026-00001',
  issueDate: '2026-01-15',
  currency: 'JOD',
  minorUnitExponent: 3,
  documentType: 'invoice',
  supplier: { name: 'Demo Company LLC', taxNumber: '1234567', address: 'Amman', countryCode: 'JO' },
  customer: { name: 'Petra Trading LLC', taxNumber: '7654321', address: 'Irbid' },
  lines: [
    {
      lineNo: 1,
      description: 'Consulting services',
      quantity: '1',
      unitPriceMinor: '1000000',
      netMinor: '1000000',
      taxMinor: '160000',
      taxCode: 'S',
      taxRatePercent: '16',
    },
  ],
  netMinor: '1000000',
  taxMinor: '160000',
  grossMinor: '1160000',
};

describe('minor units to decimal', () => {
  it('writes JOD at three decimal places', () => {
    expect(toDecimal('1160000', 3)).toBe('1160.000');
    expect(toDecimal('1', 3)).toBe('0.001');
  });

  it('writes USD at two and JPY at none', () => {
    expect(toDecimal('9999', 2)).toBe('99.99');
    expect(toDecimal('1500', 0)).toBe('1500');
  });

  it('keeps a negative sign outside the digits', () => {
    expect(toDecimal('-1160000', 3)).toBe('-1160.000');
  });
});

describe('UBL 2.1 document', () => {
  const xml = buildUblXml(invoice);

  it('is a UBL Invoice with the expected namespaces', () => {
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(xml).toContain('<cbc:ID>INV-2026-00001</cbc:ID>');
  });

  it('uses type code 388 for an invoice and 381 for a credit note', () => {
    expect(xml).toContain('>388<');
    const credit = buildUblXml({ ...invoice, documentType: 'credit_note', correctsDocumentNumber: 'INV-2026-00001' });
    expect(credit).toContain('>381<');
    expect(credit).toContain('<cac:BillingReference>');
  });

  it('writes JOD amounts at three decimal places', () => {
    expect(xml).toContain('<cbc:PayableAmount currencyID="JOD">1160.000</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="JOD">160.000</cbc:TaxAmount>');
  });

  it('carries both tax numbers', () => {
    expect(xml).toContain('<cbc:CompanyID>1234567</cbc:CompanyID>');
    expect(xml).toContain('<cbc:CompanyID>7654321</cbc:CompanyID>');
  });

  it('itemises each line with quantity, value and rate', () => {
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="PCE">1</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:Name>Consulting services</cbc:Name>');
    expect(xml).toContain('<cbc:Percent>16</cbc:Percent>');
  });

  it('escapes characters that would break the document', () => {
    const escaped = buildUblXml({
      ...invoice,
      customer: { name: 'Ampersand & <Co>', taxNumber: null },
    });
    expect(escaped).toContain('Ampersand &amp; &lt;Co&gt;');
    expect(escaped).not.toContain('<Co>');
  });
});

describe('QR payload', () => {
  it('is base64 TLV carrying the seller, totals and clearance id', () => {
    const payload = buildQrPayload(invoice, 'clearance-123');
    const decoded = Buffer.from(payload, 'base64');
    expect(decoded[0]).toBe(1); // first tag is the seller name
    const text = decoded.toString('utf8');
    expect(text).toContain('Demo Company LLC');
    expect(text).toContain('1234567');
    expect(text).toContain('1160.000');
    expect(text).toContain('160.000');
    expect(text).toContain('clearance-123');
  });
});

describe('mock provider', () => {
  it('clears an invoice and returns a UUID and QR code', async () => {
    const result = await new MockJoFotaraProvider().submit(invoice);
    expect(result.status).toBe('cleared');
    expect(result.clearanceUuid).toBe('mock-doc-1');
    expect(result.qrCode).toBeTruthy();
    expect(result.isValidTaxDocument).toBe(true);
  });

  it('rejects a B2B invoice with no buyer tax number', async () => {
    const provider = new MockJoFotaraProvider({ rejectWithout: 'buyer_tax_number' });
    const result = await provider.submit({
      ...invoice,
      customer: { name: 'Cash customer', taxNumber: null },
    });
    expect(result.status).toBe('rejected');
    expect(result.isValidTaxDocument).toBe(false);
    expect(result.message).toContain('buyer tax number');
  });

  it('throws a retryable error while the system is unavailable, then succeeds', async () => {
    const provider = new MockJoFotaraProvider({ failTimes: 2 });
    await expect(provider.submit(invoice)).rejects.toThrow(EInvoiceSubmissionError);
    await expect(provider.submit(invoice)).rejects.toMatchObject({ retryable: true });
    const result = await provider.submit(invoice);
    expect(result.status).toBe('cleared');
  });
});

describe('provider selection', () => {
  it('uses the mock when no credentials are configured', () => {
    expect(createProvider({}).name).toBe('jofotara-mock');
  });

  it('uses the real provider when credentials are present', () => {
    const provider = createProvider({
      JOFOTARA_CLIENT_ID: 'id',
      JOFOTARA_SECRET_KEY: 'secret',
    });
    expect(provider.name).toBe('jofotara');
  });

  it('refuses to construct the real provider without credentials', () => {
    expect(() => new JoFotaraProvider({ clientId: '', secretKey: '', endpoint: 'x' })).toThrow(
      /must be set/,
    );
  });
});
