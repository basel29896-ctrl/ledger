import { Module } from '@nestjs/common';
import { ArService } from './ar.service';
import { InvoicePdfService } from './invoice-pdf.service';
import {
  ArReportsController,
  CustomerReceiptsController,
  CustomersController,
  SalesDocumentsController,
} from './ar.controller';

@Module({
  controllers: [
    CustomersController,
    SalesDocumentsController,
    CustomerReceiptsController,
    ArReportsController,
  ],
  providers: [ArService, InvoicePdfService],
  exports: [ArService],
})
export class ArModule {}
