import { ApiKeyGuard } from '../messaging/api-key.guard';
import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';

import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AiModule],

  controllers: [ReportsController],

  providers: [ApiKeyGuard, ReportsService],

  exports: [ReportsService],
})
export class ReportsModule {}
