import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { Money } from '../src/money/money';
import { convert, invert, makeRate, realisedFxDifference } from '../src/money/fx';

const USD_TO_JOD = makeRate('USD', 'JOD', '0.7090000000', '2026-01-31');
const JOD_TO_USD = makeRate('JOD', 'USD', '1.4104372355', '2026-01-31');

describe('exchange rates', () => {
  it('rejects a non-positive rate', () => {
    expect(() => makeRate('USD', 'JOD', '0', '2026-01-31')).toThrow(RangeError);
    expect(() => makeRate('USD', 'JOD', '-1', '2026-01-31')).toThrow(RangeError);
  });

  it('inverts a rate at full precision', () => {
    const back = invert(USD_TO_JOD);
    expect(back.from).toBe('JOD');
    expect(back.to).toBe('USD');
    expect(back.rate.mul(USD_TO_JOD.rate).toNumber()).toBeCloseTo(1, 12);
  });
});

describe('conversion', () => {
  it('widens to the target currency exponent when going USD -> JOD', () => {
    // 100.00 USD * 0.709 = 70.900 JOD, three decimals because JOD is the target.
    const converted = convert(Money.fromDecimal('100.00', 'USD'), USD_TO_JOD);
    expect(converted.currency).toBe('JOD');
    expect(converted.toString()).toBe('70.900');
  });

  it('narrows to the target currency exponent when going JOD -> USD', () => {
    const converted = convert(Money.fromDecimal('70.900', 'JOD'), JOD_TO_USD);
    expect(converted.currency).toBe('USD');
    expect(converted.toString()).toBe('100.00');
  });

  it('rounds fils rather than dropping them', () => {
    // 100.50 USD * 0.709 = 71.2545 JOD -> exactly half a fil, which must round, not vanish.
    const amount = Money.fromDecimal('100.50', 'USD');
    expect(convert(amount, USD_TO_JOD).toString()).toBe('71.255');
    expect(convert(amount, USD_TO_JOD, 'down').toString()).toBe('71.254');
  });

  it('is a no-op when source and target currencies match', () => {
    const same = makeRate('JOD', 'JOD', '1', '2026-01-31');
    const amount = Money.fromDecimal('5.500', 'JOD');
    expect(convert(amount, same).equals(amount)).toBe(true);
  });

  it('refuses a rate that does not apply to the amount', () => {
    expect(() => convert(Money.fromDecimal('1.00', 'EUR'), USD_TO_JOD)).toThrow(TypeError);
  });

  it('handles a currency with no minor unit', () => {
    const jodToJpy = makeRate('JOD', 'JPY', '220.5', '2026-01-31');
    expect(convert(Money.fromDecimal('1.000', 'JOD'), jodToJpy).toString()).toBe('221');
  });
});

describe('realised FX gain and loss', () => {
  it('reports a gain when the base currency value rises by settlement', () => {
    const diff = realisedFxDifference({
      foreignAmount: Money.fromDecimal('1000.00', 'USD'),
      rateAtRecognition: makeRate('USD', 'JOD', '0.7090000000', '2026-01-31'),
      rateAtSettlement: makeRate('USD', 'JOD', '0.7150000000', '2026-02-28'),
    });
    // 715.000 - 709.000 = 6.000 JOD gain
    expect(diff.toString()).toBe('6.000');
    expect(diff.isPositive()).toBe(true);
  });

  it('reports a loss when the base currency value falls', () => {
    const diff = realisedFxDifference({
      foreignAmount: Money.fromDecimal('1000.00', 'USD'),
      rateAtRecognition: makeRate('USD', 'JOD', '0.7150000000', '2026-01-31'),
      rateAtSettlement: makeRate('USD', 'JOD', '0.7090000000', '2026-02-28'),
    });
    expect(diff.toString()).toBe('-6.000');
  });

  it('is zero when the rate did not move', () => {
    const rate = makeRate('USD', 'JOD', '0.7090000000', '2026-01-31');
    const diff = realisedFxDifference({
      foreignAmount: Money.fromDecimal('1234.56', 'USD'),
      rateAtRecognition: rate,
      rateAtSettlement: { ...rate, rateDate: '2026-02-28' },
    });
    expect(diff.isZero()).toBe(true);
  });

  it('requires both rates to target the same base currency', () => {
    expect(() =>
      realisedFxDifference({
        foreignAmount: Money.fromDecimal('1.00', 'USD'),
        rateAtRecognition: makeRate('USD', 'JOD', '0.709', '2026-01-31'),
        rateAtSettlement: makeRate('USD', 'EUR', '0.92', '2026-02-28'),
      }),
    ).toThrow(TypeError);
  });

  it('keeps full rate precision until the final rounding', () => {
    const rate = makeRate('USD', 'JOD', new Decimal('0.7091234567'), '2026-01-31');
    expect(convert(Money.fromDecimal('1000.00', 'USD'), rate).toString()).toBe('709.123');
  });
});
