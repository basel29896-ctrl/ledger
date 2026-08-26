import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BudgetService, type BudgetDto } from './budget.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const signedMinor = z.string().regex(/^-?\d+$/, 'integer minor units, sign allowed');

const budgetSchema = z.object({
  name: z.string().min(1).max(200),
  fiscalYearId: z.string().uuid(),
});

const accountBudgetSchema = z
  .object({
    accountId: z.string().uuid(),
    annualAmountMinor: signedMinor.optional(),
    method: z.enum(['even', 'weighted']).optional(),
    weights: z.array(z.number().nonnegative()).optional(),
    periods: z
      .array(z.object({ periodId: z.string().uuid(), amountMinor: signedMinor }))
      .optional(),
  })
  .refine((v) => v.annualAmountMinor !== undefined || v.periods !== undefined, {
    message: 'Give either an annual amount to spread or an amount per period',
  });

const varianceQuerySchema = z.object({ fromDate: isoDate, toDate: isoDate });

@ApiTags('budget')
@Controller('budgets')
export class BudgetController {
  constructor(private readonly budgets: BudgetService) {}

  @Get()
  @RequirePermissions('budget.read')
  @ApiOperation({ summary: 'List budgets' })
  list(@TenantId() tenantId: string): Promise<BudgetDto[]> {
    return this.budgets.list(tenantId);
  }

  @Post()
  @RequirePermissions('budget.write')
  @ApiOperation({ summary: 'Create a draft budget for a fiscal year' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(budgetSchema)) body: z.infer<typeof budgetSchema>,
  ): Promise<BudgetDto> {
    return this.budgets.create(tenantId, body, user.sub);
  }

  @Put(':id/accounts')
  @RequirePermissions('budget.write')
  @ApiOperation({
    summary: 'Budget one account, per period or as an annual figure to spread',
    description: 'An even spread puts the remainder in the last period; weights use largest remainder.',
  })
  setAccount(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(accountBudgetSchema)) body: z.infer<typeof accountBudgetSchema>,
  ) {
    return this.budgets.setAccountBudget(tenantId, id, body, user.sub);
  }

  @Post(':id/approve')
  @RequirePermissions('budget.write')
  @ApiOperation({
    summary: 'Approve a budget',
    description: 'An approved budget is the baseline a variance is measured against, so it stops moving.',
  })
  approve(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BudgetDto> {
    return this.budgets.approve(tenantId, id, user.sub);
  }

  @Get(':id/variance')
  @RequirePermissions('budget.read')
  @ApiOperation({
    summary: 'Budget against actual',
    description:
      'Actuals come from posted journal lines. Favourable is decided by account type, ' +
      'not by the sign: revenue short of budget and expense over it are both unfavourable.',
  })
  variance(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodPipe(varianceQuerySchema)) query: z.infer<typeof varianceQuerySchema>,
  ) {
    return this.budgets.variance(tenantId, id, query);
  }
}
