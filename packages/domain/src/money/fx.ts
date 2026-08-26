import Decimal from 'decimal.js';
import { Money, type RoundingMode } from './money';

/**
 * An exchange rate expressed as "1 unit of `from` buys `rate` units of `to`".
 * The rate itself is a Decimal at full stored precision (NUMERIC(20,10));
 * rounding happens once, when the converted amount is materialised.
 */
export interface ExchangeRate {
  readonly from: string;
  readonly to: string;
  readonly rate: Decimal;
  readonly rateDate: string;
}

export function makeRate(from: string, to: string, rate: Decimal | string | number, rateDate: string): ExchangeRate {
  const dec = new Decimal(rate);
  if (dec.lessThanOrEqualTo(0)) throw new RangeError(`Exchange rate must be positive, got ${dec.toString()}`);
  return { from: from.toUpperCase(), to: to.toUpperCase(), rate: dec, rateDate };
}

/**
 * Convert an amount into the target currency, rounding to the *target*
 * currency's exponent. Converting JOD to USD narrows three decimals to two;
 * converting USD to JOD widens them. Using the source exponent loses fils.
 */
export function convert(amount: Money, rate: ExchangeRate, rounding: RoundingMode = 'half-up'): Money {
  if (amount.currency !== rate.from) {
    throw new TypeError(`Rate is ${rate.from}->${rate.to} but amount is ${amount.currency}`);
  }
  if (amount.currency === rate.to) return amount;

  const value = amount.toDecimal().mul(rate.rate);
  const target = Money.fromMinor(0n, rate.to);
  const scaled = value.mul(new Decimal(10).pow(target.exponent));
  const minor = scaled.toDecimalPlaces(0, roundingToDecimal(rounding));
  return Money.fromMinor(BigInt(minor.toFixed(0)), rate.to);
}

/** The inverse rate, for the reverse leg of a settlement. */
export function invert(rate: ExchangeRate): ExchangeRate {
  return {
    from: rate.to,
    to: rate.from,
    rate: new Decimal(1).div(rate.rate),
    rateDate: rate.rateDate,
  };
}

/**
 * Realised FX gain or loss on settling a foreign-currency balance:
 * the base-currency value at settlement minus the base-currency value at
 * recognition. Positive is a gain (credit), negative a loss (debit).
 */
export function realisedFxDifference(params: {
  foreignAmount: Money;
  rateAtRecognition: ExchangeRate;
  rateAtSettlement: ExchangeRate;
  rounding?: RoundingMode;
}): Money {
  const { foreignAmount, rateAtRecognition, rateAtSettlement, rounding = 'half-up' } = params;
  if (rateAtRecognition.to !== rateAtSettlement.to) {
    throw new TypeError('Both rates must convert into the same base currency');
  }
  const atRecognition = convert(foreignAmount, rateAtRecognition, rounding);
  const atSettlement = convert(foreignAmount, rateAtSettlement, rounding);
  return atSettlement.subtract(atRecognition);
}

function roundingToDecimal(mode: RoundingMode): Decimal.Rounding {
  switch (mode) {
    case 'half-up':
      return Decimal.ROUND_HALF_UP;
    case 'half-even':
      return Decimal.ROUND_HALF_EVEN;
    case 'down':
      return Decimal.ROUND_DOWN;
    case 'up':
      return Decimal.ROUND_UP;
  }
}
