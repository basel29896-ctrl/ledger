import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import {
  AccountsController,
  FiscalPeriodsController,
  JournalEntriesController,
  ReportsController,
} from './ledger.controller';

@Module({
  controllers: [AccountsController, JournalEntriesController, ReportsController, FiscalPeriodsController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
