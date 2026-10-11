import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { AdsService } from './ads.service';

@Controller('ads')
export class AdsController {
  constructor(private readonly adsService: AdsService) {}

  @Get('payment/callback/:order')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async paymentCallback(
    @Param('order') order: string,
    @Query('Authority') authority: string,
    @Query('Status') status: string,
  ): Promise<string> {
    try {
      const result = await this.adsService.verifyPaymentCallback({
        orderCode: String(order ?? ''),
        authority: String(authority ?? ''),
        status: String(status ?? ''),
      });

      if (result.success) {
        return this.page(
          'پرداخت موفق',
          'پرداخت شما با موفقیت تأیید شد. به ربات کازرون خبر برگردید و تکمیل سفارش تبلیغ را ادامه دهید.',
          true,
        );
      }

      if ((result as any).canceled) {
        return this.page(
          'پرداخت لغو شد',
          'پرداخت انجام نشد یا توسط شما لغو شد. می‌توانید از داخل ربات دوباره پرداخت را انجام دهید.',
          false,
        );
      }

      return this.page(
        'پرداخت تأیید نشد',
        'اعتبارسنجی پرداخت موفق نبود. لطفاً از داخل ربات وضعیت سفارش را بررسی کنید.',
        false,
      );
    } catch {
      return this.page(
        'خطا در بررسی پرداخت',
        'در بررسی پرداخت خطایی رخ داد. سفارش شما حذف نشده است؛ از داخل ربات وضعیت سفارش را دوباره بررسی کنید.',
        false,
      );
    }
  }

  private page(title: string, message: string, success: boolean): string {
    const accent = success ? '#16803a' : '#9b2c2c';
    return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
body{font-family:Tahoma,Arial,sans-serif;background:#f5f7fb;margin:0;padding:24px;color:#172033}
.card{max-width:560px;margin:10vh auto;background:#fff;border-radius:18px;padding:28px;box-shadow:0 10px 35px rgba(0,0,0,.08);text-align:center}
.icon{font-size:48px}.title{font-size:23px;font-weight:700;color:${accent};margin:12px 0}.msg{font-size:16px;line-height:2}.brand{margin-top:24px;color:#667085;font-size:13px}
</style>
</head>
<body><div class="card"><div class="icon">${success ? '✅' : '⚠️'}</div><div class="title">${title}</div><div class="msg">${message}</div><div class="brand">کازرون خبر؛ روایت اول کازرون</div></div></body>
</html>`;
  }
}
