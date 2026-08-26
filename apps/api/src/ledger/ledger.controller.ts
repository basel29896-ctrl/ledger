import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { IdempotencyKey, TenantId } from '../common/tenant';

@ApiTags('ledger')
@ApiHeader({ name: 'X-Tenant-Id', required: true, description: 'Tenant scope (replaced by the JWT claim in M2)' })
@Controller('accounts')
export class AccountsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'List the chart of accounts' })
  list(@TenantId() tenantId: string): Promise<AccountDto[]> {
    return this.ledger.listAccounts(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an account' })
  create(
    @TenantId() tenantId: string,
    @Body(zodPipe(createAccountSchema)) body: CreateAccountInput,
  ): Promise<AccountDto> {
    return this.ledger.createAccount(tenantId, body);
  }
}

@ApiTags('ledger')
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller('journal-entries')
export class JournalEntriesController {
  constructor(private readonly ledger: LedgerService) {}

  @Post()
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<JournalEntryDto> {
    const { entry, replayed } = await this.ledger.createEntry(tenantId, body, idempotencyKey);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('Idempotent-Replay', 'true');
    return entry;
  }

  @Get()
  @ApiOperation({ summary: 'List journal entries, newest first' })
  list(
    @TenantId() tenantId: string,
    @Query(zodPipe(cursorPageSchema)) query: { limit: number; cursor?: string },
  ): Promise<{ items: JournalEntryDto[]; nextCursor: string | null }> {
    return this.ledger.listEntries(tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one journal entry with its lines' })
  get(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.ledger.getEntry(tenantId, id);
  }

  @Post(':id/post')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post a draft entry' })
  post(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JournalEntryDto> {
    return this.ledger.postEntry(tenantId, id);
  }

  @Post(':id/reverse')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Reverse a posted entry',
    description: 'Posts the mirror image and links both entries. The original is never edited.',
  })
  reverse(
    @TenantId() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodPipe(reverseEntrySchema)) body: ReverseEntryInput,
  ): Promise<{ original: JournalEntryDto; reversal: JournalEntryDto }> {
    return this.ledger.reverseEntry(tenantId, id, body);
  }
}

@ApiTags('reports')
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller('reports')
export class ReportsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('trial-balance')
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
@ApiHeader({ name: 'X-Tenant-Id', required: true })
@Controller('fiscal-periods')
export class FiscalPeriodsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'List fiscal periods and their open/closed status' })
  list(
    @TenantId() tenantId: string,
  ): Promise<{ id: string; periodNo: number; startDate: string; endDate: string; status: string }[]> {
    return this.ledger.listPeriods(tenantId);
  }
}
