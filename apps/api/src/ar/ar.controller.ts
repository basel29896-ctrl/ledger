import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ArService } from './ar.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { zodPipe } from '../common/zod.pipe';
import { IdempotencyKey } from '../common/tenant';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const minorUnits = z.string().regex(/^\d+$/, 'non-negative integer minor units');

const createContactSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  isCustomer: z.boolean().default(true),
  isVendor: z.boolean().default(false),
  taxNumber: z.string().max(64).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(64).optional(),
  billingAddress: z.string().max(1000).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  creditLimitMinor: minorUnits.optional(),
  defaultCurrency: z.string().length(3).optional(),
});

const invoiceLineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, 'positive quantity, up to 4 decimals'),
  unitPriceMinor: minorUnits,
  revenueAccountId: z.string().uuid(),
  taxCodeId: z.string().uuid().optional(),
  taxInclusive: z.boolean().optional(),
});

const createInvoiceSchema = z.object({
  contactId: z.string().uuid(),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  currencyCode: z.string().length(3).optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  docType: z.enum(['invoice', 'credit_note']).default('invoice'),
  creditsDocumentId: z.string().uuid().optional(),
  post: z.boolean().default(false),
  lines: z.array(invoiceLineSchema).min(1),
});

const allocationSchema = z.object({
  documentId: z.string().uuid(),
  amountMinor: minorUnits,
});

const createReceiptSchema = z.object({
  contactId: z.string().uuid(),
  paymentDate: isoDate,
  amountMinor: minorUnits,
  bankAccountId: z.string().uuid(),
  method: z.string().max(64).optional(),
  reference: z.string().max(200).optional(),
  memo: z.string().max(500).optional(),
  allocations: z.array(allocationSchema).optional(),
});

@ApiTags('ar')
@Controller('customers')
export class CustomersController {
  constructor(private readonly ar: ArService) {}

  @Get()
  @RequirePermissions('ar.customer.read')
  @ApiOperation({ summary: 'List customers with their outstanding balance' })
  list(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.ar.listContacts(tenantId, 'customer');
  }

  @Post()
  @RequirePermissions('ar.customer.write')
  @ApiOperation({ summary: 'Create a customer' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createContactSchema)) body: z.infer<typeof createContactSchema>,
  ): Promise<{ id: string }> {
    return this.ar.createContact(tenantId, body, user.sub);
  }

  @Get(':id/statement')
  @RequirePermissions('ar.customer.read')
  @ApiOperation({ summary: 'Statement of account for one customer' })
  statement(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodPipe(z.object({ fromDate: isoDate, toDate: isoDate })))
    query: { fromDate: string; toDate: string },
  ): Promise<unknown> {
    return this.ar.statement(tenantId, id, query);
  }
}

@ApiTags('ar')
@Controller('sales-documents')
export class SalesDocumentsController {
  constructor(
    private readonly ar: ArService,
    private readonly pdf: InvoicePdfService,
  ) {}

  @Post()
  @RequirePermissions('ar.invoice.write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Create an invoice or credit note',
    description: 'Set post=true to issue it immediately; the journal entry is written in the same transaction.',
  })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createInvoiceSchema)) body: z.infer<typeof createInvoiceSchema>,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const { id, replayed } = await this.ar.createDocument(tenantId, body, {
      post: body.post,
      actorId: user.sub,
      idempotencyKey,
    });
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return this.ar.getDocument(tenantId, id);
  }

  @Get()
  @RequirePermissions('ar.invoice.read')
  @ApiOperation({ summary: 'List sales documents' })
  list(
    @TenantId() tenantId: string,
    @Query(
      zodPipe(
        z.object({
          contactId: z.string().uuid().optional(),
          status: z.enum(['draft', 'open', 'paid', 'void']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      ),
    )
    query: { contactId?: string; status?: string; limit: number },
  ): Promise<unknown[]> {
    return this.ar.listDocuments(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('ar.invoice.read')
  @ApiOperation({ summary: 'Fetch one sales document with its lines and allocations' })
  get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.ar.getDocument(tenantId, id);
  }

  @Post(':id/post')
  @RequirePermissions('ar.invoice.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a draft document to the ledger' })
  async post(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.ar.postDocument(tenantId, id, user.sub);
    return this.ar.getDocument(tenantId, id);
  }

  @Post(':id/void')
  @RequirePermissions('ar.invoice.write')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void a document that has no payments against it' })
  async void(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ reason: z.string().min(1).max(500) }))) body: { reason: string },
  ): Promise<unknown> {
    await this.ar.voidDocument(tenantId, id, body.reason, user.sub);
    return this.ar.getDocument(tenantId, id);
  }

  @Get(':id/pdf')
  @RequirePermissions('ar.invoice.read')
  @ApiOperation({ summary: 'Invoice as a PDF, with the fields Jordan requires' })
  async invoicePdf(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { filename, bytes } = await this.pdf.render(tenantId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(bytes);
  }
}

@ApiTags('ar')
@Controller('customer-receipts')
export class CustomerReceiptsController {
  constructor(private readonly ar: ArService) {}

  @Post()
  @RequirePermissions('ar.payment.write')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Record a customer receipt',
    description: 'Omit allocations to settle the oldest open invoices first. Any surplus stays unapplied.',
  })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createReceiptSchema)) body: z.infer<typeof createReceiptSchema>,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string }> {
    const { id, replayed } = await this.ar.createReceipt(tenantId, body, {
      actorId: user.sub,
      idempotencyKey,
    });
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return { id };
  }

  @Get()
  @RequirePermissions('ar.payment.read')
  @ApiOperation({ summary: 'List customer receipts with their unapplied balance' })
  list(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ contactId: z.string().uuid().optional() })))
    query: { contactId?: string },
  ): Promise<unknown[]> {
    return this.ar.listReceipts(tenantId, query.contactId);
  }

  @Post(':id/allocate')
  @RequirePermissions('ar.payment.write')
  @HttpCode(204)
  @ApiOperation({ summary: 'Apply an unapplied receipt to open invoices' })
  allocate(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ allocations: z.array(allocationSchema).min(1) })))
    body: { allocations: { documentId: string; amountMinor: string }[] },
  ): Promise<void> {
    return this.ar.allocatePayment(tenantId, id, body.allocations, user.sub);
  }
}

@ApiTags('reports')
@Controller('reports')
export class ArReportsController {
  constructor(private readonly ar: ArService) {}

  @Get('ar-aging')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'AR aging: current, 1-30, 31-60, 61-90, 91-120, 120+' })
  aging(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ asOf: isoDate.default(() => new Date().toISOString().slice(0, 10)) })))
    query: { asOf: string },
  ): Promise<unknown> {
    return this.ar.agingReport(tenantId, query.asOf);
  }
}
