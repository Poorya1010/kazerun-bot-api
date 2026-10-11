import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { PrismaModule } from './prisma.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { AiModule } from './ai/ai.module';
import { BaleModule } from './bale/bale.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    PrismaModule,
    UsersModule,
    AiModule,
    ReportsModule,
    BaleModule,
  ],

  controllers: [
    AppController,
  ],

  providers: [
    AppService,
  ],
})
export class AppModule {}