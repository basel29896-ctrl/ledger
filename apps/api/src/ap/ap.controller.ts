import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ApService } from './ap.service';
import { ArService } from '../ar/ar.service';
import { zodPipe } from '../common/zod.pipe';
import { IdempotencyKey } from '../common/tenant';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const minorUnits = z.string().regex(/^\d+$/, 'non-negative integer minor units');
const quantity = z.string().regex(/^\d+(\.\d{1,4})?$/, 'positive quantity, up to 4 decimals');

const purchaseLineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity,
  unitPriceMinor: minorUnits,
  expenseAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().optional(),
  orderLineId: z.string().uuid().optional(),
});

const createOrderSchema = z.object({
  contactId: z.string().uuid(),
  orderDate: isoDate,
  expectedDate: isoDate.optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(purchaseLineSchema).min(1),
});

const createReceiptSchema = z.object({
  orderId: z.string().uuid(),
  receivedDate: isoDate,
  notes: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().uuid(),
        quantityReceived: quantity,
        description: z.string().max(500).optional(),
      }),
    )
    .min(1),
});

const createBillSchema = z.object({
  contactId: z.string().uuid(),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  vendorInvoiceNo: z.string().max(64).optional(),
  orderId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
  docType: z.enum(['bill', 'debit_note']).default('bill'),
  lines: z.array(purchaseLineSchema).min(1),
});

const createVendorSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  taxNumber: z.string().max(64).optional(),
  email: z.string().email().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});

const payVendorSchema = z.object({
  contactId: z.string().uuid(),
  paymentDate: isoDate,
  amountMinor: minorUnits,
  bankAccountId: z.string().uuid(),
  method: z.string().max(64).optional(),
  reference: z.string().max(200).optional(),
  memo: z.string().max(500).optional(),
  allocations: z
    .array(z.object({ documentId: z.string().uuid(), amountMinor: minorUnits }))
    .optional(),
});

@ApiTags('ap')
@Controller('vendors')
export class VendorsController {
  constructor(private readonly ar: ArService) {}

  @Get()
  @RequirePermissions('ap.vendor.read')
  @ApiOperation({ summary: 'List vendors' })
  list(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.ar.listContacts(tenantId, 'vendor');
  }

  @Post()
  @RequirePermissions('ap.vendor.write')
  @ApiOperation({ summary: 'Create a vendor' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createVendorSchema)) body: z.infer<typeof createVendorSchema>,
  ): Promise<{ id: string }> {
    // Vendors and customers are the same table; only the flags differ.
    return this.ar.createContact(tenantId, { ...body, isCustomer: false, isVendor: true }, user.sub);
  }
}

@ApiTags('ap')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly ap: ApService) {}

  @Post()
  @RequirePermissions('ap.po.write')
  @ApiOperation({ summary: 'Raise a purchase order' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createOrderSchema)) body: z.infer<typeof createOrderSchema>,
  ): Promise<unknown> {
    const { id } = await this.ap.createOrder(tenantId, body, user.sub);
    return this.ap.getOrder(tenantId, id);
  }

  @Get()
  @RequirePermissions('ap.po.read')
  @ApiOperation({ summary: 'List purchase orders' })
  list(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ contactId: z.string().uuid().optional() })))
    query: { contactId?: string },
  ): Promise<unknown[]> {
    return this.ap.listOrders(tenantId, query.contactId);
  }

  @Get(':id')
  @RequirePermissions('ap.po.read')
  @ApiOperation({ summary: 'One purchase order with ordered / received / billed quantities' })
  get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.ap.getOrder(tenantId, id);
  }
}

@ApiTags('ap')
@Controller('goods-receipts')
export class GoodsReceiptsController {
  constructor(private readonly ap: ApService) {}

  @Post()
  @RequirePermissions('ap.grn.write')
  @ApiOperation({ summary: 'Record a goods receipt against a purchase order' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createReceiptSchema)) body: z.infer<typeof createReceiptSchema>,
  ): Promise<{ id: string }> {
    return this.ap.createGoodsReceipt(tenantId, body, user.sub);
  }
}

@ApiTags('ap')
@Controller('bills')
export class BillsController {
  constructor(private readonly ap: ApService) {}

  @Post()
  @RequirePermissions('ap.bill.write')
  @ApiOperation({
    summary: 'Enter a vendor bill',
    description:
      'The three-way match runs on entry and the bill lands in pending_approval. ' +
      'It reaches the ledger only when someone approves it.',
  })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createBillSchema)) body: z.infer<typeof createBillSchema>,
  ): Promise<unknown> {
    const { id } = await this.ap.createBill(tenantId, body, user.sub);
    return this.ap.getBill(tenantId, id);
  }

  @Get()
  @RequirePermissions('ap.bill.read')
  @ApiOperation({ summary: 'List vendor bills' })
  list(
    @TenantId() tenantId: string,
    @Query(
      zodPipe(
        z.object({
          contactId: z.string().uuid().optional(),
          status: z
            .enum(['draft', 'pending_approval', 'approved', 'open', 'paid', 'void'])
            .optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      ),
    )
    query: { contactId?: string; status?: string; limit: number },
  ): Promise<unknown[]> {
    return this.ap.listBills(tenantId, query);
  }

  @Get('match-exceptions')
  @RequirePermissions('ap.bill.read')
  @ApiOperation({ summary: 'Bills the three-way match refused' })
  exceptions(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.ap.matchExceptions(tenantId);
  }

  @Get(':id')
  @RequirePermissions('ap.bill.read')
  @ApiOperation({ summary: 'One bill with its lines and approval history' })
  get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.ap.getBill(tenantId, id);
  }

  @Get(':id/match')
  @RequirePermissions('ap.bill.read')
  @ApiOperation({ summary: 'Three-way match detail: ordered, received, billed' })
  match(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.ap.matchReport(tenantId, id);
  }

  @Post(':id/override-match')
  @RequirePermissions('ap.bill.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a match exception with a stated reason' })
  async override(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ reason: z.string().min(1).max(500) }))) body: { reason: string },
  ): Promise<unknown> {
    await this.ap.overrideMatch(tenantId, id, body.reason, user.sub);
    return this.ap.getBill(tenantId, id);
  }

  @Post(':id/approve')
  @RequirePermissions('ap.bill.approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve a bill and post it',
    description:
      'Refused if the approver entered the bill and it is above the approval threshold, ' +
      'or while match exceptions are unresolved.',
  })
  async approve(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ reason: z.string().max(500).optional() }))) body: { reason?: string },
  ): Promise<unknown> {
    await this.ap.approveBill(tenantId, id, { id: user.sub, permissions: user.perms }, body.reason);
    return this.ap.getBill(tenantId, id);
  }

  @Post(':id/reject')
  @RequirePermissions('ap.bill.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a bill back to the clerk' })
  async reject(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ reason: z.string().min(1).max(500) }))) body: { reason: string },
  ): Promise<unknown> {
    await this.ap.rejectBill(tenantId, id, body.reason, user.sub);
    return this.ap.getBill(tenantId, id);
  }
}

@ApiTags('ap')
@Controller('vendor-payments')
export class VendorPaymentsController {
  constructor(private readonly ap: ApService) {}

  @Post()
  @RequirePermissions('ap.payment.write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Pay a vendor, settling the oldest bills first unless told otherwise' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(payVendorSchema)) body: z.infer<typeof payVendorSchema>,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string }> {
    const { id, replayed } = await this.ap.payVendor(tenantId, body, {
      actorId: user.sub,
      idempotencyKey,
    });
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return { id };
  }

  @Get('run')
  @RequirePermissions('ap.payment.read')
  @ApiOperation({ summary: 'Payment run: everything due by a date, grouped by vendor' })
  run(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ dueBy: isoDate }))) query: { dueBy: string },
  ): Promise<unknown> {
    return this.ap.paymentRun(tenantId, query.dueBy);
  }
}

@ApiTags('reports')
@Controller('reports')
export class ApReportsController {
  constructor(private readonly ap: ApService) {}

  @Get('ap-aging')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'AP aging' })
  aging(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ asOf: isoDate.default(() => new Date().toISOString().slice(0, 10)) })))
    query: { asOf: string },
  ): Promise<unknown> {
    return this.ap.agingReport(tenantId, query.asOf);
  }

  @Get('cash-requirements')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'What must be paid, and by when' })
  cash(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ asOf: isoDate.default(() => new Date().toISOString().slice(0, 10)) })))
    query: { asOf: string },
  ): Promise<unknown> {
    return this.ap.cashRequirements(tenantId, query.asOf);
  }
}
