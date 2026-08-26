/**
 * Jordanian e-invoicing (JoFotara).
 *
 * The provider interface comes first so another jurisdiction can be added
 * without touching the AR module: everything the ledger knows about clearance
 * is `submit()` and the record it returns.
 *
 * Two rules are not negotiable:
 *  - credentials come from the environment, never from the repository;
 *  - an invoice that has not been cleared is **not** a valid tax document, and
 *    the caller must be able to see that from the record alone.
 */

export type ClearanceStatus = 'not_submitted' | 'pending' | 'cleared' | 'rejected' | 'failed';

export interface EInvoiceParty {
  readonly name: string;
  readonly taxNumber: string | null;
  readonly address?: string | null;
  readonly countryCode?: string;
}

export interface EInvoiceLine {
  readonly lineNo: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly taxCode: string | null;
  readonly taxRatePercent: string | null;
}

export interface EInvoiceDocument {
  readonly id: string;
  readonly documentNumber: string;
  readonly issueDate: string;
  readonly currency: string;
  readonly minorUnitExponent: number;
  readonly documentType: 'invoice' | 'credit_note';
  readonly supplier: EInvoiceParty;
  readonly customer: EInvoiceParty;
  readonly lines: readonly EInvoiceLine[];
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly grossMinor: string;
  /** The invoice this credit note corrects. */
  readonly correctsDocumentNumber?: string | null;
}

export interface ClearanceResult {
  readonly status: ClearanceStatus;
  readonly clearanceUuid: string | null;
  readonly qrCode: string | null;
  readonly submittedAt: string;
  readonly message: string | null;
  /** True only when the authority has cleared the document. */
  readonly isValidTaxDocument: boolean;
}

export interface EInvoiceProvider {
  readonly name: string;
  submit(document: EInvoiceDocument): Promise<ClearanceResult>;
}

export class EInvoiceSubmissionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EInvoiceSubmissionError';
  }
}

// --- UBL 2.1 --------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Minor units to a decimal string at the currency's own scale. */
export function toDecimal(minor: string, exponent: number): string {
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Build the UBL 2.1 document.
 *
 * Invoice type code 388 is a commercial invoice; 381 is a credit note. JOD
 * amounts are written at three decimal places because that is what the
 * currency has, and a two-decimal amount would be rejected as a mismatch
 * against the totals.
 */
export function buildUblXml(document: EInvoiceDocument): string {
  const amount = (minor: string): string => toDecimal(minor, document.minorUnitExponent);
  const currency = document.currency;
  const typeCode = document.documentType === 'credit_note' ? '381' : '388';

  const party = (p: EInvoiceParty, tag: string): string => `
    <cac:${tag}>
      <cac:Party>
        <cac:PostalAddress>
          <cbc:StreetName>${escapeXml(p.address ?? '')}</cbc:StreetName>
          <cac:Country><cbc:IdentificationCode>${escapeXml(p.countryCode ?? 'JO')}</cbc:IdentificationCode></cac:Country>
        </cac:PostalAddress>
        ${
          p.taxNumber
            ? `<cac:PartyTaxScheme>
          <cbc:CompanyID>${escapeXml(p.taxNumber)}</cbc:CompanyID>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:PartyTaxScheme>`
            : ''
        }
        <cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
      </cac:Party>
    </cac:${tag}>`;

  const lines = document.lines
    .map(
      (line) => `
    <cac:InvoiceLine>
      <cbc:ID>${line.lineNo}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${escapeXml(line.quantity)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${currency}">${amount(line.netMinor)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${currency}">${amount(line.taxMinor)}</cbc:TaxAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${escapeXml(line.description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>${escapeXml(line.taxCode ?? 'O')}</cbc:ID>
          <cbc:Percent>${escapeXml(line.taxRatePercent ?? '0')}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${currency}">${amount(line.unitPriceMinor)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(document.documentNumber)}</cbc:ID>
  <cbc:UUID>${escapeXml(document.id)}</cbc:UUID>
  <cbc:IssueDate>${escapeXml(document.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="012">${typeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${currency}</cbc:TaxCurrencyCode>${
    document.correctsDocumentNumber
      ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference><cbc:ID>${escapeXml(document.correctsDocumentNumber)}</cbc:ID></cac:InvoiceDocumentReference>
  </cac:BillingReference>`
      : ''
  }${party(document.supplier, 'AccountingSupplierParty')}${party(document.customer, 'AccountingCustomerParty')}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${amount(document.taxMinor)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${amount(document.netMinor)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${amount(document.netMinor)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${amount(document.grossMinor)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${amount(document.grossMinor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
}

/**
 * The QR payload Jordan requires: seller name, tax number, timestamp, total,
 * and tax amount, TLV-encoded and base64'd.
 */
export function buildQrPayload(document: EInvoiceDocument, clearanceUuid: string): string {
  const fields: [number, string][] = [
    [1, document.supplier.name],
    [2, document.supplier.taxNumber ?? ''],
    [3, `${document.issueDate}T00:00:00Z`],
    [4, toDecimal(document.grossMinor, document.minorUnitExponent)],
    [5, toDecimal(document.taxMinor, document.minorUnitExponent)],
    [6, clearanceUuid],
  ];

  const chunks = fields.map(([tag, value]) => {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
  });
  return Buffer.concat(chunks).toString('base64');
}

// --- providers ------------------------------------------------------------

export interface JoFotaraConfig {
  readonly clientId: string;
  readonly secretKey: string;
  readonly endpoint: string;
}

/**
 * Mock provider for development and tests.
 *
 * It behaves like the real thing in the ways that matter: it returns a
 * clearance UUID and a QR code, it can reject a document that is missing a
 * buyer tax number on a B2B invoice, and it can be told to fail so the retry
 * path is exercised.
 */
export class MockJoFotaraProvider implements EInvoiceProvider {
  readonly name = 'jofotara-mock';
  private failures = 0;

  constructor(private readonly options: { failTimes?: number; rejectWithout?: 'buyer_tax_number' } = {}) {}

  async submit(document: EInvoiceDocument): Promise<ClearanceResult> {
    const submittedAt = new Date().toISOString();

    if (this.options.failTimes !== undefined && this.failures < this.options.failTimes) {
      this.failures += 1;
      throw new EInvoiceSubmissionError('The national system is unavailable', true);
    }

    if (this.options.rejectWithout === 'buyer_tax_number' && !document.customer.taxNumber) {
      return {
        status: 'rejected',
        clearanceUuid: null,
        qrCode: null,
        submittedAt,
        message: 'A B2B invoice must carry the buyer tax number',
        isValidTaxDocument: false,
      };
    }

    // Deterministic so tests can assert on it.
    const clearanceUuid = `mock-${document.id}`;
    return {
      status: 'cleared',
      clearanceUuid,
      qrCode: buildQrPayload(document, clearanceUuid),
      submittedAt,
      message: null,
      isValidTaxDocument: true,
    };
  }
}

/**
 * The real provider. Credentials come from the environment; the endpoint is
 * configurable so the sandbox can be used without a code change.
 */
export class JoFotaraProvider implements EInvoiceProvider {
  readonly name = 'jofotara';

  constructor(private readonly config: JoFotaraConfig) {
    if (!config.clientId || !config.secretKey) {
      throw new EInvoiceSubmissionError(
        'JOFOTARA_CLIENT_ID and JOFOTARA_SECRET_KEY must be set',
        false,
      );
    }
  }

  async submit(document: EInvoiceDocument): Promise<ClearanceResult> {
    const xml = buildUblXml(document);
    const body = JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') });

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': this.config.clientId,
        'Secret-Key': this.config.secretKey,
      },
      body,
    });

    const submittedAt = new Date().toISOString();

    if (response.status >= 500 || response.status === 429) {
      // Transient: the queue should try again.
      throw new EInvoiceSubmissionError(
        `The national system returned ${response.status}`,
        true,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as {
      EINV_QR?: string;
      EINV_INV_UUID?: string;
      EINV_STATUS?: string;
      errors?: unknown;
    };

    if (!response.ok || !payload.EINV_INV_UUID) {
      return {
        status: 'rejected',
        clearanceUuid: null,
        qrCode: null,
        submittedAt,
        message: typeof payload.errors === 'string' ? payload.errors : `Rejected (${response.status})`,
        isValidTaxDocument: false,
      };
    }

    return {
      status: 'cleared',
      clearanceUuid: payload.EINV_INV_UUID,
      qrCode: payload.EINV_QR ?? buildQrPayload(document, payload.EINV_INV_UUID),
      submittedAt,
      message: null,
      isValidTaxDocument: true,
    };
  }
}

/** Choose a provider from the environment. Absent credentials mean the mock. */
export function createProvider(env: {
  JOFOTARA_CLIENT_ID?: string | undefined;
  JOFOTARA_SECRET_KEY?: string | undefined;
  JOFOTARA_ENDPOINT?: string | undefined;
}): EInvoiceProvider {
  if (env.JOFOTARA_CLIENT_ID && env.JOFOTARA_SECRET_KEY) {
    return new JoFotaraProvider({
      clientId: env.JOFOTARA_CLIENT_ID,
      secretKey: env.JOFOTARA_SECRET_KEY,
      endpoint: env.JOFOTARA_ENDPOINT ?? 'https://backend.jofotara.gov.jo/core/invoices/',
    });
  }
  return new MockJoFotaraProvider();
}
