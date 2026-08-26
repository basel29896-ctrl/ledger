import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  canApprove,
  cashRequirements,
  matchLine,
  threeWayMatch,
  type MatchLineInput,
  type MatchTolerance,
} from '../src/index';

const strict: MatchTolerance = {
  quantityPercent: new Decimal(0),
  pricePercent: new Decimal(0),
  absoluteMinor: 0n,
};
const lenient: MatchTolerance = {
  quantityPercent: new Decimal(5),
  pricePercent: new Decimal(2),
  absoluteMinor: 100n,
};

function line(overrides: Partial<MatchLineInput> = {}): MatchLineInput {
  return {
    orderLineId: 'ol-1',
    description: 'Widgets',
    quantityOrdered: 100,
    quantityReceived: 100,
    quantityBilled: 100,
    unitPriceOrdered: 5_000n,
    unitPriceBilled: 5_000n,
    ...overrides,
  };
}

describe('three-way match', () => {
  it('matches when order, receipt and bill agree', () => {
    const result = matchLine(line(), strict);
    expect(result.matched).toBe(true);
    expect(result.exceptions).toEqual([]);
  });

  it('flags a bill for goods that were never received', () => {
    const result = matchLine(line({ quantityReceived: 0 }), strict);
    expect(result.exceptions.map((e) => e.code)).toEqual(['NOT_RECEIVED']);
    expect(result.exceptions[0]?.message).toContain('nothing has been received');
  });

  it('flags billing more than was received', () => {
    const result = matchLine(line({ quantityReceived: 80, quantityBilled: 100 }), strict);
    expect(result.exceptions.map((e) => e.code)).toContain('BILLED_MORE_THAN_RECEIVED');
  });

  it('flags billing more than was ordered', () => {
    const result = matchLine(
      line({ quantityOrdered: 100, quantityReceived: 120, quantityBilled: 120 }),
      strict,
    );
    const codes = result.exceptions.map((e) => e.code);
    expect(codes).toContain('BILLED_MORE_THAN_ORDERED');
    expect(codes).toContain('RECEIVED_MORE_THAN_ORDERED');
  });

  it('flags a unit price the supplier changed', () => {
    const result = matchLine(line({ unitPriceBilled: 5_500n }), strict);
    const exception = result.exceptions.find((e) => e.code === 'PRICE_VARIANCE');
    expect(exception?.message).toContain('5500');
    expect(result.priceVarianceMinor).toBe('500');
  });

  it('accepts a small over-delivery inside the quantity tolerance', () => {
    // 5% of 100 is 5 units, so 103 received and billed is inside tolerance.
    const result = matchLine(
      line({ quantityReceived: 103, quantityBilled: 103 }),
      lenient,
    );
    expect(result.matched).toBe(true);
  });

  it('still refuses an over-delivery beyond the tolerance', () => {
    const result = matchLine(line({ quantityReceived: 110, quantityBilled: 110 }), lenient);
    expect(result.matched).toBe(false);
  });

  it('accepts a price variance inside the percentage tolerance', () => {
    // 2% of 5000 is 100, so 5,080 is inside.
    expect(matchLine(line({ unitPriceBilled: 5_080n }), lenient).matched).toBe(true);
  });

  it('accepts a variance inside the absolute tolerance even on a tiny price', () => {
    // 2% of 10 is 0.2, but the absolute floor of 100 minor units covers it.
    expect(
      matchLine(line({ unitPriceOrdered: 10n, unitPriceBilled: 90n }), lenient).matched,
    ).toBe(true);
  });

  it('treats a negative price variance the same as a positive one', () => {
    const cheaper = matchLine(line({ unitPriceBilled: 4_000n }), strict);
    expect(cheaper.matched).toBe(false);
    expect(cheaper.priceVarianceMinor).toBe('-1000');
  });

  it('skips the price check when the bill has no line price', () => {
    expect(matchLine(line({ unitPriceBilled: null }), strict).matched).toBe(true);
  });

  it('reports the quantity variance for the exception queue', () => {
    const result = matchLine(line({ quantityReceived: 90, quantityBilled: 100 }), strict);
    expect(result.quantityVariance).toBe('10');
  });

  it('aggregates a whole bill and fails if any line fails', () => {
    const result = threeWayMatch(
      [line(), line({ orderLineId: 'ol-2', quantityReceived: 0 })],
      strict,
    );
    expect(result.matched).toBe(false);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]?.matched).toBe(true);
    expect(result.exceptions).toHaveLength(1);
  });

  it('matches a whole bill when every line agrees', () => {
    expect(threeWayMatch([line(), line({ orderLineId: 'ol-2' })], strict).matched).toBe(true);
  });
});

describe('approval routing and segregation of duties', () => {
  const base = {
    billTotalMinor: 5_000_000n,
    thresholdMinor: 1_000_000n,
    createdBy: 'clerk',
    approverId: 'manager',
    approverPermissions: ['ap.bill.approve'],
  };

  it('allows an approver with the permission', () => {
    expect(canApprove(base).allowed).toBe(true);
  });

  it('refuses without the permission', () => {
    const result = canApprove({ ...base, approverPermissions: ['ap.bill.write'] });
    expect(result.refusal).toBe('MISSING_PERMISSION');
  });

  it('refuses the creator above the threshold', () => {
    const result = canApprove({ ...base, approverId: 'clerk' });
    expect(result.refusal).toBe('SEGREGATION_OF_DUTIES');
  });

  it('allows the creator at or below the threshold', () => {
    const result = canApprove({
      ...base,
      approverId: 'clerk',
      billTotalMinor: 1_000_000n,
    });
    expect(result.allowed).toBe(true);
  });

  it('refuses while match exceptions are unresolved', () => {
    const result = canApprove(base, { hasUnresolvedExceptions: true });
    expect(result.refusal).toBe('MATCH_EXCEPTION_UNRESOLVED');
  });
});

describe('cash requirements forecast', () => {
  const docs = [
    { documentId: 'b1', contactId: 'v1', dueDate: '2026-02-01', outstandingMinor: 100_000n },
    { documentId: 'b2', contactId: 'v1', dueDate: '2026-03-05', outstandingMinor: 200_000n },
    { documentId: 'b3', contactId: 'v2', dueDate: '2026-03-20', outstandingMinor: 300_000n },
    { documentId: 'b4', contactId: 'v2', dueDate: '2026-09-01', outstandingMinor: 400_000n },
    { documentId: 'b5', contactId: 'v2', dueDate: '2026-03-01', outstandingMinor: 0n },
  ];

  it('puts overdue bills in the first bucket', () => {
    const buckets = cashRequirements(docs, '2026-03-01');
    expect(buckets[0]?.totalMinor).toBe(100_000n);
    expect(buckets[0]?.documentIds).toEqual(['b1']);
  });

  it('buckets by how soon each bill is due', () => {
    const buckets = cashRequirements(docs, '2026-03-01');
    const within7 = buckets.find((b) => b.label === 'Within 7 days');
    const within30 = buckets.find((b) => b.label === 'Within 30 days');
    expect(within7?.documentIds).toEqual(['b2']);
    expect(within30?.documentIds).toEqual(['b3']);
  });

  it('puts distant bills in Later', () => {
    const buckets = cashRequirements(docs, '2026-03-01');
    expect(buckets.at(-1)?.documentIds).toEqual(['b4']);
  });

  it('ignores settled bills', () => {
    const buckets = cashRequirements(docs, '2026-03-01');
    const all = buckets.flatMap((b) => b.documentIds);
    expect(all).not.toContain('b5');
  });

  it('totals back to the outstanding sum', () => {
    const buckets = cashRequirements(docs, '2026-03-01');
    const total = buckets.reduce((sum, b) => sum + b.totalMinor, 0n);
    expect(total).toBe(1_000_000n);
  });

  it('rejects an invalid as-of date', () => {
    expect(() => cashRequirements(docs, 'not-a-date')).toThrow(RangeError);
  });
});
