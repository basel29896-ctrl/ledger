import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { InventoryService, type ItemDto, type MovementResult } from './inventory.service';
import { zodPipe } from '../common/zod.pipe';
import { IdempotencyKey } from '../common/tenant';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const quantity = z.string().regex(/^\d+(\.\d{1,6})?$/, 'a positive decimal quantity');
const minor = z.string().regex(/^\d+$/, 'non-negative integer minor units');

const warehouseSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
});

const itemSchema = z.object({
  sku: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  isStocked: z.boolean().default(true),
  costingMethod: z.enum(['fifo', 'weighted_average', 'standard']),
  unitOfMeasure: z.string().max(10).default('PCE'),
  standardCostMinor: minor.optional(),
  salePriceMinor: minor.optional(),
  inventoryAccountId: z.string().uuid(),
  cogsAccountId: z.string().uuid(),
  varianceAccountId: z.string().uuid().optional(),
});

const receiptSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity,
  unitCostMinor: minor,
  movementDate: isoDate,
  offsetAccountId: z.string().uuid(),
  reference: z.string().max(100).optional(),
  memo: z.string().max(500).optional(),
});

const issueSchema = z.object({
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity,
  movementDate: isoDate,
  reference: z.string().max(100).optional(),
  memo: z.string().max(500).optional(),
});

const transferSchema = z.object({
  itemId: z.string().uuid(),
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  quantity,
  movementDate: isoDate,
  memo: z.string().max(500).optional(),
});

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('warehouses')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'List warehouses' })
  listWarehouses(@TenantId() tenantId: string) {
    return this.inventory.listWarehouses(tenantId);
  }

  @Post('warehouses')
  @RequirePermissions('inventory.write')
  @ApiOperation({ summary: 'Create a warehouse' })
  createWarehouse(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(warehouseSchema)) body: z.infer<typeof warehouseSchema>,
  ) {
    return this.inventory.createWarehouse(tenantId, body, user.sub);
  }

  @Get('items')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'List items' })
  listItems(@TenantId() tenantId: string): Promise<ItemDto[]> {
    return this.inventory.listItems(tenantId);
  }

  @Post('items')
  @RequirePermissions('inventory.write')
  @ApiOperation({
    summary: 'Create an item',
    description:
      'The costing method is fixed at creation: changing it later would restate every ' +
      'movement already posted.',
  })
  createItem(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(itemSchema)) body: z.infer<typeof itemSchema>,
  ): Promise<ItemDto> {
    return this.inventory.createItem(tenantId, body, user.sub);
  }

  @Get('items/:id/movements')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Movement history for one item, with the entry behind each' })
  movements(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.movements(tenantId, id);
  }

  @Post('receipts')
  @RequirePermissions('inventory.write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Receive stock',
    description: 'Raises stock and posts the inventory entry in the same transaction.',
  })
  @ApiOkResponse({ description: 'The movement, the entry it posted, and the new position' })
  receive(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(receiptSchema)) body: z.infer<typeof receiptSchema>,
    @IdempotencyKey() key?: string,
  ): Promise<MovementResult> {
    return this.inventory.receive(tenantId, body, key, user.sub);
  }

  @Post('issues')
  @RequirePermissions('inventory.write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Issue stock',
    description:
      'Values the issue from the cost layers and posts cost of sales. Issuing more than ' +
      'is on hand is refused rather than valued at a guess.',
  })
  issue(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(issueSchema)) body: z.infer<typeof issueSchema>,
    @IdempotencyKey() key?: string,
  ): Promise<MovementResult> {
    return this.inventory.issue(tenantId, body, key, user.sub);
  }

  @Post('transfers')
  @RequirePermissions('inventory.write')
  @ApiOperation({
    summary: 'Transfer stock between warehouses',
    description: 'Moves stock at the cost it left with: a transfer is not a revaluation.',
  })
  transfer(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(transferSchema)) body: z.infer<typeof transferSchema>,
  ) {
    return this.inventory.transfer(tenantId, body, user.sub);
  }

  @Get('valuation')
  @RequirePermissions('inventory.read')
  @ApiOperation({
    summary: 'Stock valuation, and whether it agrees with the inventory accounts',
    description:
      'Reports the ledger inventory balance next to the stock valuation. A disagreement ' +
      'is surfaced, not smoothed over.',
  })
  valuation(@TenantId() tenantId: string, @Query('asOfDate') asOfDate?: string) {
    return this.inventory.valuationReport(tenantId, asOfDate);
  }
}
