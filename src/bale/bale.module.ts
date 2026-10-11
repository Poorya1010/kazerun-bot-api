import { Module, Injectable, Inject, OnModuleInit } from '@nestjs/common';

import { ReportsModule } from '../reports/reports.module';
import { KazerunYarModule } from '../kazerun-yar/kazerun-yar.module';
import { NewsModule } from '../news/news.module';
import { AdsModule } from '../ads/ads.module';
import { AiModule } from '../ai/ai.module';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from '../reports/reports.service';
import { KazerunYarService } from '../kazerun-yar/kazerun-yar.service';
import { NewsService } from '../news/news.service';
import { AdsService } from '../ads/ads.service';
import { AssistantService } from '../ai/assistant.service';
import { RubikaController } from '../messaging/rubika.controller';
import { BaleService } from './bale.service';

const dependencies = [
  ConfigService,
  ReportsService,
  KazerunYarService,
  NewsService,
  AdsService,
  AssistantService,
];
const platformProvider = (
  provide: string,
  platform: 'telegram' | 'rubika',
) => ({
  provide,
  inject: dependencies,
  useFactory: (
    config: ConfigService,
    reports: ReportsService,
    city: KazerunYarService,
    news: NewsService,
    ads: AdsService,
    assistant: AssistantService,
  ) => new BaleService(config, reports, city, news, ads, assistant, platform),
});

@Injectable()
class BotPeers implements OnModuleInit {
  constructor(
    private readonly bale: BaleService,
    @Inject('TELEGRAM_BOT') private readonly telegram: BaleService,
    @Inject('RUBIKA_BOT') private readonly rubika: BaleService,
  ) {}
  onModuleInit(): void {
    const peers = [this.bale, this.telegram, this.rubika];
    for (const peer of peers) peer.setPeers(peers);
  }
}

@Module({
  imports: [ReportsModule, KazerunYarModule, NewsModule, AdsModule, AiModule],
  controllers: [RubikaController],
  providers: [
    BaleService,
    platformProvider('TELEGRAM_BOT', 'telegram'),
    platformProvider('RUBIKA_BOT', 'rubika'),
    BotPeers,
  ],
  exports: [BaleService],
})
export class BaleModule {}
