import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  createAccountSchema,
  createJournalEntrySchema,
  cursorPageSchema,
  reverseEntrySchema,
  trialBalanceQuerySchema,
  type AccountDto,
  type CreateAccountInput,
  type CreateJournalEntryInput,
  type JournalEntryDto,
  type ReverseEntryInput,
  type TrialBalanceDto,
  type TrialBalanceQuery,
} from '@acct/shared';
import { LedgerService } from './ledger.service';
import { zodPipe } from '../common/zod.pipe';
import { LedgerError } from '../common/problem.filter';
import { IdempotencyKey } from '../common/tenant';
import { CurrentUser, RequirePermissions, TenantId } from '../auth/auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

@ApiTags('ledger')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @RequirePermissions('ledger.account.read')
  @ApiOperation({ summary: 'List the chart of accounts' })
  list(@TenantId() tenantId: string): Promise<AccountDto[]> {
    return this.ledger.listAccounts(tenantId);
  }

  @Post()
  @RequirePermissions('ledger.account.write')
  @ApiOperation({ summary: 'Create an account' })
  create(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body(zodPipe(createAccountSchema)) body: CreateAccountInput,
  ): Promise<AccountDto> {
    return this.ledger.createAccount(tenantId, body, user.sub);
  }
}

@ApiTags('ledger')
@Controller('journal-entries')
export class JournalEntriesController {
  constructor(private readonly ledger: LedgerService) {}

  @Post()
  @RequirePermissions('ledger.entry.draft')
  @ApiOperation({
    summary: 'Create a journal entry as draft or posted',
    description:
      'Send an Idempotency-Key header to make retries safe: a repeat of the same key returns ' +
      'the original entry with 200 instead of creating a second one.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  async create(
    @TenantId() tenantId: string,
    @Body(zodPipe(createJournalEntrySchema)) body: CreateJournalEntryInput,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JournalEntryDto> {
    // Posting outright is a stronger act than saving a draft, so it needs the
    // stronger permission even though both arrive at the same endpoint.
    if (body.status === 'posted' && !user.perms.includes('ledger.entry.post')) {
      throw new LedgerError('FORBIDDEN', 'Missing permission: ledger.entry.post', HttpStatus.FORBIDDEN);
    }
    const { entry, replayed } = await this.ledger.createEntry(
      tenantId,
      body,
      idempotencyKey,
      user.sub,
    );
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return entry;
  }

  @Get()
  @RequirePermissions('ledger.entry.read')
  @ApiOperation({ summary: 'List journal entries, newest first' })
  list(
    @TenantId() tenantId: string,
    @Query(zodPipe(cursorPageSchema)) query: { limit: number; cursor?: string },
  ): Promise<{ items: JournalEntryDto[]; nextCursor: string | null }> {
    return this.ledger.listEntries(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('ledger.entry.read')
  @ApiOperation({ summary: 'Fetch one journal entry with its lines' })
  get(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.ledger.getEntry(tenantId, id);
  }

  @Post(':id/post')
  @RequirePermissions('ledger.entry.post')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post a draft entry' })
  post(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.ledger.postEntry(tenantId, id, user.sub);
  }

  @Post(':id/reverse')
  @RequirePermissions('ledger.entry.reverse')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Reverse a posted entry',
    description: 'Posts the mirror image and links both entries. The original is never edited.',
  })
  reverse(
    @TenantId() tenantId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reverseEntrySchema)) body: ReverseEntryInput,
  ): Promise<{ original: JournalEntryDto; reversal: JournalEntryDto }> {
    return this.ledger.reverseEntry(tenantId, id, body, user.sub);
  }
}

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('trial-balance')
  @RequirePermissions('report.read')
  @ApiOperation({
    summary: 'Trial balance',
    description: 'Computed from journal lines, not from the balance cache. Must always be balanced.',
  })
  @ApiOkResponse({ description: 'Debit and credit totals per account, in the tenant base currency' })
  trialBalance(
    @TenantId() tenantId: string,
    @Query(zodPipe(trialBalanceQuerySchema)) query: TrialBalanceQuery,
  ): Promise<TrialBalanceDto> {
    return this.ledger.trialBalance(tenantId, query);
  }
}

@ApiTags('ledger')
@Controller('fiscal-periods')
export class FiscalPeriodsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @RequirePermissions('ledger.entry.read')
  @ApiOperation({ summary: 'List fiscal periods and their open/closed status' })
  list(
    @TenantId() tenantId: string,
  ): Promise<{ id: string; periodNo: number; startDate: string; endDate: string; status: string }[]> {
    return this.ledger.listPeriods(tenantId);
  }
}
