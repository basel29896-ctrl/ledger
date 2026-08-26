/**
 * Minor-unit exponents. Hardcoding 2 decimals is a defect:
 * JOD/KWD/BHD/TND divide into 1000, JPY has no minor unit.
 */
export const MINOR_UNIT_EXPONENTS = {
  USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2, EGP: 2,
  JOD: 3, KWD: 3, BHD: 3, TND: 3, OMR: 3,
  JPY: 0,
} as const satisfies Record<string, number>;

export type KnownCurrency = keyof typeof MINOR_UNIT_EXPONENTS;

export function minorUnitExponent(code: string): number {
  const exp = (MINOR_UNIT_EXPONENTS as Record<string, number | undefined>)[code.toUpperCase()];
  if (exp === undefined) throw new Error(`Unknown currency code: ${code}`);
  return exp;
}
