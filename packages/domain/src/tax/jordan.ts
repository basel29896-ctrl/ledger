import Decimal from 'decimal.js';
import type { TaxCodeDefinition } from './tax-engine';

/**
 * Jordan tax codes.
 *
 * General Sales Tax has a standard rate of 16% with reduced rates on specified
 * goods and services, a 24% rate on specified telecommunication services, and
 * zero-rated and exempt categories that must be reported separately even though
 * both charge nothing.
 *
 * Special Sales Tax is an excise charged *on top of* the value on tobacco,
 * alcohol, vehicles, fuel, oils and cement. General Sales Tax is then charged
 * on the value plus that excise, which is why the GST codes here declare
 * `compoundOn: ['SST']`.
 *
 * Rates change by regulation. These are seed values, editable per tenant, not
 * constants of the system.
 */

export const JORDAN_SPECIAL_SALES_TAX: TaxCodeDefinition = {
  code: 'SST',
  name: 'Special Sales Tax (excise)',
  ratePercent: new Decimal(0),
  kind: 'both',
  treatment: 'standard',
};

function gst(rate: number, code: string, name: string): TaxCodeDefinition {
  return {
    code,
    name,
    ratePercent: new Decimal(rate),
    kind: 'both',
    isRecoverable: true,
    treatment: 'standard',
  };
}

export const JORDAN_TAX_CODES: readonly TaxCodeDefinition[] = [
  gst(16, 'GST16', 'General Sales Tax — standard 16%'),
  gst(10, 'GST10', 'General Sales Tax — reduced 10%'),
  gst(5, 'GST5', 'General Sales Tax — reduced 5%'),
  gst(4, 'GST4', 'General Sales Tax — reduced 4%'),
  gst(2, 'GST2', 'General Sales Tax — reduced 2%'),
  gst(1, 'GST1', 'General Sales Tax — reduced 1%'),
  gst(24, 'GST24', 'General Sales Tax — telecommunications 24%'),
  {
    code: 'GST0',
    name: 'Zero-rated (exports, free and development zones)',
    ratePercent: new Decimal(0),
    kind: 'both',
    isRecoverable: true,
    treatment: 'zero_rated',
  },
  {
    code: 'EXEMPT',
    name: 'Exempt supplies',
    ratePercent: new Decimal(0),
    kind: 'both',
    // Input tax attributable to exempt supplies cannot be reclaimed.
    isRecoverable: false,
    treatment: 'exempt',
  },
  {
    code: 'WHT5',
    name: 'Withholding tax 5%',
    ratePercent: new Decimal(5),
    kind: 'purchase',
    isWithholding: true,
    treatment: 'standard',
  },
];

/** Excise rates for the goods the Special Sales Tax applies to. */
export const JORDAN_SPECIAL_SALES_TAX_CATEGORIES: readonly {
  code: string;
  name: string;
  ratePercent: number;
}[] = [
  { code: 'SST-TOBACCO', name: 'Special Sales Tax — tobacco', ratePercent: 0 },
  { code: 'SST-ALCOHOL', name: 'Special Sales Tax — alcohol', ratePercent: 0 },
  { code: 'SST-VEHICLES', name: 'Special Sales Tax — vehicles', ratePercent: 0 },
  { code: 'SST-FUEL', name: 'Special Sales Tax — fuel', ratePercent: 0 },
  { code: 'SST-OILS', name: 'Special Sales Tax — oils', ratePercent: 0 },
  { code: 'SST-CEMENT', name: 'Special Sales Tax — cement', ratePercent: 0 },
];

/**
 * Build a GST code that compounds on a Special Sales Tax category — the
 * ordering that makes GST fall on the value plus the excise.
 */
export function jordanCompoundGst(
  gstCode: TaxCodeDefinition,
  sstCode: string,
): TaxCodeDefinition {
  return { ...gstCode, compoundOn: [sstCode] };
}
