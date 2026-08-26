import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BankService } from './bank.service';
import { zodPipe } from '../common/zod.pipe';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const minorUnits = z.string().regex(/^\d+$/);
const signedMinorUnits = z.string().regex(/^-?\d+$/);

const csvMappingSchema = z.object({
  dateColumn: z.string(),
  descriptionColumn: z.string(),
  amountColumn: z.string().optional(),
  debitColumn: z.string().optional(),
  creditColumn: z.string().optional(),
  referenceColumn: z.string().optional(),
  counterpartyColumn: z.string().optional(),
  externalIdColumn: z.string().optional(),
  delimiter: z.string().length(1).optional(),
});

const importSchema = z.object({
  bankAccountId: z.string().uuid(),
  format: z.enum(['csv', 'ofx', 'mt940', 'camt053']),
  content: z.string().min(1),
  filename: z.string().max(255).optional(),
  csvMapping: csvMappingSchema.optional(),
});

@ApiTags('bank')
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly bank: BankService) {}

  @Get()
  @RequirePermissions('bank.read')
  @ApiOperation({ summary: 'Bank accounts with their ledger balance and unmatched line count' })
  list(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.bank.listBankAccounts(tenantId);
  }

  @Post()
  @RequirePermissions('bank.write')
  @ApiOperation({ summary: 'Register a bank account against a GL account' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(
      zodPipe(
        z.object({
          accountId: z.string().uuid(),
          name: z.string().min(1).max(200),
          bankName: z.string().max(200).optional(),
          accountNumber: z.string().max(64).optional(),
          iban: z.string().max(64).optional(),
          currencyCode: z.string().length(3),
          openingBalanceMinor: signedMinorUnits.optional(),
          openingBalanceDate: isoDate.optional(),
        }),
      ),
    )
    body: Parameters<BankService['createBankAccount']>[1],
  ): Promise<{ id: string }> {
    return this.bank.createBankAccount(tenantId, body, user.sub);
  }

  @Get(':id/statement-lines')
  @RequirePermissions('bank.read')
  @ApiOperation({ summary: 'Statement lines for an account' })
  lines(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(
      zodPipe(
        z.object({
          status: z.enum(['unmatched', 'suggested', 'matched', 'ignored']).optional(),
        }),
      ),
    )
    query: { status?: string },
  ): Promise<unknown[]> {
    return this.bank.listStatementLines(tenantId, id, query.status);
  }
}

@ApiTags('bank')
@Controller('bank-statements')
export class BankStatementsController {
  constructor(private readonly bank: BankService) {}

  @Post('import')
  @RequirePermissions('bank.import')
  @ApiOperation({
    summary: 'Import a statement (CSV, OFX, MT940 or CAMT.053)',
    description:
      'Auto-matching runs immediately. Re-importing the same file is refused: the content ' +
      'hash is unique per bank account.',
  })
  import(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(importSchema)) body: z.infer<typeof importSchema>,
  ): Promise<{ statementId: string; imported: number; suggested: number }> {
    return this.bank.importStatement(tenantId, body, user.sub);
  }
}

@ApiTags('bank')
@Controller('bank-statement-lines')
export class BankStatementLinesController {
  constructor(private readonly bank: BankService) {}

  @Post(':id/match')
  @RequirePermissions('bank.reconcile')
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm a suggested match, or match to a named journal entry' })
  match(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(z.object({ entryId: z.string().uuid().optional() })))
    body: { entryId?: string },
  ): Promise<void> {
    return this.bank.confirmMatch(tenantId, id, body.entryId, user.sub);
  }

  @Post(':id/unmatch')
  @RequirePermissions('bank.reconcile')
  @HttpCode(204)
  @ApiOperation({ summary: 'Undo a match that has not been locked by a reconciliation' })
  unmatch(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.bank.unmatch(tenantId, id, user.sub);
  }

  @Post(':id/categorise')
  @RequirePermissions('bank.reconcile')
  @ApiOperation({
    summary: 'Post the entry the ledger was missing and match the line to it',
  })
  categorise(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(
      zodPipe(
        z.object({
          accountId: z.string().uuid(),
          contactId: z.string().uuid().optional(),
          description: z.string().max(500).optional(),
        }),
      ),
    )
    body: { accountId: string; contactId?: string; description?: string },
  ): Promise<{ entryId: string }> {
    return this.bank.categorise(tenantId, id, body, user.sub);
  }
}

@ApiTags('bank')
@Controller('bank-transfers')
export class BankTransfersController {
  constructor(private readonly bank: BankService) {}

  @Post()
  @RequirePermissions('bank.reconcile')
  @ApiOperation({
    summary: 'Transfer between own accounts',
    description:
      'Cross-currency transfers must state the amount received; the difference posts to ' +
      'realised FX gain or loss rather than distorting a bank balance.',
  })
  transfer(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(
      zodPipe(
        z.object({
          fromBankAccountId: z.string().uuid(),
          toBankAccountId: z.string().uuid(),
          transferDate: isoDate,
          amountMinor: minorUnits,
          receivedAmountMinor: minorUnits.optional(),
          fxRate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
          memo: z.string().max(500).optional(),
        }),
      ),
    )
    body: Parameters<BankService['transfer']>[1],
  ): Promise<{ entryIds: string[] }> {
    return this.bank.transfer(tenantId, body, user.sub);
  }
}

@ApiTags('bank')
@Controller('reconciliations')
export class ReconciliationsController {
  constructor(private readonly bank: BankService) {}

  @Post()
  @RequirePermissions('bank.reconcile')
  @ApiOperation({ summary: 'Start a reconciliation session' })
  start(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(
      zodPipe(
        z.object({
          bankAccountId: z.string().uuid(),
          statementDate: isoDate,
          statementClosingMinor: signedMinorUnits,
        }),
      ),
    )
    body: { bankAccountId: string; statementDate: string; statementClosingMinor: string },
  ): Promise<unknown> {
    return this.bank.startReconciliation(tenantId, body, user.sub);
  }

  @Get(':id')
  @RequirePermissions('bank.read')
  @ApiOperation({ summary: 'Reconciliation status with the difference' })
  status(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.bank.reconciliationStatus(tenantId, id);
  }

  @Post(':id/complete')
  @RequirePermissions('bank.reconcile')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a reconciliation',
    description: 'Refused unless the difference is exactly zero. Cleared lines are then locked.',
  })
  complete(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.bank.completeReconciliation(tenantId, id, user.sub);
  }
}

@ApiTags('bank')
@Controller('bank-rules')
export class BankRulesController {
  constructor(private readonly bank: BankService) {}

  @Get()
  @RequirePermissions('bank.read')
  @ApiOperation({ summary: 'List bank rules in priority order' })
  list(@TenantId() tenantId: string): Promise<unknown[]> {
    return this.bank.listRules(tenantId);
  }

  @Post()
  @RequirePermissions('bank.write')
  @ApiOperation({ summary: 'Create a bank rule' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(
      zodPipe(
        z.object({
          name: z.string().min(1).max(200),
          bankAccountId: z.string().uuid().optional(),
          priority: z.number().int().min(1).max(1000).default(100),
          descriptionContains: z.string().max(200).optional(),
          referenceContains: z.string().max(200).optional(),
          minAmountMinor: minorUnits.optional(),
          maxAmountMinor: minorUnits.optional(),
          direction: z.enum(['in', 'out']).optional(),
          accountId: z.string().uuid(),
          contactId: z.string().uuid().optional(),
          taxCodeId: z.string().uuid().optional(),
          setDescription: z.string().max(500).optional(),
        }),
      ),
    )
    body: Record<string, unknown>,
  ): Promise<{ id: string }> {
    return this.bank.createRule(tenantId, body, user.sub);
  }
}
