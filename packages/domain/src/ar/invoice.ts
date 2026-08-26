import Decimal from 'decimal.js';
import { Money, type RoundingMode } from '../money/money';

/**
 * Invoice arithmetic.
 *
 * Tax is computed per line and rounded once per line, not once per document:
 * a document-level rounding hides which line the fils came from, and a tax
 * authority reconciles line by line.
 */

export interface TaxRate {
  readonly code: string;
  /** Percent, e.g. 16 for Jordan general sales tax. */
  readonly ratePercent: Decimal;
}

export interface InvoiceLineInput {
  readonly quantity: Decimal | string | number;
  readonly unitPriceMinor: bigint;
  readonly taxRate?: TaxRate | undefined;
  /** True when the unit price already includes tax. */
  readonly taxInclusive?: boolean | undefined;
}

export interface CalculatedLine {
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly grossMinor: bigint;
  readonly taxCode: string | null;
}

export interface CalculatedInvoice {
  readonly lines: readonly CalculatedLine[];
  readonly subtotalMinor: bigint;
  readonly taxTotalMinor: bigint;
  readonly totalMinor: bigint;
  /** Net and tax per tax code, for the tax return. */
  readonly taxByCode: ReadonlyMap<string, { netMinor: bigint; taxMinor: bigint }>;
}

export function calculateLine(
  line: InvoiceLineInput,
  currency: string,
  rounding: RoundingMode = 'half-up',
): CalculatedLine {
  const quantity = new Decimal(line.quantity);
  if (quantity.lessThanOrEqualTo(0)) throw new RangeError('Quantity must be greater than zero');

  const extended = Money.fromMinor(line.unitPriceMinor, currency).multiply(quantity, rounding);
  const rate = line.taxRate?.ratePercent ?? new Decimal(0);
  const taxCode = line.taxRate?.code ?? null;

  if (line.taxInclusive && rate.greaterThan(0)) {
    // gross = net * (1 + r)  =>  net = gross / (1 + r)
    const divisor = new Decimal(1).plus(rate.div(100));
    const net = extended.multiply(new Decimal(1).div(divisor), rounding);
    const tax = extended.subtract(net);
    return { netMinor: net.minor, taxMinor: tax.minor, grossMinor: extended.minor, taxCode };
  }

  const tax = extended.multiply(rate.div(100), rounding);
  return {
    netMinor: extended.minor,
    taxMinor: tax.minor,
    grossMinor: extended.add(tax).minor,
    taxCode,
  };
}

export function calculateInvoice(
  lines: readonly InvoiceLineInput[],
  currency: string,
  rounding: RoundingMode = 'half-up',
): CalculatedInvoice {
  if (lines.length === 0) throw new RangeError('An invoice needs at least one line');

  const calculated = lines.map((line) => calculateLine(line, currency, rounding));
  const taxByCode = new Map<string, { netMinor: bigint; taxMinor: bigint }>();

  let subtotal = 0n;
  let taxTotal = 0n;
  for (const line of calculated) {
    subtotal += line.netMinor;
    taxTotal += line.taxMinor;
    const key = line.taxCode ?? '(none)';
    const bucket = taxByCode.get(key) ?? { netMinor: 0n, taxMinor: 0n };
    taxByCode.set(key, {
      netMinor: bucket.netMinor + line.netMinor,
      taxMinor: bucket.taxMinor + line.taxMinor,
    });
  }

  return {
    lines: calculated,
    subtotalMinor: subtotal,
    taxTotalMinor: taxTotal,
    totalMinor: subtotal + taxTotal,
    taxByCode,
  };
}

/** Net days from the issue date, as an ISO date. */
export function dueDateFor(issueDate: string, termsDays: number): string {
  if (!Number.isInteger(termsDays) || termsDays < 0) {
    throw new RangeError(`Payment terms must be a non-negative whole number of days, got ${termsDays}`);
  }
  const date = new Date(`${issueDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid issue date: ${issueDate}`);
  date.setUTCDate(date.getUTCDate() + termsDays);
  return date.toISOString().slice(0, 10);
}
