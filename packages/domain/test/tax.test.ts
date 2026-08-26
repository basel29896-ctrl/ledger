import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  buildTaxReturn,
  calculateTaxedLine,
  JORDAN_TAX_CODES,
  jordanCompoundGst,
  orderTaxCodes,
  TaxConfigurationError,
  type TaxCodeDefinition,
} from '../src/index';

const byCode = (code: string): TaxCodeDefinition =>
  JORDAN_TAX_CODES.find((c) => c.code === code)!;

const GST16 = byCode('GST16');
const GST24 = byCode('GST24');
const GST0 = byCode('GST0');
const EXEMPT = byCode('EXEMPT');
const WHT5 = byCode('WHT5');

describe('Jordan tax codes', () => {
  it('carries the standard, reduced and telecom rates', () => {
    expect(GST16.ratePercent.toNumber()).toBe(16);
    expect(GST24.ratePercent.toNumber()).toBe(24);
    for (const rate of [1, 2, 4, 5, 10]) {
      expect(byCode(`GST${rate}`).ratePercent.toNumber()).toBe(rate);
    }
  });

  it('separates zero-rated from exempt', () => {
    expect(GST0.treatment).toBe('zero_rated');
    expect(EXEMPT.treatment).toBe('exempt');
    // Input tax attributable to exempt supplies is not recoverable.
    expect(GST0.isRecoverable).toBe(true);
    expect(EXEMPT.isRecoverable).toBe(false);
  });

  it('marks withholding tax as withheld, not charged', () => {
    expect(WHT5.isWithholding).toBe(true);
  });
});

describe('simple tax', () => {
  it('charges 16% on a JOD line to three decimals', () => {
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 1_000_000n, taxCodes: [GST16] },
      'JOD',
    );
    expect(line.netMinor).toBe(1_000_000n);
    expect(line.taxTotalMinor).toBe(160_000n);
    expect(line.grossMinor).toBe(1_160_000n);
  });

  it('charges 24% on telecommunications', () => {
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 100_000n, taxCodes: [GST24] },
      'JOD',
    );
    expect(line.taxTotalMinor).toBe(24_000n);
  });

  it('charges nothing on zero-rated and exempt lines', () => {
    for (const code of [GST0, EXEMPT]) {
      const line = calculateTaxedLine(
        { quantity: 1, unitPriceMinor: 500_000n, taxCodes: [code] },
        'JOD',
      );
      expect(line.taxTotalMinor).toBe(0n);
      expect(line.grossMinor).toBe(500_000n);
    }
  });

  it('applies a discount before tax', () => {
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 1_000_000n, discountMinor: 100_000n, taxCodes: [GST16] },
      'JOD',
    );
    expect(line.netMinor).toBe(900_000n);
    expect(line.taxTotalMinor).toBe(144_000n);
  });

  it('refuses a discount larger than the line', () => {
    expect(() =>
      calculateTaxedLine(
        { quantity: 1, unitPriceMinor: 1_000n, discountMinor: 2_000n, taxCodes: [] },
        'JOD',
      ),
    ).toThrow(RangeError);
  });

  it('rounds to the fil, never below it', () => {
    // 0.333 JOD at 16% = 0.05328 -> 0.053
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 333n, taxCodes: [GST16] },
      'JOD',
    );
    expect(line.taxTotalMinor).toBe(53n);
    expect(line.netMinor + line.taxTotalMinor).toBe(line.grossMinor);
  });
});

describe('tax-inclusive pricing', () => {
  it('backs 16% out of an inclusive price', () => {
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 1_160_000n, taxCodes: [GST16], taxInclusive: true },
      'JOD',
    );
    expect(line.netMinor).toBe(1_000_000n);
    expect(line.taxTotalMinor).toBe(160_000n);
    expect(line.grossMinor).toBe(1_160_000n);
  });

  it('keeps net plus tax equal to the stated inclusive price', () => {
    for (const price of [1n, 99n, 12_345n, 1_000_001n]) {
      const line = calculateTaxedLine(
        { quantity: 1, unitPriceMinor: price, taxCodes: [GST16], taxInclusive: true },
        'JOD',
      );
      expect(line.grossMinor).toBe(line.netMinor + line.taxTotalMinor);
    }
  });
});

describe('compound tax — Special Sales Tax then General Sales Tax', () => {
  const SST20: TaxCodeDefinition = {
    code: 'SST-TOBACCO',
    name: 'Special Sales Tax — tobacco',
    ratePercent: new Decimal(20),
    kind: 'both',
  };
  const GST_ON_SST = jordanCompoundGst(GST16, 'SST-TOBACCO');

  it('charges GST on the value plus the excise, not on the value alone', () => {
    // 100.000 value, 20% SST = 20.000, GST 16% on 120.000 = 19.200.
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 100_000n, taxCodes: [SST20, GST_ON_SST] },
      'JOD',
    );
    const sst = line.taxComponents.find((c) => c.code === 'SST-TOBACCO');
    const gst = line.taxComponents.find((c) => c.code === 'GST16');
    expect(sst?.amountMinor).toBe(20_000n);
    expect(gst?.baseMinor).toBe(120_000n);
    expect(gst?.amountMinor).toBe(19_200n);
    expect(line.taxTotalMinor).toBe(39_200n);
    expect(line.grossMinor).toBe(139_200n);
  });

  it('computes the compound tax after the tax it sits on, whatever the input order', () => {
    const reversed = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 100_000n, taxCodes: [GST_ON_SST, SST20] },
      'JOD',
    );
    expect(reversed.taxTotalMinor).toBe(39_200n);
  });

  it('refuses a compound tax whose base is not applied to the line', () => {
    expect(() =>
      calculateTaxedLine(
        { quantity: 1, unitPriceMinor: 100_000n, taxCodes: [GST_ON_SST] },
        'JOD',
      ),
    ).toThrow(TaxConfigurationError);
  });

  it('refuses a cycle rather than looping forever', () => {
    const a: TaxCodeDefinition = { code: 'A', name: 'A', ratePercent: new Decimal(1), kind: 'both', compoundOn: ['B'] };
    const b: TaxCodeDefinition = { code: 'B', name: 'B', ratePercent: new Decimal(1), kind: 'both', compoundOn: ['A'] };
    expect(() => orderTaxCodes([a, b])).toThrow(/cycle/);
  });
});

describe('withholding tax', () => {
  it('is deducted from the payment, not added to the invoice', () => {
    const line = calculateTaxedLine(
      { quantity: 1, unitPriceMinor: 1_000_000n, taxCodes: [GST16, WHT5] },
      'JOD',
    );
    expect(line.taxTotalMinor).toBe(160_000n);
    expect(line.withholdingMinor).toBe(50_000n);
    // The customer owes the gross; the supplier receives gross minus withholding.
    expect(line.grossMinor).toBe(1_160_000n);
  });
});

describe('tax return', () => {
  const period = { fromDate: '2026-01-01', toDate: '2026-01-31', currency: 'JOD' };

  it('separates standard, zero-rated and exempt sales', () => {
    const result = buildTaxReturn(
      [
        { taxCode: 'GST16', treatment: 'standard', direction: 'output', netMinor: 1_000_000n, taxMinor: 160_000n },
        { taxCode: 'GST0', treatment: 'zero_rated', direction: 'output', netMinor: 500_000n, taxMinor: 0n },
        { taxCode: 'EXEMPT', treatment: 'exempt', direction: 'output', netMinor: 250_000n, taxMinor: 0n },
      ],
      period,
    );
    expect(result.standardRatedSales.netMinor).toBe(1_000_000n);
    expect(result.zeroRatedSales.netMinor).toBe(500_000n);
    expect(result.exemptSales.netMinor).toBe(250_000n);
    expect(result.totalSales.netMinor).toBe(1_750_000n);
    expect(result.outputTaxMinor).toBe(160_000n);
  });

  it('nets recoverable input tax against output tax', () => {
    const result = buildTaxReturn(
      [
        { taxCode: 'GST16', treatment: 'standard', direction: 'output', netMinor: 1_000_000n, taxMinor: 160_000n },
        { taxCode: 'GST16', treatment: 'standard', direction: 'input', netMinor: 400_000n, taxMinor: 64_000n, isRecoverable: true },
      ],
      period,
    );
    expect(result.recoverableInputTaxMinor).toBe(64_000n);
    expect(result.netPayableMinor).toBe(96_000n);
  });

  it('excludes irrecoverable input tax from the claim but still reports it', () => {
    const result = buildTaxReturn(
      [
        { taxCode: 'GST16', treatment: 'standard', direction: 'output', netMinor: 1_000_000n, taxMinor: 160_000n },
        { taxCode: 'EXEMPT', treatment: 'exempt', direction: 'input', netMinor: 100_000n, taxMinor: 16_000n, isRecoverable: false },
      ],
      period,
    );
    expect(result.irrecoverableInputTaxMinor).toBe(16_000n);
    expect(result.recoverableInputTaxMinor).toBe(0n);
    expect(result.netPayableMinor).toBe(160_000n);
  });

  it('can produce a refund position', () => {
    const result = buildTaxReturn(
      [
        { taxCode: 'GST16', treatment: 'standard', direction: 'output', netMinor: 100_000n, taxMinor: 16_000n },
        { taxCode: 'GST16', treatment: 'standard', direction: 'input', netMinor: 1_000_000n, taxMinor: 160_000n, isRecoverable: true },
      ],
      period,
    );
    expect(result.netPayableMinor).toBe(-144_000n);
  });

  it('breaks the figures down by tax code', () => {
    const result = buildTaxReturn(
      [
        { taxCode: 'GST16', treatment: 'standard', direction: 'output', netMinor: 1_000_000n, taxMinor: 160_000n },
        { taxCode: 'GST24', treatment: 'standard', direction: 'output', netMinor: 100_000n, taxMinor: 24_000n },
      ],
      period,
    );
    const codes = result.byCode.map((b) => b.code).sort();
    expect(codes).toEqual(['GST16', 'GST24']);
  });

  it('is empty and zero for a period with no activity', () => {
    const result = buildTaxReturn([], period);
    expect(result.netPayableMinor).toBe(0n);
    expect(result.totalSales.netMinor).toBe(0n);
  });
});
