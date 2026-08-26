import Decimal from 'decimal.js';
import { Money, type RoundingMode } from '../money/money';

/**
 * The tax engine.
 *
 * Three things make this more than a multiplication:
 *  - **compound tax**, where one tax is charged on the base plus another tax
 *    (Jordan's Special Sales Tax sits on top of the value, and General Sales
 *    Tax is then charged on the total);
 *  - **withholding**, which is deducted from what the supplier is paid rather
 *    than added to what the customer owes;
 *  - **inclusive pricing**, where the stated price already contains the tax.
 *
 * Every amount is rounded once, per line per tax, because a tax authority
 * reconciles line by line and a document-level rounding cannot be explained.
 */

export type TaxKind = 'sales' | 'purchase' | 'both';

export interface TaxCodeDefinition {
  readonly code: string;
  readonly name: string;
  readonly ratePercent: Decimal;
  readonly kind: TaxKind;
  /** Charged on the value *plus* the taxes named here. */
  readonly compoundOn?: readonly string[];
  /** Deducted from the payment rather than added to the invoice. */
  readonly isWithholding?: boolean;
  /** Recoverable input tax; false means it is a cost. */
  readonly isRecoverable?: boolean;
  /** Zero-rated and exempt both charge nothing but are reported separately. */
  readonly treatment?: 'standard' | 'zero_rated' | 'exempt';
}

export interface TaxComponent {
  readonly code: string;
  readonly name: string;
  readonly ratePercent: string;
  readonly baseMinor: bigint;
  readonly amountMinor: bigint;
  readonly isWithholding: boolean;
  readonly treatment: 'standard' | 'zero_rated' | 'exempt';
}

export interface TaxedLine {
  readonly netMinor: bigint;
  readonly taxComponents: readonly TaxComponent[];
  /** Tax added to what the customer owes. */
  readonly taxTotalMinor: bigint;
  /** Tax deducted from what the supplier is paid. */
  readonly withholdingMinor: bigint;
  readonly grossMinor: bigint;
}

export class TaxConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxConfigurationError';
  }
}

/**
 * Order the codes so that a compound tax is computed after everything it
 * compounds on. Throws on a cycle rather than looping.
 */
export function orderTaxCodes(codes: readonly TaxCodeDefinition[]): readonly TaxCodeDefinition[] {
  const byCode = new Map(codes.map((c) => [c.code, c]));
  const ordered: TaxCodeDefinition[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (code: TaxCodeDefinition, trail: readonly string[]): void => {
    const status = state.get(code.code);
    if (status === 'done') return;
    if (status === 'visiting') {
      throw new TaxConfigurationError(
        `Compound tax cycle: ${[...trail, code.code].join(' -> ')}`,
      );
    }
    state.set(code.code, 'visiting');
    for (const dependency of code.compoundOn ?? []) {
      const target = byCode.get(dependency);
      if (!target) {
        throw new TaxConfigurationError(
          `Tax ${code.code} compounds on ${dependency}, which is not applied to this line`,
        );
      }
      visit(target, [...trail, code.code]);
    }
    state.set(code.code, 'done');
    ordered.push(code);
  };

  for (const code of codes) visit(code, []);
  return ordered;
}

export interface TaxLineInput {
  readonly quantity: Decimal | string | number;
  readonly unitPriceMinor: bigint;
  readonly taxCodes: readonly TaxCodeDefinition[];
  /** The unit price already includes the non-compound, non-withholding taxes. */
  readonly taxInclusive?: boolean;
  readonly discountMinor?: bigint;
}

export function calculateTaxedLine(
  input: TaxLineInput,
  currency: string,
  rounding: RoundingMode = 'half-up',
): TaxedLine {
  const quantity = new Decimal(input.quantity);
  if (quantity.lessThanOrEqualTo(0)) throw new RangeError('Quantity must be greater than zero');

  const extended = Money.fromMinor(input.unitPriceMinor, currency).multiply(quantity, rounding);
  const discount = Money.fromMinor(input.discountMinor ?? 0n, currency);
  if (discount.minor > extended.minor) {
    throw new RangeError('A discount cannot exceed the line value');
  }

  const ordered = orderTaxCodes(input.taxCodes);
  const additive = ordered.filter((c) => !c.isWithholding);

  let net = extended.subtract(discount);

  // Inclusive pricing: strip the additive taxes out of the stated price first.
  if (input.taxInclusive && additive.length > 0) {
    const totalRate = additive.reduce((sum, code) => {
      // A compound tax multiplies the rates it sits on rather than adding.
      const compoundFactor = (code.compoundOn ?? []).reduce(
        (factor, dependency) =>
          factor.plus(
            additive.find((c) => c.code === dependency)?.ratePercent.div(100) ?? new Decimal(0),
          ),
        new Decimal(1),
      );
      return sum.plus(code.ratePercent.div(100).mul(compoundFactor));
    }, new Decimal(0));

    net = net.multiply(new Decimal(1).div(new Decimal(1).plus(totalRate)), rounding);
  }

  const components: TaxComponent[] = [];
  const amountByCode = new Map<string, Money>();

  for (const code of ordered) {
    const compoundBase = (code.compoundOn ?? []).reduce(
      (base, dependency) => base.add(amountByCode.get(dependency) ?? Money.zero(currency)),
      net,
    );
    const amount = compoundBase.multiply(code.ratePercent.div(100), rounding);
    amountByCode.set(code.code, amount);
    components.push({
      code: code.code,
      name: code.name,
      ratePercent: code.ratePercent.toString(),
      baseMinor: compoundBase.minor,
      amountMinor: amount.minor,
      isWithholding: code.isWithholding ?? false,
      treatment: code.treatment ?? 'standard',
    });
  }

  const taxTotal = components
    .filter((c) => !c.isWithholding)
    .reduce((sum, c) => sum + c.amountMinor, 0n);
  const withholding = components
    .filter((c) => c.isWithholding)
    .reduce((sum, c) => sum + c.amountMinor, 0n);

  return {
    netMinor: net.minor,
    taxComponents: components,
    taxTotalMinor: taxTotal,
    withholdingMinor: withholding,
    grossMinor: net.minor + taxTotal,
  };
}

// --- tax return --------------------------------------------------------

export interface TaxReturnLineInput {
  readonly taxCode: string;
  readonly treatment: 'standard' | 'zero_rated' | 'exempt';
  readonly direction: 'output' | 'input';
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
  readonly isRecoverable?: boolean;
}

export interface TaxReturnBox {
  readonly label: string;
  readonly netMinor: bigint;
  readonly taxMinor: bigint;
}

export interface TaxReturn {
  readonly fromDate: string;
  readonly toDate: string;
  readonly currency: string;
  readonly standardRatedSales: TaxReturnBox;
  readonly zeroRatedSales: TaxReturnBox;
  readonly exemptSales: TaxReturnBox;
  readonly totalSales: TaxReturnBox;
  readonly purchases: TaxReturnBox;
  readonly outputTaxMinor: bigint;
  readonly recoverableInputTaxMinor: bigint;
  readonly irrecoverableInputTaxMinor: bigint;
  readonly netPayableMinor: bigint;
  readonly byCode: readonly { code: string; netMinor: bigint; taxMinor: bigint; direction: string }[];
}

/**
 * Build the return.
 *
 * Net payable = output tax − recoverable input tax. Irrecoverable input tax is
 * reported but excluded: it is a cost of the business, not a claim against the
 * authority.
 */
export function buildTaxReturn(
  lines: readonly TaxReturnLineInput[],
  period: { fromDate: string; toDate: string; currency: string },
): TaxReturn {
  const empty = (): { netMinor: bigint; taxMinor: bigint } => ({ netMinor: 0n, taxMinor: 0n });

  const standard = empty();
  const zero = empty();
  const exempt = empty();
  const purchases = empty();
  let recoverable = 0n;
  let irrecoverable = 0n;

  const byCode = new Map<string, { netMinor: bigint; taxMinor: bigint; direction: string }>();

  for (const line of lines) {
    const key = `${line.direction}:${line.taxCode}`;
    const bucket = byCode.get(key) ?? { netMinor: 0n, taxMinor: 0n, direction: line.direction };
    bucket.netMinor += line.netMinor;
    bucket.taxMinor += line.taxMinor;
    byCode.set(key, bucket);

    if (line.direction === 'output') {
      const target = line.treatment === 'zero_rated' ? zero : line.treatment === 'exempt' ? exempt : standard;
      target.netMinor += line.netMinor;
      target.taxMinor += line.taxMinor;
    } else {
      purchases.netMinor += line.netMinor;
      purchases.taxMinor += line.taxMinor;
      if (line.isRecoverable === false) irrecoverable += line.taxMinor;
      else recoverable += line.taxMinor;
    }
  }

  const outputTax = standard.taxMinor + zero.taxMinor + exempt.taxMinor;

  return {
    fromDate: period.fromDate,
    toDate: period.toDate,
    currency: period.currency,
    standardRatedSales: { label: 'Standard-rated sales', ...standard },
    zeroRatedSales: { label: 'Zero-rated sales', ...zero },
    exemptSales: { label: 'Exempt sales', ...exempt },
    totalSales: {
      label: 'Total sales',
      netMinor: standard.netMinor + zero.netMinor + exempt.netMinor,
      taxMinor: outputTax,
    },
    purchases: { label: 'Purchases', ...purchases },
    outputTaxMinor: outputTax,
    recoverableInputTaxMinor: recoverable,
    irrecoverableInputTaxMinor: irrecoverable,
    netPayableMinor: outputTax - recoverable,
    byCode: [...byCode.entries()].map(([key, value]) => ({
      code: key.split(':')[1] ?? key,
      ...value,
    })),
  };
}
