import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ClearanceQueue } from './clearance.queue';
import { LedgerError } from '../common/problem.filter';
import { TaxService } from './tax.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

@ApiTags('tax')
@Controller('tax-codes')
export class TaxCodesController {
  constructor(private readonly tax: TaxService) {}

  @Get()
  @RequirePermissions('tax.read')
  @ApiOperation({ summary: 'Tax codes, including the Jordan set' })
  list(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.tax.listTaxCodes(tenantId);
  }

  @Post()
  @RequirePermissions('tax.write')
  @ApiOperation({ summary: 'Create a tax code, optionally compounding on another' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(
      zodPipe(
        z.object({
          code: z.string().min(1).max(32),
          name: z.string().min(1).max(200),
          nameAr: z.string().max(200).optional(),
          kind: z.enum(['sales', 'purchase', 'both']).default('both'),
          ratePercent: z.string().regex(/^\d+(\.\d{1,4})?$/),
          treatment: z.enum(['standard', 'zero_rated', 'exempt']).default('standard'),
          isWithholding: z.boolean().default(false),
          isRecoverable: z.boolean().default(true),
          compoundOn: z.array(z.string()).default([]),
          outputAccountId: z.string().uuid().optional(),
          inputAccountId: z.string().uuid().optional(),
          sortOrder: z.number().int().default(100),
        }),
      ),
    )
    body: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.tax.createTaxCode(tenantId, body, user.sub);
  }
}

@ApiTags('tax')
@Controller('e-invoices')
export class EInvoiceController {
  constructor(
    private readonly tax: TaxService,
    private readonly clearance: ClearanceQueue,
  ) {}

  @Get('queue')
  @RequirePermissions('tax.read')
  @ApiOperation({ summary: 'Invoices awaiting clearance or failed, oldest first' })
  queue(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.tax.clearanceQueue(tenantId);
  }

  @Get(':documentId/ubl')
  @RequirePermissions('tax.read')
  @ApiOperation({ summary: 'The UBL 2.1 XML that would be submitted' })
  ubl(
    @TenantId() tenantId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<{ xml: string }> {
    return this.tax.buildEInvoice(tenantId, documentId);
  }

  @Post(':documentId/submit')
  @RequirePermissions('tax.einvoice.submit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Submit an invoice for clearance',
    description:
      'A transient failure leaves the invoice in `failed` with the attempt counted, so it can ' +
      'be retried. Until clearance succeeds the invoice is not a valid tax document.',
  })
  async submit(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<unknown> {
    try {
      return await this.tax.submitForClearance(tenantId, documentId, user.sub);
    } catch (error) {
      /*
       * A transport failure is worth retrying on its own; hand it to the queue
       * and still tell the caller it did not clear, because until it does the
       * invoice is not a valid tax document.
       */
      if (error instanceof LedgerError && error.code === 'CLEARANCE_RETRYABLE') {
        const { queued } = await this.clearance.enqueue({
          tenantId,
          documentId,
          actorId: user.sub,
        });
        throw new LedgerError(
          error.code,
          queued ? `${error.message} — queued for retry` : error.message,
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }
}

@ApiTags('reports')
@Controller('reports')
export class TaxReportsController {
  constructor(private readonly tax: TaxService) {}

  @Get('tax-return')
  @RequirePermissions('tax.read')
  @ApiOperation({
    summary: 'Tax return for a period',
    description:
      'Taxable, zero-rated and exempt sales; output tax; recoverable and irrecoverable input ' +
      'tax; and the net payable or refundable position.',
  })
  taxReturn(
    @TenantId() tenantId: string,
    @Query(zodPipe(z.object({ fromDate: isoDate, toDate: isoDate })))
    query: { fromDate: string; toDate: string },
  ): Promise<unknown> {
    return this.tax.taxReturn(tenantId, query);
  }
}
