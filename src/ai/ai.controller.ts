import { UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../messaging/api-key.guard';
import { Body, Controller, Post } from '@nestjs/common';

import { AiService } from './ai.service';

@UseGuards(ApiKeyGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  // فقط برای تست توسعه
  @Post('analyze-report')
  async analyzeReport(@Body() body: any) {
    const analysis = await this.aiService.analyzeCitizenReport({
      text: body.text ?? '',

      location: body.location,

      category: body.category,

      previousAnswers: body.previousAnswers,
    });

    return {
      success: true,
      analysis,
    };
  }
}
