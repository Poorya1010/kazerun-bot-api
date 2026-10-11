import { Injectable, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NewsService } from '../news/news.service';

@Injectable()
export class AssistantService {
  constructor(
    private readonly configService: ConfigService,
    private readonly newsService: NewsService,
  ) {}

  async chat(message: string): Promise<string> {
    const text = message.trim();

    if (!text) {
      return 'لطفاً پیام خود را ارسال کنید.';
    }

    const baseUrl =
      this.configService.get<string>('ARVAN_AI_BASE_URL');

    const apiKey =
      this.configService.get<string>('ARVAN_AI_API_KEY');

    const model =
      this.configService.get<string>('ARVAN_AI_MODEL') ||
      'GPT-5.6-Luna';

    if (!baseUrl || !apiKey) {
      throw new BadGatewayException(
        'AI configuration is incomplete',
      );
    }

    let news =
      await this.newsService.searchPublished(text, 5);

    if (news.length === 0) {
      news =
        await this.newsService.listPublished(undefined, 5);
    }

    const newsContext =
      news
        ?.map(
          (n: any) =>
            '- ' + (n.title ?? n.subject ?? ''),
        )
        .join('\n') || 'خبری موجود نیست';

    const response = await fetch(
      `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'تو دستیار هوشمند کازرون خبر هستی. پاسخ‌ها کوتاه، دوستانه و فارسی باشند. درباره کازرون، اخبار و خدمات شهری کمک کن.',
            },
            {
              role: 'system',
              content:
                'آخرین خبرهای موجود:\\n' + newsContext,
            },
            {
              role: 'user',
              content: text,
            },
          ],
        }),
      },
    );

    const data: any = await response.json();

    const answer =
      data?.choices?.[0]?.message?.content;

    if (!answer) {
      return 'متأسفانه در حال حاضر نتوانستم پاسخ مناسبی پیدا کنم.';
    }

    return answer.trim();
  }
}
