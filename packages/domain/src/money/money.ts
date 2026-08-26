import Decimal from 'decimal.js';
import { minorUnitExponent } from '@acct/shared';

export type RoundingMode = 'half-up' | 'half-even' | 'down' | 'up';

const DECIMAL_ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  'half-up': Decimal.ROUND_HALF_UP,
  'half-even': Decimal.ROUND_HALF_EVEN,
  down: Decimal.ROUND_DOWN,
  up: Decimal.ROUND_UP,
};

/**
 * An exact monetary amount, held as a signed count of minor units plus its
 * currency. The scale comes from the currency, never from a constant: JOD has
 * three minor digits, JPY none, and assuming two silently truncates fils.
 *
 * Money is immutable and never round-trips through a JS number.
 */
export class Money {
  readonly minor: bigint;
  readonly currency: string;
  readonly exponent: number;

  private constructor(minor: bigint, currency: string, exponent: number) {
    this.minor = minor;
    this.currency = currency;
    this.exponent = exponent;
  }

  /** Build from a raw minor-unit count, e.g. 1160000 fils = JOD 1160.000. */
  static fromMinor(minor: bigint | number | string, currency: string): Money {
    const code = currency.toUpperCase();
    const asBigInt = typeof minor === 'bigint' ? minor : BigInt(minor);
    return new Money(asBigInt, code, minorUnitExponent(code));
  }

  /**
   * Build from a decimal string such as "1160.000". The literal must not carry
   * more precision than the currency allows — silently dropping a digit here is
   * how a tax return drifts, so it is rejected instead.
   */
  static fromDecimal(value: string | number | Decimal, currency: string): Money {
    const code = currency.toUpperCase();
    const exponent = minorUnitExponent(code);
    const dec = new Decimal(value);
    const scaled = dec.mul(new Decimal(10).pow(exponent));
    if (!scaled.isInteger()) {
      throw new RangeError(
        `Amount ${dec.toString()} has more precision than ${code} allows (${exponent} decimal places)`,
      );
    }
    return new Money(BigInt(scaled.toFixed(0)), code, exponent);
  }

  static zero(currency: string): Money {
    return Money.fromMinor(0n, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency, this.exponent);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency, this.exponent);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency, this.exponent);
  }

  abs(): Money {
    return new Money(this.minor < 0n ? -this.minor : this.minor, this.currency, this.exponent);
  }

  /**
   * Multiply by an exact ratio (a tax rate, a depreciation fraction) and round
   * back to whole minor units. Rounding is explicit because the direction is a
   * jurisdictional decision, not an implementation detail.
   */
  multiply(factor: Decimal | string | number, rounding: RoundingMode = 'half-up'): Money {
    const product = new Decimal(this.minor.toString()).mul(new Decimal(factor));
    const rounded = product.toDecimalPlaces(0, DECIMAL_ROUNDING[rounding]);
    return new Money(BigInt(rounded.toFixed(0)), this.currency, this.exponent);
  }

  /**
   * Split into `parts` shares that sum back to exactly this amount.
   * Remainder minor units are handed out one each from the first share
   * (largest-remainder), so nothing is created or destroyed by rounding.
   */
  allocateEvenly(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new RangeError(`parts must be a positive integer, got ${parts}`);
    }
    return this.allocate(new Array<number>(parts).fill(1));
  }

  /** Split proportionally to non-negative weights, preserving the total exactly. */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) throw new RangeError('weights must not be empty');
    if (weights.some((w) => w < 0)) throw new RangeError('weights must be non-negative');
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) throw new RangeError('weights must not sum to zero');

    const sign = this.minor < 0n ? -1n : 1n;
    const magnitude = this.minor < 0n ? -this.minor : this.minor;

    const shares: bigint[] = [];
    let allocated = 0n;
    for (const weight of weights) {
      const share = (magnitude * BigInt(Math.round(weight * 1e9))) / BigInt(Math.round(total * 1e9));
      shares.push(share);
      allocated += share;
    }
    let remainder = magnitude - allocated;
    for (let i = 0; remainder > 0n; i = (i + 1) % shares.length, remainder -= 1n) {
      shares[i] = (shares[i] ?? 0n) + 1n;
    }
    return shares.map((s) => new Money(s * sign, this.currency, this.exponent));
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  toDecimal(): Decimal {
    return new Decimal(this.minor.toString()).div(new Decimal(10).pow(this.exponent));
  }

  /** Fixed-precision decimal string, e.g. "1160.000" for JOD. */
  toString(): string {
    return this.toDecimal().toFixed(this.exponent);
  }

  /** Wire shape used by every API response. Amounts are strings, never floats. */
  toJSON(): { amount: string; minor: string; currency: string } {
    return { amount: this.toString(), minor: this.minor.toString(), currency: this.currency };
  }

  static sum(amounts: readonly Money[], currency: string): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }
}
