import { ApiKeyGuard } from '../messaging/api-key.guard';
import { Module } from '@nestjs/common';

import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AssistantService } from './assistant.service';
import { NewsModule } from '../news/news.module';

@Module({
  imports: [NewsModule],

  controllers: [AiController],

  providers: [ApiKeyGuard, AiService, AssistantService],

  exports: [AiService, AssistantService],
})
export class AiModule {}
