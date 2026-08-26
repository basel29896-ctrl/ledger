import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  balanceSheetQuerySchema,
  statementPeriodQuerySchema,
  type BalanceSheetQuery,
  type StatementPeriodQuery,
} from '@acct/shared';
import type { BalanceSheet, CashFlowStatement, EquityStatement, IncomeStatement } from '@acct/domain';
import { StatementsService, sectionsToCsv } from './statements.service';
import { zodPipe } from '../common/zod.pipe';
import { RequirePermissions, TenantId } from '../auth/auth.guard';

@ApiTags('reports')
@Controller('reports')
export class StatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Get('income-statement')
  @RequirePermissions('report.read')
  @ApiOperation({
    summary: 'Income statement (profit and loss)',
    description:
      'Built from posted journal lines for the window. Pass compareFromDate and ' +
      'compareToDate for a comparative column and its variance.',
  })
  @ApiOkResponse({ description: 'Revenue, cost of sales, expenses and the resulting profit' })
  async incomeStatement(
    @TenantId() tenantId: string,
    @Query(zodPipe(statementPeriodQuerySchema)) query: StatementPeriodQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IncomeStatement | string> {
    const statement = await this.statements.incomeStatement(tenantId, query);
    if (query.format === 'csv') {
      return csv(res, `income-statement-${query.fromDate}-${query.toDate}`, [
        statement.revenue,
        statement.costOfSales,
        statement.operatingExpenses,
        statement.otherIncome,
        statement.otherExpenses,
      ]);
    }
    return statement;
  }

  @Get('balance-sheet')
  @RequirePermissions('report.read')
  @ApiOperation({
    summary: 'Balance sheet as at a date',
    description:
      'Assets, liabilities and equity, including the unclosed profit for the year. ' +
      'Returns 422 rather than rendering a statement that does not balance.',
  })
  async balanceSheet(
    @TenantId() tenantId: string,
    @Query(zodPipe(balanceSheetQuerySchema)) query: BalanceSheetQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BalanceSheet | string> {
    const statement = await this.statements.balanceSheet(tenantId, query);
    if (query.format === 'csv') {
      return csv(res, `balance-sheet-${query.asOfDate}`, [
        statement.currentAssets,
        statement.nonCurrentAssets,
        statement.currentLiabilities,
        statement.nonCurrentLiabilities,
        statement.equity,
      ]);
    }
    return statement;
  }

  @Get('cash-flow')
  @RequirePermissions('report.read')
  @ApiOperation({
    summary: 'Cash flow statement, indirect method',
    description:
      'Operating, investing and financing activities. The three sections must sum to ' +
      'the movement in cash and bank accounts; a mismatch is reported, not hidden.',
  })
  async cashFlow(
    @TenantId() tenantId: string,
    @Query(zodPipe(statementPeriodQuerySchema)) query: StatementPeriodQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CashFlowStatement | string> {
    const statement = await this.statements.cashFlow(tenantId, query);
    if (query.format === 'csv') {
      return csv(res, `cash-flow-${query.fromDate}-${query.toDate}`, [
        statement.operating.nonCashAdjustments,
        statement.operating.workingCapital,
        statement.investing,
        statement.financing,
      ]);
    }
    return statement;
  }

  @Get('equity')
  @RequirePermissions('report.read')
  @ApiOperation({ summary: 'Statement of changes in equity' })
  async equity(
    @TenantId() tenantId: string,
    @Query(zodPipe(statementPeriodQuerySchema)) query: StatementPeriodQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EquityStatement | string> {
    const statement = await this.statements.equity(tenantId, query);
    if (query.format === 'csv') {
      return csv(res, `equity-${query.fromDate}-${query.toDate}`, [statement.movements]);
    }
    return statement;
  }
}

function csv(res: Response, filename: string, sections: Parameters<typeof sectionsToCsv>[1]): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return sectionsToCsv(filename, sections);
}
