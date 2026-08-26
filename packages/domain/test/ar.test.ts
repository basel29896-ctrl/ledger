import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  allocateOldestFirst,
  bucketFor,
  buildAgingReport,
  calculateInvoice,
  calculateLine,
  daysBetween,
  dueDateFor,
  validateAllocation,
  type OutstandingDocument,
} from '../src/index';

const GST16 = { code: 'GST16', ratePercent: new Decimal(16) };
const GST4 = { code: 'GST4', ratePercent: new Decimal(4) };
const ZERO = { code: 'ZERO', ratePercent: new Decimal(0) };

describe('invoice line calculation', () => {
  it('applies 16% Jordan general sales tax to a JOD line', () => {
    // 1 × 1000.000 JOD @ 16% = 160.000 tax, 1160.000 gross
    const line = calculateLine({ quantity: 1, unitPriceMinor: 1_000_000n, taxRate: GST16 }, 'JOD');
    expect(line.netMinor).toBe(1_000_000n);
    expect(line.taxMinor).toBe(160_000n);
    expect(line.grossMinor).toBe(1_160_000n);
  });

  it('extends quantity before taxing', () => {
    const line = calculateLine({ quantity: 3, unitPriceMinor: 250_000n, taxRate: GST16 }, 'JOD');
    expect(line.netMinor).toBe(750_000n);
    expect(line.taxMinor).toBe(120_000n);
  });

  it('handles a fractional quantity to three JOD decimals', () => {
    // 2.5 × 33.333 = 83.3325 -> 83.333 half-up
    const line = calculateLine({ quantity: '2.5', unitPriceMinor: 33_333n, taxRate: ZERO }, 'JOD');
    expect(line.netMinor).toBe(83_333n);
  });

  it('backs tax out of a tax-inclusive price', () => {
    // 1160.000 inclusive at 16% -> net 1000.000, tax 160.000
    const line = calculateLine(
      { quantity: 1, unitPriceMinor: 1_160_000n, taxRate: GST16, taxInclusive: true },
      'JOD',
    );
    expect(line.netMinor).toBe(1_000_000n);
    expect(line.taxMinor).toBe(160_000n);
    expect(line.grossMinor).toBe(1_160_000n);
  });

  it('keeps net plus tax equal to gross exactly, inclusive or not', () => {
    for (const price of [1n, 7n, 999n, 123_456n, 1_000_001n]) {
      for (const inclusive of [true, false]) {
        const line = calculateLine(
          { quantity: 1, unitPriceMinor: price, taxRate: GST16, taxInclusive: inclusive },
          'JOD',
        );
        expect(line.netMinor + line.taxMinor).toBe(line.grossMinor);
      }
    }
  });

  it('taxes a two-decimal currency correctly', () => {
    const line = calculateLine({ quantity: 1, unitPriceMinor: 10_000n, taxRate: GST16 }, 'USD');
    expect(line.taxMinor).toBe(1_600n);
  });

  it('rejects a non-positive quantity', () => {
    expect(() => calculateLine({ quantity: 0, unitPriceMinor: 100n }, 'JOD')).toThrow(RangeError);
    expect(() => calculateLine({ quantity: -1, unitPriceMinor: 100n }, 'JOD')).toThrow(RangeError);
  });

  it('treats a line with no tax code as untaxed', () => {
    const line = calculateLine({ quantity: 2, unitPriceMinor: 500n }, 'JOD');
    expect(line.taxMinor).toBe(0n);
    expect(line.taxCode).toBeNull();
  });
});

describe('invoice totals', () => {
  it('rounds tax per line, not once for the document', () => {
    // Three lines of 0.333 JOD at 16% = 0.053 each (0.05328 -> 0.053).
    // Rounding the 0.999 total once would give 0.160, which is a fil adrift.
    const invoice = calculateInvoice(
      Array.from({ length: 3 }, () => ({ quantity: 1, unitPriceMinor: 333n, taxRate: GST16 })),
      'JOD',
    );
    expect(invoice.subtotalMinor).toBe(999n);
    expect(invoice.taxTotalMinor).toBe(159n);
    expect(invoice.totalMinor).toBe(1158n);
  });

  it('groups net and tax by tax code for the return', () => {
    const invoice = calculateInvoice(
      [
        { quantity: 1, unitPriceMinor: 1_000_000n, taxRate: GST16 },
        { quantity: 1, unitPriceMinor: 500_000n, taxRate: GST4 },
        { quantity: 1, unitPriceMinor: 250_000n, taxRate: ZERO },
      ],
      'JOD',
    );
    expect(invoice.taxByCode.get('GST16')).toEqual({ netMinor: 1_000_000n, taxMinor: 160_000n });
    expect(invoice.taxByCode.get('GST4')).toEqual({ netMinor: 500_000n, taxMinor: 20_000n });
    expect(invoice.taxByCode.get('ZERO')).toEqual({ netMinor: 250_000n, taxMinor: 0n });
    expect(invoice.totalMinor).toBe(1_930_000n);
  });

  it('always has total equal to subtotal plus tax', () => {
    const invoice = calculateInvoice(
      [
        { quantity: '1.5', unitPriceMinor: 12_345n, taxRate: GST16 },
        { quantity: 7, unitPriceMinor: 99n, taxRate: GST4 },
      ],
      'JOD',
    );
    expect(invoice.totalMinor).toBe(invoice.subtotalMinor + invoice.taxTotalMinor);
  });

  it('rejects an invoice with no lines', () => {
    expect(() => calculateInvoice([], 'JOD')).toThrow(RangeError);
  });
});

describe('due dates', () => {
  it('adds net terms in days', () => {
    expect(dueDateFor('2026-01-15', 30)).toBe('2026-02-14');
    expect(dueDateFor('2026-01-31', 30)).toBe('2026-03-02');
  });

  it('treats zero days as due on receipt', () => {
    expect(dueDateFor('2026-01-15', 0)).toBe('2026-01-15');
  });

  it('crosses a leap day correctly', () => {
    expect(dueDateFor('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('rejects nonsense terms', () => {
    expect(() => dueDateFor('2026-01-15', -1)).toThrow(RangeError);
    expect(() => dueDateFor('not-a-date', 30)).toThrow(RangeError);
  });
});

describe('aging buckets', () => {
  it('counts whole days between dates', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
  });

  it('places a document due today in current, not overdue', () => {
    expect(bucketFor(0)).toBe('current');
    expect(bucketFor(-5)).toBe('current');
  });

  it.each([
    [1, 'd1_30'],
    [30, 'd1_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd91_120'],
    [120, 'd91_120'],
    [121, 'd120_plus'],
    [400, 'd120_plus'],
  ])('puts %i days overdue in %s', (days, bucket) => {
    expect(bucketFor(days)).toBe(bucket);
  });
});

describe('aging report', () => {
  const docs: OutstandingDocument[] = [
    { documentId: 'a', contactId: 'c1', docRef: 'INV-1', issueDate: '2026-01-01', dueDate: '2026-03-01', currency: 'JOD', outstandingMinor: 1_000_000n },
    { documentId: 'b', contactId: 'c1', docRef: 'INV-2', issueDate: '2025-12-01', dueDate: '2026-01-15', currency: 'JOD', outstandingMinor: 500_000n },
    { documentId: 'c', contactId: 'c2', docRef: 'INV-3', issueDate: '2025-09-01', dueDate: '2025-10-01', currency: 'JOD', outstandingMinor: 250_000n },
    { documentId: 'd', contactId: 'c2', docRef: 'INV-4', issueDate: '2026-02-01', dueDate: '2026-03-15', currency: 'JOD', outstandingMinor: 0n },
  ];

  it('buckets each document by how overdue it is', () => {
    const report = buildAgingReport(docs, '2026-03-01', 'JOD');
    const c1 = report.contacts.find((c) => c.contactId === 'c1');
    expect(c1?.buckets.current.toString()).toBe('1000.000');
    expect(c1?.buckets.d31_60.toString()).toBe('500.000');
    const c2 = report.contacts.find((c) => c.contactId === 'c2');
    expect(c2?.buckets.d120_plus.toString()).toBe('250.000');
  });

  it('excludes fully settled documents', () => {
    const report = buildAgingReport(docs, '2026-03-01', 'JOD');
    const c2 = report.contacts.find((c) => c.contactId === 'c2');
    expect(c2?.documents.map((d) => d.documentId)).toEqual(['c']);
  });

  it('totals across contacts', () => {
    const report = buildAgingReport(docs, '2026-03-01', 'JOD');
    expect(report.total.toString()).toBe('1750.000');
    // The bucket totals must sum back to the grand total.
    const summed = Object.values(report.buckets).reduce((a, b) => a.add(b));
    expect(summed.equals(report.total)).toBe(true);
  });

  it('is empty when nothing is outstanding', () => {
    const report = buildAgingReport([], '2026-03-01', 'JOD');
    expect(report.contacts).toEqual([]);
    expect(report.total.isZero()).toBe(true);
  });
});

describe('payment allocation', () => {
  const targets = [
    { documentId: 'inv-2', dueDate: '2026-02-15', outstandingMinor: 500_000n },
    { documentId: 'inv-1', dueDate: '2026-01-15', outstandingMinor: 300_000n },
    { documentId: 'inv-3', dueDate: '2026-03-15', outstandingMinor: 200_000n },
  ];

  it('settles the oldest due date first', () => {
    const result = allocateOldestFirst(600_000n, targets);
    expect(result.allocations).toEqual([
      { documentId: 'inv-1', amountMinor: 300_000n },
      { documentId: 'inv-2', amountMinor: 300_000n },
    ]);
    expect(result.unappliedMinor).toBe(0n);
  });

  it('leaves an overpayment unapplied rather than forcing it onto a document', () => {
    const result = allocateOldestFirst(1_200_000n, targets);
    expect(result.unappliedMinor).toBe(200_000n);
    const allocated = result.allocations.reduce((sum, a) => sum + a.amountMinor, 0n);
    expect(allocated).toBe(1_000_000n);
  });

  it('part-pays a single document', () => {
    const result = allocateOldestFirst(100_000n, targets);
    expect(result.allocations).toEqual([{ documentId: 'inv-1', amountMinor: 100_000n }]);
  });

  it('never allocates more than the payment', () => {
    for (const amount of [1n, 299_999n, 300_000n, 999_999n, 1_000_000n]) {
      const result = allocateOldestFirst(amount, targets);
      const allocated = result.allocations.reduce((sum, a) => sum + a.amountMinor, 0n);
      expect(allocated + result.unappliedMinor).toBe(amount);
    }
  });

  it('rejects a non-positive payment', () => {
    expect(() => allocateOldestFirst(0n, targets)).toThrow(RangeError);
    expect(() => allocateOldestFirst(-1n, targets)).toThrow(RangeError);
  });
});

describe('manual allocation validation', () => {
  const targets = [
    { documentId: 'inv-1', dueDate: '2026-01-15', outstandingMinor: 300_000n },
    { documentId: 'inv-2', dueDate: '2026-02-15', outstandingMinor: 500_000n },
  ];

  it('accepts an allocation within both limits', () => {
    expect(
      validateAllocation(400_000n, [{ documentId: 'inv-1', amountMinor: 300_000n }], targets),
    ).toEqual([]);
  });

  it('rejects over-allocating one document', () => {
    const problems = validateAllocation(
      900_000n,
      [{ documentId: 'inv-1', amountMinor: 400_000n }],
      targets,
    );
    expect(problems[0]).toMatch(/exceeds its outstanding/);
  });

  it('rejects allocating more than the payment', () => {
    const problems = validateAllocation(
      100_000n,
      [
        { documentId: 'inv-1', amountMinor: 300_000n },
        { documentId: 'inv-2', amountMinor: 500_000n },
      ],
      targets,
    );
    expect(problems.some((p) => /exceed the payment amount/.test(p))).toBe(true);
  });

  it('rejects an unknown document', () => {
    const problems = validateAllocation(
      100_000n,
      [{ documentId: 'inv-9', amountMinor: 100n }],
      targets,
    );
    expect(problems[0]).toMatch(/not open for this contact/);
  });

  it('rejects a zero allocation', () => {
    const problems = validateAllocation(
      100_000n,
      [{ documentId: 'inv-1', amountMinor: 0n }],
      targets,
    );
    expect(problems[0]).toMatch(/greater than zero/);
  });
});
