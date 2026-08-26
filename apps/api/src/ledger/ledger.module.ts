import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { GeneralLedgerService } from './gl.service';
import {
  AccountsController,
  FiscalPeriodsController,
  JournalEntriesController,
  ReportsController,
} from './ledger.controller';

@Module({
  controllers: [AccountsController, JournalEntriesController, ReportsController, FiscalPeriodsController],
  providers: [LedgerService, GeneralLedgerService],
  exports: [LedgerService, GeneralLedgerService],
})
export class LedgerModule {}
