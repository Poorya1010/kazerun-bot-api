import { Module } from '@nestjs/common';
import { AdsController } from './ads.controller';
import { AdsService } from './ads.service';
import { AdPaymentService } from './payment.service';

@Module({
  controllers: [AdsController],
  providers: [AdsService, AdPaymentService],
  exports: [AdsService],
})
export class AdsModule {}
