import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { Money } from '../src/money/money';

describe('Money construction', () => {
  it('keeps three decimal places for JOD', () => {
    const m = Money.fromDecimal('1160.125', 'JOD');
    expect(m.minor).toBe(1160125n);
    expect(m.exponent).toBe(3);
    expect(m.toString()).toBe('1160.125');
  });

  it('keeps two decimal places for USD', () => {
    expect(Money.fromDecimal('99.99', 'USD').minor).toBe(9999n);
  });

  it('keeps zero decimal places for JPY', () => {
    const m = Money.fromDecimal('1500', 'JPY');
    expect(m.minor).toBe(1500n);
    expect(m.toString()).toBe('1500');
  });

  it('rejects precision the currency cannot represent instead of truncating', () => {
    expect(() => Money.fromDecimal('1.005', 'USD')).toThrow(RangeError);
    expect(() => Money.fromDecimal('1.0005', 'JOD')).toThrow(RangeError);
  });

  it('rejects unknown currency codes', () => {
    expect(() => Money.fromMinor(1n, 'XXX')).toThrow(/Unknown currency/);
  });

  it('round-trips a JOD amount through minor units without drift', () => {
    const original = '12345.678';
    expect(Money.fromDecimal(original, 'JOD').toString()).toBe(original);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.fromDecimal('0.001', 'JOD');
    const b = Money.fromDecimal('0.002', 'JOD');
    expect(a.add(b).toString()).toBe('0.003');
    expect(b.subtract(a).toString()).toBe('0.001');
  });

  it('does not exhibit binary floating point error', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE 754; in minor units it is exact.
    const total = Money.fromDecimal('0.10', 'USD').add(Money.fromDecimal('0.20', 'USD'));
    expect(total.toString()).toBe('0.30');
    expect(total.equals(Money.fromDecimal('0.30', 'USD'))).toBe(true);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.fromMinor(1n, 'JOD').add(Money.fromMinor(1n, 'USD'))).toThrow(TypeError);
  });

  it('sums a large list without loss', () => {
    const cents = Array.from({ length: 10_000 }, () => Money.fromDecimal('0.01', 'USD'));
    expect(Money.sum(cents, 'USD').toString()).toBe('100.00');
  });
});

describe('Money rounding', () => {
  it('rounds half up by default', () => {
    // 16% General Sales Tax on JOD 1.005 = 0.1608 -> 0.161
    expect(Money.fromDecimal('1.005', 'JOD').multiply('0.16').toString()).toBe('0.161');
  });

  it('supports banker rounding when asked', () => {
    expect(Money.fromMinor(5n, 'USD').multiply('0.5', 'half-even').minor).toBe(2n);
    expect(Money.fromMinor(7n, 'USD').multiply('0.5', 'half-even').minor).toBe(4n);
  });

  it('truncates with rounding mode down', () => {
    expect(Money.fromMinor(199n, 'USD').multiply('0.5', 'down').minor).toBe(99n);
  });

  it('accepts a Decimal factor at full precision', () => {
    const rate = new Decimal(1).div(3);
    expect(Money.fromDecimal('300.000', 'JOD').multiply(rate).toString()).toBe('100.000');
  });
});

describe('Money allocation', () => {
  it('splits without creating or destroying minor units', () => {
    const parts = Money.fromDecimal('0.10', 'USD').allocateEvenly(3);
    expect(parts.map((p) => p.toString())).toEqual(['0.04', '0.03', '0.03']);
    expect(Money.sum(parts, 'USD').toString()).toBe('0.10');
  });

  it('splits a JOD amount across three decimals', () => {
    const parts = Money.fromDecimal('1.000', 'JOD').allocateEvenly(3);
    expect(parts.map((p) => p.toString())).toEqual(['0.334', '0.333', '0.333']);
    expect(Money.sum(parts, 'JOD').toString()).toBe('1.000');
  });

  it('allocates by weights and still preserves the total', () => {
    const parts = Money.fromDecimal('100.00', 'USD').allocate([1, 1, 2]);
    expect(Money.sum(parts, 'USD').toString()).toBe('100.00');
    expect(parts[2]?.toString()).toBe('50.00');
  });

  it('preserves the total for negative amounts', () => {
    const parts = Money.fromDecimal('-0.10', 'USD').allocateEvenly(3);
    expect(Money.sum(parts, 'USD').toString()).toBe('-0.10');
  });

  it('rejects nonsensical splits', () => {
    expect(() => Money.fromMinor(1n, 'USD').allocateEvenly(0)).toThrow(RangeError);
    expect(() => Money.fromMinor(1n, 'USD').allocate([])).toThrow(RangeError);
    expect(() => Money.fromMinor(1n, 'USD').allocate([0, 0])).toThrow(RangeError);
    expect(() => Money.fromMinor(1n, 'USD').allocate([-1, 2])).toThrow(RangeError);
  });
});

describe('Money comparison and serialisation', () => {
  it('compares within a currency and rejects across currencies', () => {
    const a = Money.fromDecimal('1.000', 'JOD');
    const b = Money.fromDecimal('2.000', 'JOD');
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.compare(a)).toBe(0);
    expect(() => a.compare(Money.fromDecimal('1.00', 'USD'))).toThrow(TypeError);
  });

  it('reports sign correctly', () => {
    expect(Money.zero('JOD').isZero()).toBe(true);
    expect(Money.fromMinor(-1n, 'JOD').isNegative()).toBe(true);
    expect(Money.fromMinor(1n, 'JOD').isPositive()).toBe(true);
    expect(Money.fromMinor(-5n, 'JOD').abs().toString()).toBe('0.005');
    expect(Money.fromMinor(5n, 'JOD').negate().minor).toBe(-5n);
  });

  it('serialises money as strings, never floats', () => {
    expect(Money.fromDecimal('1160.000', 'JOD').toJSON()).toEqual({
      amount: '1160.000',
      minor: '1160000',
      currency: 'JOD',
    });
  });

  it('equality requires the same currency', () => {
    expect(Money.fromMinor(100n, 'USD').equals(Money.fromMinor(100n, 'JOD'))).toBe(false);
  });
});
