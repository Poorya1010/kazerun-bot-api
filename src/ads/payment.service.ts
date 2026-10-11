import {
  BadGatewayException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AdGatewayPaymentRequest {
  authority: string;
  paymentUrl: string;
  amountRial: number;
  provider: string;
}

export interface AdGatewayVerifyResult {
  success: boolean;
  alreadyVerified: boolean;
  code: number;
  refId: string | null;
  cardPan: string | null;
  cardHash: string | null;
  fee: number | null;
  message: string | null;
}

@Injectable()
export class AdPaymentService {
  constructor(private readonly configService: ConfigService) {}

  private text(value: unknown): string {
    return String(value ?? '').trim();
  }

  private provider(): string {
    return (this.text(this.configService.get<string>('AD_PAYMENT_PROVIDER')) || 'ZARINPAL').toUpperCase();
  }

  private merchantId(): string {
    const value = this.text(this.configService.get<string>('ZARINPAL_MERCHANT_ID'));
    if (!value) {
      throw new BadGatewayException('ZARINPAL_MERCHANT_ID تنظیم نشده است.');
    }
    return value;
  }

  private publicBaseUrl(): string {
    const value = this.text(this.configService.get<string>('AD_PUBLIC_BASE_URL')).replace(/\/+$/, '');
    if (!value || !/^https?:\/\//i.test(value)) {
      throw new BadGatewayException('AD_PUBLIC_BASE_URL تنظیم نشده یا معتبر نیست.');
    }
    return value;
  }

  private apiBase(): string {
    const sandbox = this.text(this.configService.get<string>('ZARINPAL_SANDBOX')).toLowerCase() === 'true';
    return sandbox
      ? 'https://sandbox.zarinpal.com'
      : 'https://payment.zarinpal.com';
  }

  async requestPayment(input: {
    orderCode: string;
    amountToman: number;
    description: string;
  }): Promise<AdGatewayPaymentRequest> {
    if (this.provider() !== 'ZARINPAL') {
      throw new BadGatewayException('درگاه پرداخت انتخاب‌شده در این نسخه پشتیبانی نمی‌شود.');
    }

    const amountRial = Math.floor(Number(input.amountToman) * 10);
    if (!Number.isFinite(amountRial) || amountRial < 1000) {
      throw new BadGatewayException('مبلغ تراکنش معتبر نیست.');
    }

    const callbackUrl =
      this.publicBaseUrl() +
      '/ads/payment/callback/' +
      encodeURIComponent(String(input.orderCode));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(this.apiBase() + '/pg/v4/payment/request.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          merchant_id: this.merchantId(),
          amount: amountRial,
          callback_url: callbackUrl,
          description: String(input.description).slice(0, 255),
          metadata: {
            order_id: String(input.orderCode),
          },
        }),
        signal: controller.signal,
      });

      const result: any = await response.json().catch(() => ({}));
      const code = Number(result?.data?.code ?? 0);
      const authority = this.text(result?.data?.authority);

      if (!response.ok || code !== 100 || !authority) {
        throw new BadGatewayException(
          'خطا در ایجاد پرداخت زرین‌پال: ' +
            this.text(result?.errors?.message ?? result?.data?.message ?? response.status),
        );
      }

      return {
        authority,
        paymentUrl: this.apiBase() + '/pg/StartPay/' + authority,
        amountRial,
        provider: 'ZARINPAL',
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new BadGatewayException('درگاه پرداخت در زمان مناسب پاسخ نداد.');
      }
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException(
        'ایجاد پرداخت با خطا روبه‌رو شد: ' + (error?.message ?? 'Unknown error'),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async verifyPayment(input: {
    authority: string;
    amountRial: number;
  }): Promise<AdGatewayVerifyResult> {
    if (this.provider() !== 'ZARINPAL') {
      throw new BadGatewayException('درگاه پرداخت انتخاب‌شده در این نسخه پشتیبانی نمی‌شود.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(this.apiBase() + '/pg/v4/payment/verify.json', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          merchant_id: this.merchantId(),
          amount: Number(input.amountRial),
          authority: String(input.authority),
        }),
        signal: controller.signal,
      });

      const result: any = await response.json().catch(() => ({}));
      const code = Number(result?.data?.code ?? 0);
      const success = code === 100 || code === 101;

      return {
        success,
        alreadyVerified: code === 101,
        code,
        refId: this.text(result?.data?.ref_id) || null,
        cardPan: this.text(result?.data?.card_pan).slice(0, 50) || null,
        cardHash: this.text(result?.data?.card_hash).slice(0, 150) || null,
        fee: Number.isFinite(Number(result?.data?.fee)) ? Number(result.data.fee) : null,
        message:
          this.text(result?.data?.message ?? result?.errors?.message) || null,
      };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new BadGatewayException('اعتبارسنجی پرداخت در زمان مناسب پاسخ نداد.');
      }
      if (error instanceof BadGatewayException) throw error;
      throw new BadGatewayException(
        'اعتبارسنجی پرداخت با خطا روبه‌رو شد: ' + (error?.message ?? 'Unknown error'),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
