import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CloseService, type ChecklistItem, type PeriodStatus } from './close.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const checklistItemSchema = z.object({
  status: z.enum(['pending', 'done', 'skipped']),
  notes: z.string().max(1000).optional(),
});

const periodStatusSchema = z.object({
  status: z.enum(['open', 'soft_closed', 'closed']),
});

const accrualSchema = z.object({
  kind: z.enum(['accrual', 'prepayment']),
  memo: z.string().min(1).max(500),
  amountMinor: z.string().regex(/^\d+$/),
  plAccountId: z.string().uuid(),
  balanceAccountId: z.string().uuid(),
  accrualDate: isoDate,
  reversalDate: isoDate,
});

const revaluationSchema = z.object({ asOfDate: isoDate });

@ApiTags('close')
@Controller('fiscal-periods')
export class PeriodCloseController {
  constructor(private readonly close: CloseService) {}

  @Get(':id/close-status')
  @RequirePermissions('ledger.entry.read')
  @ApiOperation({
    summary: 'Close status and checklist for one period',
    description: 'The checklist is seeded on first read so its items are stable per period.',
  })
  @ApiOkResponse({ description: 'Period status, outstanding drafts and checklist items' })
  status(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PeriodStatus> {
    return this.close.periodStatus(tenantId, id);
  }

  @Put(':id/checklist/:itemCode')
  @RequirePermissions('ledger.period.close')
  @ApiOperation({
    summary: 'Mark a checklist item done or skipped',
    description: 'Skipping requires a reason, which is kept with the period.',
  })
  setItem(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemCode') itemCode: string,
    @Body(zodPipe(checklistItemSchema)) body: { status: ChecklistItem['status']; notes?: string },
  ): Promise<PeriodStatus> {
    return this.close.setChecklistItem(tenantId, id, itemCode, body, user.sub);
  }

  @Post(':id/status')
  @RequirePermissions('ledger.period.close')
  @ApiOperation({
    summary: 'Soft close, hard close or reopen a period',
    description:
      'A soft close admits adjustments only; a hard close admits nothing and requires ' +
      'every blocking checklist item to be resolved and every earlier period closed.',
  })
  setStatus(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(periodStatusSchema)) body: { status: PeriodStatus['status'] },
  ): Promise<PeriodStatus> {
    return this.close.setPeriodStatus(tenantId, id, body.status, user.sub);
  }
}

@ApiTags('close')
@Controller('close')
export class CloseController {
  constructor(private readonly close: CloseService) {}

  @Get('accruals')
  @RequirePermissions('ledger.entry.read')
  @ApiOperation({ summary: 'Accruals and prepayments with their reversals' })
  listAccruals(@TenantId() tenantId: string) {
    return this.close.listAccruals(tenantId);
  }

  @Post('accruals')
  @RequirePermissions('ledger.close.run')
  @ApiOperation({
    summary: 'Post an accrual or prepayment together with its reversal',
    description:
      'Both legs post immediately. An accrual whose reversal waits on a job that never ' +
      'runs overstates the next period until someone notices.',
  })
  createAccrual(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(accrualSchema)) body: z.infer<typeof accrualSchema>,
  ) {
    return this.close.createAccrual(tenantId, body, user.sub);
  }

  @Post('fx-revaluation')
  @RequirePermissions('ledger.close.run')
  @ApiOperation({
    summary: 'Revalue foreign-currency monetary balances at the closing rate',
    description:
      'Monetary balances only. A currency with no closing rate is refused rather than ' +
      'assumed unchanged. Running the same date twice is refused.',
  })
  revalue(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(revaluationSchema)) body: { asOfDate: string },
  ) {
    return this.close.revalueForeignCurrency(tenantId, body, user.sub);
  }

  @Post('fiscal-years/:id/closing-entry')
  @RequirePermissions('ledger.close.run')
  @ApiOperation({
    summary: 'Post the year-end closing entry',
    description: 'Zeroes every profit and loss account into retained earnings. Once per year.',
  })
  closeYear(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.close.closeYear(tenantId, id, user.sub);
  }

  @Post('fiscal-years/:id/status')
  @RequirePermissions('ledger.period.close')
  @ApiOperation({
    summary: 'Soft close, hard close or reopen a fiscal year',
    description: 'A year hard closes only once all its periods are closed and the closing entry is posted.',
  })
  setYearStatus(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(periodStatusSchema)) body: { status: 'open' | 'soft_closed' | 'closed' },
  ) {
    return this.close.setYearStatus(tenantId, id, body.status, user.sub);
  }
}
