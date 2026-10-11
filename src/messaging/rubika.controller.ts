import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaleService } from '../bale/bale.service';
import { secretMatches } from './api-key.guard';

@Controller('bots/rubika')
export class RubikaController {
  constructor(
    private readonly config: ConfigService,
    @Inject('RUBIKA_BOT') private readonly bot: BaleService,
  ) {}
  @Post(':secret/update')
  @HttpCode(200)
  async update(@Param('secret') secret: string, @Body() body: any) {
    const expected = this.config.get<string>('RUBIKA_WEBHOOK_SECRET') ?? '';
    if (
      !this.config.get<string>('RUBIKA_WEBHOOK_URL') ||
      expected.length < 32 ||
      !secretMatches(expected, secret)
    ) {
      throw new UnauthorizedException();
    }
    await this.bot.receiveRubikaWebhook(body);
    return {};
  }
  @Post(':secret/inline')
  @HttpCode(200)
  inline(@Param('secret') secret: string, @Body() body: any) {
    return this.update(secret, body);
  }
}
