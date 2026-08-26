import { Module } from '@nestjs/common';
import { ApService } from './ap.service';
import {
  ApReportsController,
  BillsController,
  GoodsReceiptsController,
  PurchaseOrdersController,
  VendorPaymentsController,
  VendorsController,
} from './ap.controller';
import { ArModule } from '../ar/ar.module';

@Module({
  imports: [ArModule],
  controllers: [
    VendorsController,
    PurchaseOrdersController,
    GoodsReceiptsController,
    BillsController,
    VendorPaymentsController,
    ApReportsController,
  ],
  providers: [ApService],
  exports: [ApService],
})
export class ApModule {}
