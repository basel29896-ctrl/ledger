import Decimal from 'decimal.js';

/**
 * Three-way matching: purchase order ↔ goods receipt ↔ vendor bill.
 *
 * The point of the control is to refuse to pay for something that was not
 * ordered, or not received, or priced differently from the order. Tolerances
 * exist because reality is messy — a supplier ships 1001 units of a 1000-unit
 * order — but a tolerance that swallows a real discrepancy is worse than none,
 * so every exception is reported with the numbers that produced it.
 */

export interface MatchTolerance {
  /** Permitted over-delivery / over-billing, as a percentage of the ordered quantity. */
  readonly quantityPercent: Decimal;
  /** Permitted unit-price variance, as a percentage of the ordered price. */
  readonly pricePercent: Decimal;
  /** Absolute value below which a variance is ignored, in minor units. */
  readonly absoluteMinor: bigint;
}

export const DEFAULT_TOLERANCE: MatchTolerance = {
  quantityPercent: new Decimal(0),
  pricePercent: new Decimal(0),
  absoluteMinor: 0n,
};

export interface MatchLineInput {
  readonly orderLineId: string;
  readonly description: string;
  readonly quantityOrdered: Decimal | string | number;
  readonly quantityReceived: Decimal | string | number;
  readonly quantityBilled: Decimal | string | number;
  readonly unitPriceOrdered: bigint;
  readonly unitPriceBilled: bigint | null;
}

export type MatchExceptionCode =
  | 'BILLED_MORE_THAN_RECEIVED'
  | 'BILLED_MORE_THAN_ORDERED'
  | 'RECEIVED_MORE_THAN_ORDERED'
  | 'PRICE_VARIANCE'
  | 'NOT_RECEIVED';

export interface MatchException {
  readonly orderLineId: string;
  readonly code: MatchExceptionCode;
  readonly message: string;
}

export interface MatchLineResult {
  readonly orderLineId: string;
  readonly matched: boolean;
  readonly exceptions: readonly MatchException[];
  readonly quantityVariance: string;
  readonly priceVarianceMinor: string;
}

export interface MatchResult {
  readonly matched: boolean;
  readonly lines: readonly MatchLineResult[];
  readonly exceptions: readonly MatchException[];
}

export function matchLine(
  line: MatchLineInput,
  tolerance: MatchTolerance = DEFAULT_TOLERANCE,
): MatchLineResult {
  const ordered = new Decimal(line.quantityOrdered);
  const received = new Decimal(line.quantityReceived);
  const billed = new Decimal(line.quantityBilled);
  const exceptions: MatchException[] = [];

  const quantityAllowance = ordered.mul(tolerance.quantityPercent).div(100);

  if (billed.greaterThan(0) && received.isZero()) {
    exceptions.push({
      orderLineId: line.orderLineId,
      code: 'NOT_RECEIVED',
      message: `${line.description}: billed ${billed.toString()} but nothing has been received`,
    });
  } else if (billed.greaterThan(received.plus(quantityAllowance))) {
    exceptions.push({
      orderLineId: line.orderLineId,
      code: 'BILLED_MORE_THAN_RECEIVED',
      message: `${line.description}: billed ${billed.toString()} against ${received.toString()} received`,
    });
  }

  if (billed.greaterThan(ordered.plus(quantityAllowance))) {
    exceptions.push({
      orderLineId: line.orderLineId,
      code: 'BILLED_MORE_THAN_ORDERED',
      message: `${line.description}: billed ${billed.toString()} against ${ordered.toString()} ordered`,
    });
  }

  if (received.greaterThan(ordered.plus(quantityAllowance))) {
    exceptions.push({
      orderLineId: line.orderLineId,
      code: 'RECEIVED_MORE_THAN_ORDERED',
      message: `${line.description}: received ${received.toString()} against ${ordered.toString()} ordered`,
    });
  }

  let priceVariance = 0n;
  if (line.unitPriceBilled !== null) {
    priceVariance = line.unitPriceBilled - line.unitPriceOrdered;
    const magnitude = priceVariance < 0n ? -priceVariance : priceVariance;
    const percentAllowance = new Decimal(line.unitPriceOrdered.toString())
      .mul(tolerance.pricePercent)
      .div(100);
    const allowance = Decimal.max(percentAllowance, new Decimal(tolerance.absoluteMinor.toString()));

    if (new Decimal(magnitude.toString()).greaterThan(allowance)) {
      exceptions.push({
        orderLineId: line.orderLineId,
        code: 'PRICE_VARIANCE',
        message:
          `${line.description}: billed at ${line.unitPriceBilled} against ` +
          `${line.unitPriceOrdered} ordered (variance ${priceVariance})`,
      });
    }
  }

  return {
    orderLineId: line.orderLineId,
    matched: exceptions.length === 0,
    exceptions,
    quantityVariance: billed.minus(received).toString(),
    priceVarianceMinor: priceVariance.toString(),
  };
}

export function threeWayMatch(
  lines: readonly MatchLineInput[],
  tolerance: MatchTolerance = DEFAULT_TOLERANCE,
): MatchResult {
  const results = lines.map((line) => matchLine(line, tolerance));
  const exceptions = results.flatMap((r) => r.exceptions);
  return { matched: exceptions.length === 0, lines: results, exceptions };
}

// --- approval routing --------------------------------------------------

export interface ApprovalContext {
  readonly billTotalMinor: bigint;
  readonly thresholdMinor: bigint;
  readonly createdBy: string;
  readonly approverId: string;
  readonly approverPermissions: readonly string[];
}

export type ApprovalRefusal =
  | 'MISSING_PERMISSION'
  | 'SEGREGATION_OF_DUTIES'
  | 'MATCH_EXCEPTION_UNRESOLVED';

/**
 * Whether this approver may approve this bill.
 *
 * Below the threshold a bill needs the permission only. At or above it, the
 * person who entered the bill is disqualified: that is the whole point of the
 * threshold.
 */
export function canApprove(
  context: ApprovalContext,
  options: { hasUnresolvedExceptions?: boolean } = {},
): { allowed: boolean; refusal?: ApprovalRefusal; message?: string } {
  if (!context.approverPermissions.includes('ap.bill.approve')) {
    return {
      allowed: false,
      refusal: 'MISSING_PERMISSION',
      message: 'Approving a bill requires the ap.bill.approve permission',
    };
  }

  if (options.hasUnresolvedExceptions) {
    return {
      allowed: false,
      refusal: 'MATCH_EXCEPTION_UNRESOLVED',
      message: 'Resolve or override the three-way match exceptions before approving',
    };
  }

  if (
    context.billTotalMinor > context.thresholdMinor &&
    context.createdBy === context.approverId
  ) {
    return {
      allowed: false,
      refusal: 'SEGREGATION_OF_DUTIES',
      message:
        'The user who entered this bill cannot approve it above the approval threshold',
    };
  }

  return { allowed: true };
}

// --- cash requirements -------------------------------------------------

export interface PayableDocument {
  readonly documentId: string;
  readonly contactId: string;
  readonly dueDate: string;
  readonly outstandingMinor: bigint;
}

export interface CashRequirementBucket {
  readonly label: string;
  readonly untilDate: string;
  readonly totalMinor: bigint;
  readonly documentIds: readonly string[];
}

/**
 * What the business must pay, and by when.
 * Anything already overdue lands in the first bucket, because it is due now.
 */
export function cashRequirements(
  documents: readonly PayableDocument[],
  asOf: string,
  horizons: readonly number[] = [0, 7, 14, 30, 60, 90],
): readonly CashRequirementBucket[] {
  const asOfTime = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(asOfTime)) throw new RangeError(`Invalid date: ${asOf}`);

  const buckets = horizons.map((days) => ({
    days,
    label: days === 0 ? 'Overdue and due today' : `Within ${days} days`,
    untilDate: new Date(asOfTime + days * 86_400_000).toISOString().slice(0, 10),
    totalMinor: 0n,
    documentIds: [] as string[],
  }));
  const beyond = {
    days: Number.POSITIVE_INFINITY,
    label: 'Later',
    untilDate: '',
    totalMinor: 0n,
    documentIds: [] as string[],
  };

  for (const doc of documents) {
    if (doc.outstandingMinor <= 0n) continue;
    const dueTime = Date.parse(`${doc.dueDate}T00:00:00Z`);
    const daysAway = Math.ceil((dueTime - asOfTime) / 86_400_000);
    const bucket = buckets.find((b) => daysAway <= b.days) ?? beyond;
    bucket.totalMinor += doc.outstandingMinor;
    bucket.documentIds.push(doc.documentId);
  }

  return [...buckets, beyond].map((b) => ({
    label: b.label,
    untilDate: b.untilDate,
    totalMinor: b.totalMinor,
    documentIds: b.documentIds,
  }));
}
