import { describe, expect, it } from 'vitest';
import {
  buildDepreciationSchedule,
  depreciationForPeriod,
  disposalResult,
  AssetError,
  type AssetTerms,
} from '../src/assets/depreciation';

const straightLine: AssetTerms = {
  currency: 'JOD',
  costMinor: '12000000', // 12,000.000
  residualMinor: '0',
  method: 'straight_line',
  usefulLifeMonths: 60,
  inServiceDate: '2026-01-01',
};

describe('straight line', () => {
  const schedule = buildDepreciationSchedule(straightLine);

  it('spreads the cost evenly over the life', () => {
    expect(schedule).toHaveLength(60);
    expect(schedule[0]?.chargeMinor).toBe('200000'); // 200.000 a month
    expect(schedule[0]?.periodEnd).toBe('2026-01-31');
  });

  it('depreciates to exactly the residual, never past it', () => {
    const last = schedule[schedule.length - 1]!;
    expect(last.closingNetBookValueMinor).toBe('0');
    const total = schedule.reduce((sum, row) => sum + BigInt(row.chargeMinor), 0n);
    expect(total.toString()).toBe('12000000');
  });

  it('stops at the residual value rather than writing the asset to zero', () => {
    const withResidual = buildDepreciationSchedule({ ...straightLine, residualMinor: '2400000' });
    const total = withResidual.reduce((sum, row) => sum + BigInt(row.chargeMinor), 0n);
    expect(total.toString()).toBe('9600000');
    expect(withResidual[withResidual.length - 1]?.closingNetBookValueMinor).toBe('2400000');
  });

  it('puts the rounding difference in the final period, not in every one', () => {
    // 1,000.000 over 7 months does not divide evenly.
    const odd = buildDepreciationSchedule({
      ...straightLine,
      costMinor: '1000000',
      usefulLifeMonths: 7,
    });
    const total = odd.reduce((sum, row) => sum + BigInt(row.chargeMinor), 0n);
    expect(total.toString()).toBe('1000000');
    expect(new Set(odd.slice(0, 6).map((r) => r.chargeMinor)).size).toBe(1);
  });
});

describe('reducing balance', () => {
  const schedule = buildDepreciationSchedule({
    ...straightLine,
    method: 'reducing_balance',
    annualRatePercent: '20',
    usefulLifeMonths: 24,
  });

  it('charges on the written-down value, so the charge falls each year', () => {
    const firstYear = schedule.slice(0, 12).reduce((s, r) => s + BigInt(r.chargeMinor), 0n);
    const secondYear = schedule.slice(12, 24).reduce((s, r) => s + BigInt(r.chargeMinor), 0n);
    expect(firstYear).toBeGreaterThan(secondYear);
  });

  it('never takes the asset below its residual', () => {
    const withResidual = buildDepreciationSchedule({
      ...straightLine,
      method: 'reducing_balance',
      annualRatePercent: '50',
      usefulLifeMonths: 60,
      residualMinor: '1000000',
    });
    for (const row of withResidual) {
      expect(BigInt(row.closingNetBookValueMinor)).toBeGreaterThanOrEqual(1000000n);
    }
  });

  it('requires a rate: a reducing balance with no rate is not a schedule', () => {
    expect(() =>
      buildDepreciationSchedule({ ...straightLine, method: 'reducing_balance' }),
    ).toThrow(AssetError);
  });
});

describe('units of production', () => {
  it('charges in proportion to what the asset actually produced', () => {
    const charge = depreciationForPeriod(
      { ...straightLine, method: 'units_of_production', totalExpectedUnits: '100000' },
      { accumulatedMinor: '0', unitsThisPeriod: '5000' },
    );
    // 5% of the units, so 5% of the depreciable amount.
    expect(charge.chargeMinor).toBe('600000');
  });

  it('refuses to charge without a unit count for the period', () => {
    expect(() =>
      depreciationForPeriod(
        { ...straightLine, method: 'units_of_production', totalExpectedUnits: '100000' },
        { accumulatedMinor: '0' },
      ),
    ).toThrow(/units/i);
  });
});

describe('period charge', () => {
  it('never charges more than is left to depreciate', () => {
    const charge = depreciationForPeriod(straightLine, { accumulatedMinor: '11900000' });
    expect(charge.chargeMinor).toBe('100000');
    expect(charge.isFinalCharge).toBe(true);
  });

  it('charges nothing on a fully depreciated asset', () => {
    const charge = depreciationForPeriod(straightLine, { accumulatedMinor: '12000000' });
    expect(charge.chargeMinor).toBe('0');
  });
});

describe('disposal', () => {
  it('reports a gain when the proceeds beat the written-down value', () => {
    const result = disposalResult({
      currency: 'JOD',
      costMinor: '12000000',
      accumulatedMinor: '10000000',
      proceedsMinor: '2500000',
    });
    expect(result.netBookValue.amount).toBe('2000.000');
    expect(result.gainOrLoss.amount).toBe('500.000');
    expect(result.isGain).toBe(true);
  });

  it('reports a loss when they do not', () => {
    const result = disposalResult({
      currency: 'JOD',
      costMinor: '12000000',
      accumulatedMinor: '10000000',
      proceedsMinor: '1500000',
    });
    expect(result.gainOrLoss.amount).toBe('-500.000');
    expect(result.isGain).toBe(false);
  });

  it('writes off cost and accumulated depreciation in full', () => {
    const result = disposalResult({
      currency: 'JOD',
      costMinor: '12000000',
      accumulatedMinor: '12000000',
      proceedsMinor: '0',
    });
    expect(result.netBookValue.amount).toBe('0.000');
    expect(result.gainOrLoss.amount).toBe('0.000');
  });

  it('refuses accumulated depreciation greater than cost', () => {
    expect(() =>
      disposalResult({
        currency: 'JOD',
        costMinor: '1000',
        accumulatedMinor: '2000',
        proceedsMinor: '0',
      }),
    ).toThrow(AssetError);
  });
});
