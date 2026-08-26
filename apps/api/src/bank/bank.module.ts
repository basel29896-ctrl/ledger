import { Module } from '@nestjs/common';
import { BankService } from './bank.service';
import {
  BankAccountsController,
  BankRulesController,
  BankStatementLinesController,
  BankStatementsController,
  BankTransfersController,
  ReconciliationsController,
} from './bank.controller';

@Module({
  controllers: [
    BankAccountsController,
    BankStatementsController,
    BankStatementLinesController,
    BankTransfersController,
    ReconciliationsController,
    BankRulesController,
  ],
  providers: [BankService],
  exports: [BankService],
})
export class BankModule {}
