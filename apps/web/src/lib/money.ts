import type { MoneyDto } from '@acct/shared';

/**
 * Display and input helpers for money.
 *
 * The browser never does arithmetic on these values — it formats strings the
 * API produced and converts typed decimals to minor units for the API to check
 * again. Every conversion here is integer string manipulation, never a float.
 */

const EXPONENTS: Record<string, number> = {
  JOD: 3, KWD: 3, BHD: 3, TND: 3, OMR: 3,
  JPY: 0,
};

export function exponentOf(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

/** "1160.000" → "1,160.000" */
export function formatMoney(money: MoneyDto | null | undefined): string {
  if (!money) return '';
  const [whole = '0', fraction] = money.amount.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = money.amount.startsWith('-') ? '-' : '';
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

export function formatWithCurrency(money: MoneyDto | null | undefined): string {
  return money ? `${formatMoney(money)} ${money.currency}` : '';
}

/**
 * Parse a typed decimal into minor units without touching Number.
 * Returns null when the input is not a valid amount for the currency.
 */
export function toMinorUnits(input: string, currency: string): string | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (trimmed === '') return null;
  if (!/^\d*(\.\d*)?$/.test(trimmed)) return null;

  const exponent = exponentOf(currency);
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > exponent) return null;

  const padded = fraction.padEnd(exponent, '0');
  const digits = `${whole || '0'}${padded}`.replace(/^0+(?=\d)/, '');
  return digits === '' ? '0' : digits;
}

/** Minor units back to a decimal string for an input field. */
export function fromMinorUnits(minor: string, currency: string): string {
  const exponent = exponentOf(currency);
  if (exponent === 0) return minor;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Sum minor-unit strings exactly, using BigInt. */
export function sumMinor(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value || '0'), 0n);
}
