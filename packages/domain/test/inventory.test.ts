import { describe, expect, it } from 'vitest';
import {
  applyReceipt,
  costIssue,
  InventoryError,
  valuation,
  type CostLayer,
  type InventoryState,
} from '../src/inventory/costing';

const JOD = 'JOD';

function empty(method: InventoryState['method']): InventoryState {
  return { method, currency: JOD, quantity: '0', valueMinor: '0', layers: [], standardCostMinor: '0' };
}

describe('FIFO', () => {
  const afterReceipts = [
    { qty: '10', unitCostMinor: '1000', id: 'L1' },
    { qty: '10', unitCostMinor: '1200', id: 'L2' },
  ].reduce(
    (state, r) => applyReceipt(state, { quantity: r.qty, unitCostMinor: r.unitCostMinor, layerId: r.id }),
    empty('fifo'),
  );

  it('values stock at what was actually paid for it', () => {
    expect(afterReceipts.quantity).toBe('20');
    // 10 × 1.000 + 10 × 1.200 = 22.000
    expect(valuation(afterReceipts).amount).toBe('22.000');
  });

  it('consumes the oldest layer first', () => {
    const issue = costIssue(afterReceipts, { quantity: '12' });
    expect(issue.costMinor).toBe('12400'); // 10 × 1000 + 2 × 1200
    expect(issue.consumed).toEqual([
      { layerId: 'L1', quantity: '10', costMinor: '10000' },
      { layerId: 'L2', quantity: '2', costMinor: '2400' },
    ]);
    expect(issue.state.quantity).toBe('8');
    expect(valuation(issue.state).amount).toBe('9.600');
  });

  it('leaves the earlier layers untouched when an issue fits in one', () => {
    const issue = costIssue(afterReceipts, { quantity: '4' });
    expect(issue.consumed).toEqual([{ layerId: 'L1', quantity: '4', costMinor: '4000' }]);
    expect(issue.state.layers).toHaveLength(2);
    expect(issue.state.layers[0]?.remainingQuantity).toBe('6');
  });

  it('refuses to issue more than is on hand rather than inventing a cost', () => {
    expect(() => costIssue(afterReceipts, { quantity: '21' })).toThrow(InventoryError);
    expect(() => costIssue(afterReceipts, { quantity: '21' })).toThrow(/on hand/i);
  });

  it('drops a layer once it is exhausted, so the next issue starts at the next one', () => {
    const first = costIssue(afterReceipts, { quantity: '10' });
    expect(first.state.layers).toHaveLength(1);
    const second = costIssue(first.state, { quantity: '1' });
    expect(second.costMinor).toBe('1200');
  });
});

describe('weighted average', () => {
  it('re-averages on every receipt', () => {
    let state = applyReceipt(empty('weighted_average'), { quantity: '10', unitCostMinor: '1000' });
    state = applyReceipt(state, { quantity: '10', unitCostMinor: '1200' });
    // (10,000 + 12,000) / 20 = 1,100 per unit
    expect(state.quantity).toBe('20');
    expect(valuation(state).amount).toBe('22.000');
    const issue = costIssue(state, { quantity: '5' });
    expect(issue.costMinor).toBe('5500');
    expect(valuation(issue.state).amount).toBe('16.500');
  });

  it('keeps the average unchanged across an issue', () => {
    let state = applyReceipt(empty('weighted_average'), { quantity: '3', unitCostMinor: '1000' });
    state = costIssue(state, { quantity: '1' }).state;
    const next = costIssue(state, { quantity: '1' });
    expect(next.costMinor).toBe('1000');
  });

  it('carries the rounding remainder rather than losing it', () => {
    // 1 unit at 1.000 and 2 at 0.001: an average that does not divide evenly.
    let state = applyReceipt(empty('weighted_average'), { quantity: '1', unitCostMinor: '1000' });
    state = applyReceipt(state, { quantity: '2', unitCostMinor: '1' });
    const all = costIssue(state, { quantity: '3' });
    // Whatever the per-unit rounding, issuing everything must cost exactly what
    // everything was bought for, and leave nothing behind.
    expect(all.costMinor).toBe('1002');
    expect(all.state.valueMinor).toBe('0');
    expect(all.state.quantity).toBe('0');
  });
});

describe('standard cost', () => {
  const state: InventoryState = { ...empty('standard'), standardCostMinor: '1000' };

  it('receives at standard and books the difference as a price variance', () => {
    const received = applyReceipt(state, { quantity: '10', unitCostMinor: '1150' });
    expect(valuation(received).amount).toBe('10.000');
    // 10 units bought 0.150 above standard.
    expect(received.purchasePriceVarianceMinor).toBe('1500');
  });

  it('issues at standard whatever was paid', () => {
    const received = applyReceipt(state, { quantity: '10', unitCostMinor: '1150' });
    expect(costIssue(received, { quantity: '4' }).costMinor).toBe('4000');
  });

  it('reports a favourable variance as a negative number', () => {
    const received = applyReceipt(state, { quantity: '10', unitCostMinor: '900' });
    expect(received.purchasePriceVarianceMinor).toBe('-1000');
  });
});

describe('fractional quantities', () => {
  it('handles quantities that are not whole units', () => {
    const state = applyReceipt(empty('fifo'), { quantity: '2.5', unitCostMinor: '4000', layerId: 'L1' });
    const issue = costIssue(state, { quantity: '0.5' });
    expect(issue.costMinor).toBe('2000');
    expect(issue.state.quantity).toBe('2');
  });

  it('refuses a zero or negative movement', () => {
    expect(() => applyReceipt(empty('fifo'), { quantity: '0', unitCostMinor: '1' })).toThrow(InventoryError);
    expect(() => costIssue(empty('fifo'), { quantity: '-1' })).toThrow(InventoryError);
  });
});

describe('layer identity', () => {
  it('keeps receipts in the order they arrived', () => {
    let state = applyReceipt(empty('fifo'), { quantity: '1', unitCostMinor: '100', layerId: 'A' });
    state = applyReceipt(state, { quantity: '1', unitCostMinor: '200', layerId: 'B' });
    const layers: CostLayer[] = state.layers;
    expect(layers.map((l) => l.id)).toEqual(['A', 'B']);
  });
});
