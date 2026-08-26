import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';
import { ClearanceQueue } from './clearance.queue';
import { EInvoiceController, TaxCodesController, TaxReportsController } from './tax.controller';

@Module({
  controllers: [TaxCodesController, EInvoiceController, TaxReportsController],
  providers: [TaxService, ClearanceQueue],
  exports: [TaxService, ClearanceQueue],
})
export class TaxModule {}
