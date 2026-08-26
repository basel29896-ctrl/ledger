import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';
import { EInvoiceController, TaxCodesController, TaxReportsController } from './tax.controller';

@Module({
  controllers: [TaxCodesController, EInvoiceController, TaxReportsController],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
