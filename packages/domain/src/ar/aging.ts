import { Money } from '../money/money';

/**
 * Aging and payment allocation.
 *
 * Both are pure functions over outstanding documents so the same logic serves
 * AR and AP, the aging report, and the statement of account.
 */

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_120', 'd120_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current',
  d1_30: '1–30 days',
  d31_60: '31–60 days',
  d61_90: '61–90 days',
  d91_120: '91–120 days',
  d120_plus: '120+ days',
};

export interface OutstandingDocument {
  readonly documentId: string;
  readonly contactId: string;
  readonly docRef: string | null;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly outstandingMinor: bigint;
}

export interface AgedDocument extends OutstandingDocument {
  readonly daysOverdue: number;
  readonly bucket: AgingBucket;
}

/** Whole days between two ISO dates, positive when `later` is after `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  const a = Date.parse(`${earlier}T00:00:00Z`);
  const b = Date.parse(`${later}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new RangeError('Invalid date');
  return Math.round((b - a) / 86_400_000);
}

/**
 * A document is `current` until the day after its due date.
 * Due today is not overdue — the customer still has the day to pay.
 */
export function bucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  if (daysOverdue <= 120) return 'd91_120';
  return 'd120_plus';
}

export function ageDocument(doc: OutstandingDocument, asOf: string): AgedDocument {
  const daysOverdue = daysBetween(doc.dueDate, asOf);
  return { ...doc, daysOverdue, bucket: bucketFor(daysOverdue) };
}

export interface ContactAging {
  readonly contactId: string;
  readonly currency: string;
  readonly buckets: Record<AgingBucket, Money>;
  readonly total: Money;
  readonly documents: readonly AgedDocument[];
}

export interface AgingReport {
  readonly asOf: string;
  readonly currency: string;
  readonly contacts: readonly ContactAging[];
  readonly buckets: Record<AgingBucket, Money>;
  readonly total: Money;
}

function emptyBuckets(currency: string): Record<AgingBucket, Money> {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, Money.zero(currency)])) as Record<
    AgingBucket,
    Money
  >;
}

export function buildAgingReport(
  documents: readonly OutstandingDocument[],
  asOf: string,
  currency: string,
): AgingReport {
  const byContact = new Map<string, AgedDocument[]>();
  for (const doc of documents) {
    if (doc.outstandingMinor === 0n) continue;
    const aged = ageDocument(doc, asOf);
    byContact.set(doc.contactId, [...(byContact.get(doc.contactId) ?? []), aged]);
  }

  const totals = emptyBuckets(currency);
  let grandTotal = Money.zero(currency);

  const contacts: ContactAging[] = [...byContact.entries()]
    .map(([contactId, docs]) => {
      const buckets = emptyBuckets(currency);
      let total = Money.zero(currency);
      for (const doc of docs) {
        const amount = Money.fromMinor(doc.outstandingMinor, currency);
        buckets[doc.bucket] = buckets[doc.bucket].add(amount);
        totals[doc.bucket] = totals[doc.bucket].add(amount);
        total = total.add(amount);
        grandTotal = grandTotal.add(amount);
      }
      return {
        contactId,
        currency,
        buckets,
        total,
        documents: [...docs].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      };
    })
    .sort((a, b) => a.contactId.localeCompare(b.contactId));

  return { asOf, currency, contacts, buckets: totals, total: grandTotal };
}

// --- allocation -------------------------------------------------------

export interface AllocationTarget {
  readonly documentId: string;
  readonly dueDate: string;
  readonly outstandingMinor: bigint;
}

export interface Allocation {
  readonly documentId: string;
  readonly amountMinor: bigint;
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[];
  /** Money left on the payment once every target is settled. */
  readonly unappliedMinor: bigint;
}

/**
 * Spread a receipt across open documents, oldest due date first.
 *
 * Anything left over stays unapplied rather than being forced onto a document:
 * an overpayment is a real balance the customer is owed, not a rounding
 * problem to be absorbed.
 */
export function allocateOldestFirst(
  paymentMinor: bigint,
  targets: readonly AllocationTarget[],
): AllocationResult {
  if (paymentMinor <= 0n) throw new RangeError('Payment amount must be greater than zero');

  const ordered = [...targets]
    .filter((t) => t.outstandingMinor > 0n)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.documentId.localeCompare(b.documentId));

  const allocations: Allocation[] = [];
  let remaining = paymentMinor;

  for (const target of ordered) {
    if (remaining === 0n) break;
    const amount = remaining < target.outstandingMinor ? remaining : target.outstandingMinor;
    allocations.push({ documentId: target.documentId, amountMinor: amount });
    remaining -= amount;
  }

  return { allocations, unappliedMinor: remaining };
}

/** Validate a hand-made allocation against what the payment and documents allow. */
export function validateAllocation(
  paymentMinor: bigint,
  allocations: readonly Allocation[],
  targets: readonly AllocationTarget[],
): readonly string[] {
  const problems: string[] = [];
  const outstanding = new Map(targets.map((t) => [t.documentId, t.outstandingMinor]));

  let total = 0n;
  for (const allocation of allocations) {
    if (allocation.amountMinor <= 0n) {
      problems.push(`Allocation to ${allocation.documentId} must be greater than zero`);
    }
    const available = outstanding.get(allocation.documentId);
    if (available === undefined) {
      problems.push(`Document ${allocation.documentId} is not open for this contact`);
    } else if (allocation.amountMinor > available) {
      problems.push(
        `Allocation of ${allocation.amountMinor} to ${allocation.documentId} exceeds its outstanding ${available}`,
      );
    }
    total += allocation.amountMinor;
  }

  if (total > paymentMinor) {
    problems.push(`Allocations of ${total} exceed the payment amount of ${paymentMinor}`);
  }
  return problems;
}
