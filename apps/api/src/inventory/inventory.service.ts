import { HttpStatus, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import {
  applyReceipt,
  costIssue,
  InventoryError,
  Money,
  type CostLayer,
  type CostingMethod,
  type InventoryState,
} from '@acct/domain';
import type { MoneyDto } from '@acct/shared';
import type postgres from 'postgres';
import { Database } from '../db/db.module';
import { LedgerError } from '../common/problem.filter';
import { insertLines, requirePeriodFor } from '../ledger/ledger.service';

export interface ItemDto {
  id: string;
  sku: string;
  name: string;
  nameAr: string | null;
  isStocked: boolean;
  costingMethod: CostingMethod;
  unitOfMeasure: string;
  standardCost: MoneyDto;
  salePrice: MoneyDto;
  inventoryAccountId: string;
  cogsAccountId: string;
  varianceAccountId: string | null;
  isActive: boolean;
}

export interface MovementResult {
  movementId: string;
  entryId: string;
  quantity: string;
  cost: MoneyDto;
  unitCost: MoneyDto;
  consumed: { layerId: string; quantity: string; costMinor: string }[];
  onHand: { quantity: string; value: MoneyDto };
}

interface ItemRow {
  id: string;
  sku: string;
  name: string;
  name_ar: string | null;
  is_stocked: boolean;
  costing_method: CostingMethod;
  unit_of_measure: string;
  currency_code: string;
  standard_cost_minor: string;
  sale_price_minor: string;
  inventory_account_id: string;
  cogs_account_id: string;
  variance_account_id: string | null;
  is_active: boolean;
}

/**
 * Inventory. Every movement does two things in one transaction: it changes the
 * stock, and it posts the matching journal entry. They cannot drift apart,
 * because a failure in either rolls back both.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly db: Database) {}

  // --- reference data ---------------------------------------------------

  async listWarehouses(tenantId: string) {
    return this.db.read(tenantId, (tx) =>
      tx<{ id: string; code: string; name: string; is_active: boolean }[]>`
        SELECT id, code, name, is_active FROM warehouses ORDER BY code`,
    );
  }

  async createWarehouse(
    tenantId: string,
    input: { code: string; name: string; nameAr?: string | undefined; address?: string | undefined },
    actorId?: string,
  ) {
    const [row] = await this.db.transaction(
      tenantId,
      (tx) =>
        tx<{ id: string; code: string; name: string }[]>`
          INSERT INTO warehouses (tenant_id, code, name, name_ar, address, created_by)
          VALUES (${tenantId}, ${input.code}, ${input.name}, ${input.nameAr ?? null},
                  ${input.address ?? null}, ${actorId ?? null})
          RETURNING id, code, name`,
      { userId: actorId },
    );
    return row!;
  }

  async listItems(tenantId: string): Promise<ItemDto[]> {
    const rows = await this.db.read(tenantId, (tx) =>
      tx<ItemRow[]>`
        SELECT id, sku, name, name_ar, is_stocked, costing_method, unit_of_measure, currency_code,
               standard_cost_minor::text, sale_price_minor::text, inventory_account_id,
               cogs_account_id, variance_account_id, is_active
          FROM items ORDER BY sku`,
    );
    return rows.map(toItemDto);
  }

  async createItem(
    tenantId: string,
    input: {
      sku: string;
      name: string;
      nameAr?: string | undefined;
      isStocked?: boolean | undefined;
      costingMethod: CostingMethod;
      unitOfMeasure?: string | undefined;
      standardCostMinor?: string | undefined;
      salePriceMinor?: string | undefined;
      inventoryAccountId: string;
      cogsAccountId: string;
      varianceAccountId?: string | undefined;
    },
    actorId?: string,
  ): Promise<ItemDto> {
    try {
      const [row] = await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          return tx<ItemRow[]>`
            INSERT INTO items (
              tenant_id, sku, name, name_ar, is_stocked, costing_method, unit_of_measure,
              currency_code, standard_cost_minor, sale_price_minor,
              inventory_account_id, cogs_account_id, variance_account_id, created_by
            ) VALUES (
              ${tenantId}, ${input.sku}, ${input.name}, ${input.nameAr ?? null},
              ${input.isStocked ?? true}, ${input.costingMethod}::costing_method,
              ${input.unitOfMeasure ?? 'PCE'}, ${currency},
              ${input.standardCostMinor ?? '0'}, ${input.salePriceMinor ?? '0'},
              ${input.inventoryAccountId}, ${input.cogsAccountId},
              ${input.varianceAccountId ?? null}, ${actorId ?? null}
            )
            RETURNING id, sku, name, name_ar, is_stocked, costing_method, unit_of_measure,
                      currency_code, standard_cost_minor::text, sale_price_minor::text,
                      inventory_account_id, cogs_account_id, variance_account_id, is_active`;
        },
        { userId: actorId },
      );
      return toItemDto(row!);
    } catch (error) {
      throw translate(error);
    }
  }

  // --- movements --------------------------------------------------------

  /** Goods in: stock rises, and the value lands in the inventory account. */
  async receive(
    tenantId: string,
    input: {
      itemId: string;
      warehouseId: string;
      quantity: string;
      unitCostMinor: string;
      movementDate: string;
      offsetAccountId: string;
      reference?: string | undefined;
      memo?: string | undefined;
    },
    idempotencyKey?: string,
    actorId?: string,
  ): Promise<MovementResult> {
    return this.movement(tenantId, 'receipt', input, idempotencyKey, actorId);
  }

  /** Goods out: stock falls at its own cost, and cost of sales takes the charge. */
  async issue(
    tenantId: string,
    input: {
      itemId: string;
      warehouseId: string;
      quantity: string;
      movementDate: string;
      offsetAccountId?: string | undefined;
      reference?: string | undefined;
      memo?: string | undefined;
    },
    idempotencyKey?: string,
    actorId?: string,
  ): Promise<MovementResult> {
    return this.movement(tenantId, 'issue', { ...input, unitCostMinor: '0' }, idempotencyKey, actorId);
  }

  private async movement(
    tenantId: string,
    kind: 'receipt' | 'issue',
    input: {
      itemId: string;
      warehouseId: string;
      quantity: string;
      unitCostMinor: string;
      movementDate: string;
      offsetAccountId?: string | undefined;
      reference?: string | undefined;
      memo?: string | undefined;
    },
    idempotencyKey?: string,
    actorId?: string,
  ): Promise<MovementResult> {
    if (idempotencyKey) {
      const replay = await this.findByExternalId(tenantId, idempotencyKey);
      if (replay) return replay;
    }

    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          const item = await this.requireItem(tx, input.itemId);
          if (!item.is_stocked) {
            throw new LedgerError(
              'ITEM_NOT_STOCKED',
              `${item.sku} is a service item and carries no stock`,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }

          const state = await this.loadState(tx, tenantId, item, input.warehouseId, currency);

          let costMinor: string;
          let consumed: MovementResult['consumed'] = [];
          let next: InventoryState;
          let varianceMinor = '0';

          if (kind === 'receipt') {
            next = applyReceipt(state, {
              quantity: input.quantity,
              unitCostMinor: input.unitCostMinor,
              // The layer id is filled in below, once the row exists.
              layerId: PENDING_LAYER,
            });
            varianceMinor = next.purchasePriceVarianceMinor ?? '0';
            costMinor =
              item.costing_method === 'standard'
                ? new Decimal(item.standard_cost_minor).mul(input.quantity).toFixed(0)
                : new Decimal(input.unitCostMinor).mul(input.quantity).toFixed(0);
          } else {
            const result = costIssue(state, { quantity: input.quantity });
            next = result.state;
            costMinor = result.costMinor;
            consumed = result.consumed;
          }

          const [movement] = await tx<{ id: string }[]>`
            INSERT INTO stock_movements (
              tenant_id, item_id, warehouse_id, kind, movement_date, quantity,
              unit_cost_minor, value_minor, currency_code, reference, memo,
              source_system, external_id, created_by
            ) VALUES (
              ${tenantId}, ${input.itemId}, ${input.warehouseId}, ${kind}::movement_kind,
              ${input.movementDate}, ${input.quantity},
              ${unitCostOf(costMinor, input.quantity)}, ${costMinor}, ${currency},
              ${input.reference ?? null}, ${input.memo ?? null},
              ${idempotencyKey ? 'api' : null}, ${idempotencyKey ?? null}, ${actorId ?? null}
            ) RETURNING id`;

          if (kind === 'receipt') {
            const layerId = await this.writeReceiptLayer(tx, tenantId, item, input, movement!.id, costMinor);
            // The domain built the layer before the database gave it an id.
            next = {
              ...next,
              layers: next.layers.map((l) => (l.id === PENDING_LAYER ? { ...l, id: layerId ?? l.id } : l)),
            };
          } else {
            await this.writeConsumptions(tx, tenantId, movement!.id, consumed);
          }

          const entryId = await this.postMovementEntry(tx, tenantId, {
            kind,
            item,
            currency,
            movementDate: input.movementDate,
            costMinor,
            varianceMinor,
            offsetAccountId: input.offsetAccountId,
            memo: input.memo ?? `${kind === 'receipt' ? 'Goods received' : 'Goods issued'}: ${item.sku}`,
            actorId,
          });

          await tx`UPDATE stock_movements SET entry_id = ${entryId} WHERE id = ${movement!.id}`;
          await this.saveBalance(tx, tenantId, input.itemId, input.warehouseId, next, currency);

          return {
            movementId: movement!.id,
            entryId,
            quantity: input.quantity,
            cost: Money.fromMinor(costMinor, currency).toJSON(),
            unitCost: Money.fromMinor(unitCostOf(costMinor, input.quantity), currency).toJSON(),
            consumed,
            onHand: {
              quantity: next.quantity,
              value: Money.fromMinor(next.valueMinor, currency).toJSON(),
            },
          };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * A transfer is an issue from one warehouse and a receipt into another, at
   * the cost the stock left with: moving stock between shelves is not a
   * revaluation, and must not touch profit.
   */
  async transfer(
    tenantId: string,
    input: {
      itemId: string;
      fromWarehouseId: string;
      toWarehouseId: string;
      quantity: string;
      movementDate: string;
      memo?: string | undefined;
    },
    actorId?: string,
  ): Promise<{ out: MovementResult; in: MovementResult }> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new LedgerError(
        'TRANSFER_SAME_WAREHOUSE',
        'A transfer needs two different warehouses',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      return await this.db.transaction(
        tenantId,
        async (tx) => {
          const currency = await this.baseCurrency(tx, tenantId);
          const item = await this.requireItem(tx, input.itemId);

          const fromState = await this.loadState(tx, tenantId, item, input.fromWarehouseId, currency);
          const issued = costIssue(fromState, { quantity: input.quantity });

          const outId = await this.writeMovement(tx, tenantId, {
            itemId: input.itemId,
            warehouseId: input.fromWarehouseId,
            kind: 'transfer_out',
            movementDate: input.movementDate,
            quantity: input.quantity,
            costMinor: issued.costMinor,
            currency,
            memo: input.memo ?? null,
            actorId,
          });
          await this.writeConsumptions(tx, tenantId, outId, issued.consumed);
          await this.saveBalance(tx, tenantId, input.itemId, input.fromWarehouseId, issued.state, currency);

          const toState = await this.loadState(tx, tenantId, item, input.toWarehouseId, currency);
          const unitCost = unitCostOf(issued.costMinor, input.quantity);
          const received = applyReceipt(toState, {
            quantity: input.quantity,
            unitCostMinor: unitCost,
            layerId: PENDING_LAYER,
          });

          const inId = await this.writeMovement(tx, tenantId, {
            itemId: input.itemId,
            warehouseId: input.toWarehouseId,
            kind: 'transfer_in',
            movementDate: input.movementDate,
            quantity: input.quantity,
            costMinor: issued.costMinor,
            currency,
            memo: input.memo ?? null,
            actorId,
          });
          let landed = received;
          if (item.costing_method === 'fifo') {
            const [layer] = await tx<{ id: string }[]>`
              INSERT INTO stock_cost_layers (
                tenant_id, item_id, warehouse_id, receipt_movement_id, movement_date,
                unit_cost_minor, original_quantity, remaining_quantity, remaining_value_minor
              ) VALUES (
                ${tenantId}, ${input.itemId}, ${input.toWarehouseId}, ${inId}, ${input.movementDate},
                ${unitCost}, ${input.quantity}, ${input.quantity}, ${issued.costMinor}
              ) RETURNING id`;
            landed = {
              ...received,
              layers: received.layers.map((l) =>
                l.id === PENDING_LAYER ? { ...l, id: layer!.id } : l,
              ),
            };
          }
          await this.saveBalance(tx, tenantId, input.itemId, input.toWarehouseId, landed, currency);

          /*
           * No journal entry: the value never left the inventory account. If the
           * two warehouses ever post to different accounts, this is where the
           * transfer entry would belong.
           */
          const cost = Money.fromMinor(issued.costMinor, currency).toJSON();
          const unit = Money.fromMinor(unitCost, currency).toJSON();
          return {
            out: {
              movementId: outId,
              entryId: '',
              quantity: input.quantity,
              cost,
              unitCost: unit,
              consumed: issued.consumed,
              onHand: {
                quantity: issued.state.quantity,
                value: Money.fromMinor(issued.state.valueMinor, currency).toJSON(),
              },
            },
            in: {
              movementId: inId,
              entryId: '',
              quantity: input.quantity,
              cost,
              unitCost: unit,
              consumed: [],
              onHand: {
                quantity: landed.quantity,
                value: Money.fromMinor(landed.valueMinor, currency).toJSON(),
              },
            },
          };
        },
        { userId: actorId },
      );
    } catch (error) {
      throw translate(error);
    }
  }

  // --- reporting --------------------------------------------------------

  async valuationReport(tenantId: string, asOfDate?: string) {
    return this.db.read(tenantId, async (tx) => {
      const currency = await this.baseCurrency(tx, tenantId);
      const rows = await tx<
        {
          item_id: string;
          sku: string;
          name: string;
          warehouse_id: string;
          warehouse: string;
          costing_method: string;
          quantity: string;
          value_minor: string;
        }[]
      >`
        SELECT m.item_id, i.sku, i.name, m.warehouse_id, w.code AS warehouse, i.costing_method,
               SUM(CASE WHEN m.kind IN ('receipt','transfer_in') THEN m.quantity
                        ELSE -m.quantity END)::text AS quantity,
               SUM(CASE WHEN m.kind IN ('receipt','transfer_in') THEN m.value_minor
                        ELSE -m.value_minor END)::text AS value_minor
          FROM stock_movements m
          JOIN items i ON i.id = m.item_id
          JOIN warehouses w ON w.id = m.warehouse_id
         ${asOfDate ? tx`WHERE m.movement_date <= ${asOfDate}` : tx``}
         GROUP BY m.item_id, i.sku, i.name, m.warehouse_id, w.code, i.costing_method
         ORDER BY i.sku, w.code`;

      let total = Money.zero(currency);
      const items = rows.map((r) => {
        const value = Money.fromMinor(r.value_minor, currency);
        total = total.add(value);
        return {
          itemId: r.item_id,
          sku: r.sku,
          name: r.name,
          warehouseId: r.warehouse_id,
          warehouse: r.warehouse,
          costingMethod: r.costing_method,
          quantity: r.quantity,
          value: value.toJSON(),
        };
      });

      /*
       * The valuation must equal what the inventory accounts carry: if the two
       * disagree, stock and ledger have drifted and the report says so rather
       * than quietly showing one of them.
       */
      const [ledger] = await tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(CASE WHEN l.side = 'debit' THEN l.base_amount_minor
                                 ELSE -l.base_amount_minor END), 0)::text AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.entry_id
          JOIN accounts a ON a.id = l.account_id
         WHERE e.status IN ('posted','reversed')
           AND a.subtype = 'inventory'
           ${asOfDate ? tx`AND e.entry_date <= ${asOfDate}` : tx``}`;

      const ledgerValue = Money.fromMinor(ledger!.balance, currency);
      return {
        asOfDate: asOfDate ?? null,
        currency,
        items,
        totalValue: total.toJSON(),
        ledgerInventoryValue: ledgerValue.toJSON(),
        agreesWithLedger: ledgerValue.equals(total),
      };
    });
  }

  async movements(tenantId: string, itemId: string) {
    return this.db.read(tenantId, async (tx) => {
      const currency = await this.baseCurrency(tx, tenantId);
      const rows = await tx<
        {
          id: string;
          kind: string;
          movement_date: string;
          quantity: string;
          unit_cost_minor: string;
          value_minor: string;
          warehouse: string;
          entry_id: string | null;
          reference: string | null;
        }[]
      >`
        SELECT m.id, m.kind, to_char(m.movement_date,'YYYY-MM-DD') AS movement_date,
               m.quantity::text, m.unit_cost_minor::text, m.value_minor::text,
               w.code AS warehouse, m.entry_id, m.reference
          FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
         WHERE m.item_id = ${itemId}
         ORDER BY m.movement_date, m.id`;
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        movementDate: r.movement_date,
        quantity: r.quantity,
        unitCost: Money.fromMinor(r.unit_cost_minor, currency).toJSON(),
        value: Money.fromMinor(r.value_minor, currency).toJSON(),
        warehouse: r.warehouse,
        entryId: r.entry_id,
        reference: r.reference,
      }));
    });
  }

  // --- internals --------------------------------------------------------

  private async baseCurrency(tx: postgres.TransactionSql, tenantId: string): Promise<string> {
    const [row] = await tx<{ base_currency: string }[]>`
      SELECT tenant_base_currency(${tenantId}::uuid) AS base_currency`;
    return row!.base_currency;
  }

  private async requireItem(tx: postgres.TransactionSql, itemId: string): Promise<ItemRow> {
    const [item] = await tx<ItemRow[]>`
      SELECT id, sku, name, name_ar, is_stocked, costing_method, unit_of_measure, currency_code,
             standard_cost_minor::text, sale_price_minor::text, inventory_account_id,
             cogs_account_id, variance_account_id, is_active
        FROM items WHERE id = ${itemId}`;
    if (!item) throw new LedgerError('ITEM_NOT_FOUND', `No item ${itemId}`, HttpStatus.NOT_FOUND);
    return item;
  }

  /** Read the current stock position, including the FIFO layers, under a row lock. */
  private async loadState(
    tx: postgres.TransactionSql,
    tenantId: string,
    item: ItemRow,
    warehouseId: string,
    currency: string,
  ): Promise<InventoryState> {
    // Lock the balance row so two concurrent issues cannot both see the same stock.
    const [balance] = await tx<{ quantity: string; value_minor: string }[]>`
      SELECT quantity::text, value_minor::text FROM stock_balances
       WHERE item_id = ${item.id} AND warehouse_id = ${warehouseId} FOR UPDATE`;

    const layers: CostLayer[] =
      item.costing_method === 'fifo'
        ? (
            await tx<
              { id: string; unit_cost_minor: string; remaining_quantity: string; remaining_value_minor: string }[]
            >`
              SELECT id, unit_cost_minor::text, remaining_quantity::text, remaining_value_minor::text
                FROM stock_cost_layers
               WHERE item_id = ${item.id} AND warehouse_id = ${warehouseId} AND remaining_quantity > 0
               ORDER BY movement_date, id
                 FOR UPDATE`
          ).map((l) => ({
            id: l.id,
            unitCostMinor: l.unit_cost_minor,
            remainingQuantity: l.remaining_quantity,
            remainingValueMinor: l.remaining_value_minor,
          }))
        : [];

    return {
      method: item.costing_method,
      currency,
      quantity: balance?.quantity ?? '0',
      valueMinor: balance?.value_minor ?? '0',
      layers,
      standardCostMinor: item.standard_cost_minor,
    };
  }

  private async saveBalance(
    tx: postgres.TransactionSql,
    tenantId: string,
    itemId: string,
    warehouseId: string,
    state: InventoryState,
    currency: string,
  ): Promise<void> {
    await tx`
      INSERT INTO stock_balances (tenant_id, item_id, warehouse_id, quantity, value_minor, currency_code)
      VALUES (${tenantId}, ${itemId}, ${warehouseId}, ${state.quantity}, ${state.valueMinor}, ${currency})
      ON CONFLICT (tenant_id, item_id, warehouse_id)
        DO UPDATE SET quantity = EXCLUDED.quantity,
                      value_minor = EXCLUDED.value_minor,
                      updated_at = now()`;

    // FIFO layers are the authority behind the balance; write back what changed.
    for (const layer of state.layers.filter((l) => l.id !== PENDING_LAYER)) {
      await tx`
        UPDATE stock_cost_layers
           SET remaining_quantity = ${layer.remainingQuantity},
               remaining_value_minor = ${layer.remainingValueMinor}
         WHERE id = ${layer.id}`;
    }
    // A layer the domain dropped is exhausted.
    const keep = state.layers.map((l) => l.id).filter((id) => id !== PENDING_LAYER);
    await tx`
      UPDATE stock_cost_layers
         SET remaining_quantity = 0, remaining_value_minor = 0
       WHERE item_id = ${itemId} AND warehouse_id = ${warehouseId}
         AND remaining_quantity > 0
         ${keep.length > 0 ? tx`AND id NOT IN ${tx(keep)}` : tx``}`;
  }

  private async writeMovement(
    tx: postgres.TransactionSql,
    tenantId: string,
    m: {
      itemId: string;
      warehouseId: string;
      kind: string;
      movementDate: string;
      quantity: string;
      costMinor: string;
      currency: string;
      memo: string | null;
      actorId?: string | undefined;
    },
  ): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO stock_movements (
        tenant_id, item_id, warehouse_id, kind, movement_date, quantity,
        unit_cost_minor, value_minor, currency_code, memo, created_by
      ) VALUES (
        ${tenantId}, ${m.itemId}, ${m.warehouseId}, ${m.kind}::movement_kind,
        ${m.movementDate}, ${m.quantity}, ${unitCostOf(m.costMinor, m.quantity)},
        ${m.costMinor}, ${m.currency}, ${m.memo}, ${m.actorId ?? null}
      ) RETURNING id`;
    return row!.id;
  }

  private async writeReceiptLayer(
    tx: postgres.TransactionSql,
    tenantId: string,
    item: ItemRow,
    input: { itemId: string; warehouseId: string; quantity: string; movementDate: string },
    movementId: string,
    costMinor: string,
  ): Promise<string | null> {
    if (item.costing_method !== 'fifo') return null;
    const [layer] = await tx<{ id: string }[]>`
      INSERT INTO stock_cost_layers (
        tenant_id, item_id, warehouse_id, receipt_movement_id, movement_date,
        unit_cost_minor, original_quantity, remaining_quantity, remaining_value_minor
      ) VALUES (
        ${tenantId}, ${input.itemId}, ${input.warehouseId}, ${movementId}, ${input.movementDate},
        ${unitCostOf(costMinor, input.quantity)}, ${input.quantity}, ${input.quantity}, ${costMinor}
      ) RETURNING id`;
    return layer!.id;
  }

  private async writeConsumptions(
    tx: postgres.TransactionSql,
    tenantId: string,
    movementId: string,
    consumed: MovementResult['consumed'],
  ): Promise<void> {
    for (const c of consumed) {
      await tx`
        INSERT INTO stock_layer_consumptions (tenant_id, issue_movement_id, layer_id, quantity, cost_minor)
        VALUES (${tenantId}, ${movementId}, ${c.layerId}, ${c.quantity}, ${c.costMinor})`;
    }
  }

  /**
   * The journal entry behind a movement.
   *
   * Receipt: inventory is debited with what the stock is carried at, the offset
   * account credited with what was actually paid, and any difference under
   * standard costing lands in the purchase price variance account.
   *
   * Issue: cost of sales is debited and inventory credited with the cost the
   * layers gave up.
   */
  private async postMovementEntry(
    tx: postgres.TransactionSql,
    tenantId: string,
    p: {
      kind: 'receipt' | 'issue';
      item: ItemRow;
      currency: string;
      movementDate: string;
      costMinor: string;
      varianceMinor: string;
      offsetAccountId?: string | undefined;
      memo: string;
      actorId?: string | undefined;
    },
  ): Promise<string> {
    const offsetAccountId = p.offsetAccountId ?? p.item.cogs_account_id;
    const variance = BigInt(p.varianceMinor);
    const carried = BigInt(p.costMinor);

    const lines: { accountId: string; side: 'debit' | 'credit'; amountMinor: string }[] = [];
    if (p.kind === 'receipt') {
      if (!p.offsetAccountId) {
        throw new LedgerError(
          'OFFSET_ACCOUNT_REQUIRED',
          'A goods receipt needs the account the value comes from, usually goods received not invoiced',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      lines.push({ accountId: p.item.inventory_account_id, side: 'debit', amountMinor: carried.toString() });
      if (variance !== 0n) {
        if (!p.item.variance_account_id) {
          throw new LedgerError(
            'NO_VARIANCE_ACCOUNT',
            `${p.item.sku} is costed at standard but has no purchase price variance account`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        // Paid above standard: an unfavourable variance is a debit.
        lines.push({
          accountId: p.item.variance_account_id,
          side: variance > 0n ? 'debit' : 'credit',
          amountMinor: (variance > 0n ? variance : -variance).toString(),
        });
      }
      lines.push({
        accountId: offsetAccountId,
        side: 'credit',
        amountMinor: (carried + variance).toString(),
      });
    } else {
      lines.push({ accountId: p.item.cogs_account_id, side: 'debit', amountMinor: carried.toString() });
      lines.push({ accountId: p.item.inventory_account_id, side: 'credit', amountMinor: carried.toString() });
    }

    const period = await requirePeriodFor(tx, p.movementDate);
    const [entry] = await tx<{ id: string }[]>`
      INSERT INTO journal_entries (
        tenant_id, entry_date, period_id, fiscal_year_id, status, source_module,
        memo, base_currency, created_by, posted_by
      ) VALUES (
        ${tenantId}, ${p.movementDate}, ${period.id}, ${period.fiscal_year_id},
        'posted', 'inventory'::source_module, ${p.memo}, ${p.currency},
        ${p.actorId ?? null}, ${p.actorId ?? null}
      ) RETURNING id`;

    await insertLines(tx, tenantId, entry!.id, lines, p.currency, p.actorId);
    return entry!.id;
  }

  private async findByExternalId(tenantId: string, key: string): Promise<MovementResult | null> {
    return this.db.read(tenantId, async (tx) => {
      const [row] = await tx<
        {
          id: string;
          entry_id: string | null;
          quantity: string;
          value_minor: string;
          unit_cost_minor: string;
          currency_code: string;
          item_id: string;
          warehouse_id: string;
        }[]
      >`
        SELECT id, entry_id, quantity::text, value_minor::text, unit_cost_minor::text,
               currency_code, item_id, warehouse_id
          FROM stock_movements WHERE source_system = 'api' AND external_id = ${key}`;
      if (!row) return null;

      const [balance] = await tx<{ quantity: string; value_minor: string }[]>`
        SELECT quantity::text, value_minor::text FROM stock_balances
         WHERE item_id = ${row.item_id} AND warehouse_id = ${row.warehouse_id}`;

      return {
        movementId: row.id,
        entryId: row.entry_id ?? '',
        quantity: row.quantity,
        cost: Money.fromMinor(row.value_minor, row.currency_code).toJSON(),
        unitCost: Money.fromMinor(row.unit_cost_minor, row.currency_code).toJSON(),
        consumed: [],
        onHand: {
          quantity: balance?.quantity ?? '0',
          value: Money.fromMinor(balance?.value_minor ?? '0', row.currency_code).toJSON(),
        },
      };
    });
  }
}

/** Placeholder id for a layer the domain built before the row existed. */
const PENDING_LAYER = '__pending__';

function unitCostOf(costMinor: string, quantity: string): string {
  const q = new Decimal(quantity);
  if (q.isZero()) return '0';
  return new Decimal(costMinor).div(q).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

function toItemDto(row: ItemRow): ItemDto {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    nameAr: row.name_ar,
    isStocked: row.is_stocked,
    costingMethod: row.costing_method,
    unitOfMeasure: row.unit_of_measure,
    standardCost: Money.fromMinor(row.standard_cost_minor, row.currency_code).toJSON(),
    salePrice: Money.fromMinor(row.sale_price_minor, row.currency_code).toJSON(),
    inventoryAccountId: row.inventory_account_id,
    cogsAccountId: row.cogs_account_id,
    varianceAccountId: row.variance_account_id,
    isActive: row.is_active,
  };
}

function translate(error: unknown): unknown {
  if (error instanceof InventoryError) {
    return new LedgerError(error.code, error.message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (error instanceof LedgerError) return error;
  const message = String((error as { message?: string }).message ?? error);
  if (/items_tenant_id_sku_key|items_sku/.test(message)) {
    return new LedgerError('SKU_TAKEN', message, HttpStatus.CONFLICT);
  }
  if (/items_standard_needs_cost/.test(message)) {
    return new LedgerError(
      'STANDARD_COST_REQUIRED',
      'An item costed at standard needs a standard cost; otherwise every issue would be valued at zero',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (/items_standard_needs_variance_account/.test(message)) {
    return new LedgerError(
      'VARIANCE_ACCOUNT_REQUIRED',
      'An item costed at standard needs a purchase price variance account',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return error;
}
