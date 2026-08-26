import { Module } from '@nestjs/common';
import { CloseService } from './close.service';
import { CloseController, PeriodCloseController } from './close.controller';

@Module({
  controllers: [PeriodCloseController, CloseController],
  providers: [CloseService],
  exports: [CloseService],
})
export class CloseModule {}
