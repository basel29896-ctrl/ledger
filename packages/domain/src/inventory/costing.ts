import Decimal from 'decimal.js';
import { Money } from '../money/money';

/**
 * Inventory costing. Three methods, one rule: the cost of what leaves is
 * derived from what was actually paid for what came in. Nothing here invents a
 * cost, and issuing more than is on hand is an error rather than a guess.
 *
 * Quantities are decimals (stock is weighed as often as it is counted); costs
 * are minor units of the tenant's currency and never touch a float.
 */

export type CostingMethod = 'fifo' | 'weighted_average' | 'standard';

export class InventoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryError';
  }
}

export interface CostLayer {
  /** The receipt that created the layer, so an issue can name what it consumed. */
  id: string;
  unitCostMinor: string;
  remainingQuantity: string;
  remainingValueMinor: string;
}

export interface InventoryState {
  method: CostingMethod;
  currency: string;
  quantity: string;
  valueMinor: string;
  layers: CostLayer[];
  /** Only meaningful under standard costing. */
  standardCostMinor: string;
  /** Variance booked by the last receipt: positive is unfavourable. */
  purchasePriceVarianceMinor?: string;
}

export interface IssueResult {
  costMinor: string;
  consumed: { layerId: string; quantity: string; costMinor: string }[];
  state: InventoryState;
}

function qty(value: string, what: string): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite()) throw new InventoryError('QUANTITY_INVALID', `${what} is not a number: ${value}`);
  return d;
}

function requirePositive(value: Decimal, what: string): Decimal {
  if (value.lessThanOrEqualTo(0)) {
    throw new InventoryError('QUANTITY_NOT_POSITIVE', `${what} must be greater than zero, got ${value}`);
  }
  return value;
}

/** Round a Decimal amount of minor units to a whole minor unit, half-up. */
function toMinor(value: Decimal): bigint {
  return BigInt(value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

export function applyReceipt(
  state: InventoryState,
  receipt: { quantity: string; unitCostMinor: string; layerId?: string },
): InventoryState {
  const quantity = requirePositive(qty(receipt.quantity, 'Receipt quantity'), 'Receipt quantity');
  const unitCost = new Decimal(receipt.unitCostMinor);
  if (unitCost.isNegative()) {
    throw new InventoryError('COST_NEGATIVE', `Receipt unit cost cannot be negative: ${receipt.unitCostMinor}`);
  }

  const onHand = qty(state.quantity, 'Quantity on hand');

  if (state.method === 'standard') {
    /*
     * Stock is carried at standard whatever was paid; the difference is a
     * purchase price variance recognised at receipt, not buried in the asset.
     */
    const standard = new Decimal(state.standardCostMinor);
    const variance = unitCost.minus(standard).mul(quantity);
    const addedValue = standard.mul(quantity);
    return {
      ...state,
      quantity: onHand.plus(quantity).toString(),
      valueMinor: (BigInt(state.valueMinor) + toMinor(addedValue)).toString(),
      layers: [],
      purchasePriceVarianceMinor: toMinor(variance).toString(),
    };
  }

  const layerValue = toMinor(unitCost.mul(quantity));
  const layer: CostLayer = {
    id: receipt.layerId ?? `layer-${state.layers.length + 1}`,
    unitCostMinor: unitCost.toString(),
    remainingQuantity: quantity.toString(),
    remainingValueMinor: layerValue.toString(),
  };

  return {
    ...state,
    quantity: onHand.plus(quantity).toString(),
    valueMinor: (BigInt(state.valueMinor) + layerValue).toString(),
    // Receipts stay in arrival order: FIFO depends on it.
    layers: state.method === 'fifo' ? [...state.layers, layer] : [],
    purchasePriceVarianceMinor: '0',
  };
}

export function costIssue(state: InventoryState, issue: { quantity: string }): IssueResult {
  const quantity = requirePositive(qty(issue.quantity, 'Issue quantity'), 'Issue quantity');
  const onHand = qty(state.quantity, 'Quantity on hand');

  if (quantity.greaterThan(onHand)) {
    throw new InventoryError(
      'INSUFFICIENT_STOCK',
      `Cannot issue ${quantity} when ${onHand} is on hand: the cost of the shortfall is unknown, ` +
        `so the issue is refused rather than valued at a guess.`,
    );
  }

  if (state.method === 'standard') {
    const cost = toMinor(new Decimal(state.standardCostMinor).mul(quantity));
    return {
      costMinor: cost.toString(),
      consumed: [],
      state: {
        ...state,
        quantity: onHand.minus(quantity).toString(),
        valueMinor: (BigInt(state.valueMinor) - cost).toString(),
      },
    };
  }

  if (state.method === 'weighted_average') {
    const value = BigInt(state.valueMinor);
    /*
     * Issuing everything costs exactly what everything cost: taking the whole
     * remaining value avoids leaving a rounding residue behind with no stock
     * to carry it.
     */
    const cost = quantity.equals(onHand)
      ? value
      : toMinor(new Decimal(value.toString()).mul(quantity).div(onHand));
    return {
      costMinor: cost.toString(),
      consumed: [],
      state: {
        ...state,
        quantity: onHand.minus(quantity).toString(),
        valueMinor: (value - cost).toString(),
      },
    };
  }

  // FIFO: walk the layers oldest first.
  let outstanding = quantity;
  let totalCost = 0n;
  const consumed: IssueResult['consumed'] = [];
  const layers: CostLayer[] = [];

  for (const layer of state.layers) {
    if (outstanding.isZero()) {
      layers.push(layer);
      continue;
    }
    const available = qty(layer.remainingQuantity, 'Layer quantity');
    const take = Decimal.min(available, outstanding);
    // Exhausting a layer costs its whole remaining value, so nothing is stranded.
    const cost = take.equals(available)
      ? BigInt(layer.remainingValueMinor)
      : toMinor(new Decimal(layer.unitCostMinor).mul(take));

    consumed.push({ layerId: layer.id, quantity: take.toString(), costMinor: cost.toString() });
    totalCost += cost;
    outstanding = outstanding.minus(take);

    const left = available.minus(take);
    if (left.greaterThan(0)) {
      layers.push({
        ...layer,
        remainingQuantity: left.toString(),
        remainingValueMinor: (BigInt(layer.remainingValueMinor) - cost).toString(),
      });
    }
  }

  if (!outstanding.isZero()) {
    // The quantity check above should have caught this; if the layers and the
    // header ever disagree, say so rather than issuing stock that is not there.
    throw new InventoryError(
      'LAYERS_INCONSISTENT',
      `Cost layers hold less than the quantity on hand: ${outstanding} could not be sourced. ` +
        `Rebuild the item's layers before issuing.`,
    );
  }

  return {
    costMinor: totalCost.toString(),
    consumed,
    state: {
      ...state,
      quantity: onHand.minus(quantity).toString(),
      valueMinor: (BigInt(state.valueMinor) - totalCost).toString(),
      layers,
    },
  };
}

/** What the stock on hand is worth, in the tenant's currency. */
export function valuation(state: InventoryState): ReturnType<Money['toJSON']> {
  return Money.fromMinor(state.valueMinor, state.currency).toJSON();
}

/** The average unit cost implied by the current state, for display only. */
export function averageUnitCostMinor(state: InventoryState): string {
  const onHand = new Decimal(state.quantity);
  if (onHand.isZero()) return '0';
  return new Decimal(state.valueMinor).div(onHand).toDecimalPlaces(4).toString();
}
