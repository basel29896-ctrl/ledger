import Decimal from 'decimal.js';
import { Money } from '../money/money';

/**
 * Fixed asset depreciation.
 *
 * Two rules run through all of it: an asset is never depreciated below its
 * residual value, and the total charged over a life equals the depreciable
 * amount exactly — the rounding difference lands in the final period rather
 * than being spread as a fraction of a fil across every one.
 */

export type DepreciationMethod = 'straight_line' | 'reducing_balance' | 'units_of_production';

export class AssetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

export interface AssetTerms {
  currency: string;
  costMinor: string;
  residualMinor: string;
  method: DepreciationMethod;
  usefulLifeMonths: number;
  inServiceDate: string;
  /** Reducing balance only. */
  annualRatePercent?: string;
  /** Units of production only. */
  totalExpectedUnits?: string;
}

export interface ScheduleRow {
  periodNo: number;
  periodEnd: string;
  openingNetBookValueMinor: string;
  chargeMinor: string;
  accumulatedMinor: string;
  closingNetBookValueMinor: string;
}

export interface PeriodCharge {
  chargeMinor: string;
  isFinalCharge: boolean;
}

function round(value: Decimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

function depreciableAmount(terms: AssetTerms): bigint {
  const cost = BigInt(terms.costMinor);
  const residual = BigInt(terms.residualMinor);
  if (residual > cost) {
    throw new AssetError(
      'RESIDUAL_ABOVE_COST',
      `Residual value ${residual} is more than cost ${cost}: there would be nothing to depreciate`,
    );
  }
  return cost - residual;
}

/** The last day of the month `offset` months after the in-service date. */
function periodEnd(inServiceDate: string, offset: number): string {
  const [y, m] = inServiceDate.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + offset + 1, 0));
  return date.toISOString().slice(0, 10);
}

export function depreciationForPeriod(
  terms: AssetTerms,
  state: { accumulatedMinor: string; unitsThisPeriod?: string },
): PeriodCharge {
  const base = depreciableAmount(terms);
  const accumulated = BigInt(state.accumulatedMinor);
  const remaining = base - accumulated;
  if (remaining <= 0n) return { chargeMinor: '0', isFinalCharge: false };

  let charge: bigint;
  switch (terms.method) {
    case 'straight_line': {
      if (terms.usefulLifeMonths <= 0) {
        throw new AssetError('LIFE_NOT_POSITIVE', 'Useful life must be at least one month');
      }
      charge = round(new Decimal(base.toString()).div(terms.usefulLifeMonths));
      break;
    }
    case 'reducing_balance': {
      if (!terms.annualRatePercent) {
        throw new AssetError(
          'RATE_REQUIRED',
          'Reducing balance depreciation needs an annual rate; without one there is no schedule',
        );
      }
      const openingNbv = BigInt(terms.costMinor) - accumulated;
      charge = round(
        new Decimal(openingNbv.toString()).mul(terms.annualRatePercent).div(1200),
      );
      break;
    }
    case 'units_of_production': {
      if (state.unitsThisPeriod === undefined) {
        throw new AssetError(
          'UNITS_REQUIRED',
          'Units of production depreciation needs the units produced in the period',
        );
      }
      if (!terms.totalExpectedUnits || new Decimal(terms.totalExpectedUnits).lessThanOrEqualTo(0)) {
        throw new AssetError(
          'EXPECTED_UNITS_REQUIRED',
          'Units of production depreciation needs the total units the asset is expected to produce',
        );
      }
      charge = round(
        new Decimal(base.toString())
          .mul(state.unitsThisPeriod)
          .div(terms.totalExpectedUnits),
      );
      break;
    }
  }

  // Never past the residual: the last charge is whatever is left, not a full one.
  if (charge >= remaining) return { chargeMinor: remaining.toString(), isFinalCharge: true };
  if (charge < 0n) charge = 0n;
  return { chargeMinor: charge.toString(), isFinalCharge: false };
}

/**
 * The whole life, month by month. Units of production has no schedule to build
 * in advance — it depends on what the asset actually produces.
 */
export function buildDepreciationSchedule(terms: AssetTerms): ScheduleRow[] {
  if (terms.method === 'units_of_production') {
    throw new AssetError(
      'NO_SCHEDULE_FOR_UNITS',
      'A units of production asset has no schedule in advance: the charge follows actual output',
    );
  }
  if (terms.method === 'reducing_balance' && !terms.annualRatePercent) {
    throw new AssetError(
      'RATE_REQUIRED',
      'Reducing balance depreciation needs an annual rate; without one there is no schedule',
    );
  }
  const base = depreciableAmount(terms);
  const cost = BigInt(terms.costMinor);

  const rows: ScheduleRow[] = [];
  let accumulated = 0n;

  for (let month = 0; month < terms.usefulLifeMonths; month += 1) {
    const opening = cost - accumulated;
    const isLastMonth = month === terms.usefulLifeMonths - 1;
    let charge = BigInt(
      depreciationForPeriod(terms, { accumulatedMinor: accumulated.toString() }).chargeMinor,
    );
    /*
     * Straight line must land exactly on the residual: the final month absorbs
     * whatever the even monthly charge left behind.
     */
    if (isLastMonth && terms.method === 'straight_line') charge = base - accumulated;
    if (charge < 0n) charge = 0n;

    accumulated += charge;
    rows.push({
      periodNo: month + 1,
      periodEnd: periodEnd(terms.inServiceDate, month),
      openingNetBookValueMinor: opening.toString(),
      chargeMinor: charge.toString(),
      accumulatedMinor: accumulated.toString(),
      closingNetBookValueMinor: (cost - accumulated).toString(),
    });
  }

  return rows;
}

export interface DisposalResult {
  netBookValue: ReturnType<Money['toJSON']>;
  proceeds: ReturnType<Money['toJSON']>;
  gainOrLoss: ReturnType<Money['toJSON']>;
  isGain: boolean;
}

/**
 * Disposal: cost and accumulated depreciation both come off the books in full,
 * and the difference between the proceeds and what was left is the gain or loss.
 */
export function disposalResult(params: {
  currency: string;
  costMinor: string;
  accumulatedMinor: string;
  proceedsMinor: string;
}): DisposalResult {
  const cost = Money.fromMinor(params.costMinor, params.currency);
  const accumulated = Money.fromMinor(params.accumulatedMinor, params.currency);
  if (accumulated.compare(cost) > 0) {
    throw new AssetError(
      'ACCUMULATED_ABOVE_COST',
      `Accumulated depreciation ${accumulated.toString()} exceeds cost ${cost.toString()}: ` +
        `the register is inconsistent and the disposal would post a false gain`,
    );
  }
  const netBookValue = cost.subtract(accumulated);
  const proceeds = Money.fromMinor(params.proceedsMinor, params.currency);
  const gainOrLoss = proceeds.subtract(netBookValue);

  return {
    netBookValue: netBookValue.toJSON(),
    proceeds: proceeds.toJSON(),
    gainOrLoss: gainOrLoss.toJSON(),
    isGain: !gainOrLoss.isNegative(),
  };
}
