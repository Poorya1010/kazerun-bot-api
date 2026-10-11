import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { AdPaymentService } from './payment.service';

export type AdChannel = 'BALE' | 'EITAA' | 'RUBIKA' | 'SOROUSH';

export interface AdPlacement {
  channel: AdChannel;
  count: number;
}

export interface AdAiReview {
  summary: string;
  missingQuestions: string[];
  riskFlags: string[];
  suitability: 'OK' | 'REVIEW' | 'REJECT';
  prohibitedReason: string | null;
  humanReviewRequired: boolean;
  variants: Array<{
    label: string;
    text: string;
  }>;
}

@Injectable()
export class AdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly adPaymentService: AdPaymentService,
  ) {}

  private normalizeText(value: unknown): string {
    return String(value ?? '')
      .trim()
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeChannel(value: unknown): AdChannel | null {
    const raw = this.normalizeText(value).toLowerCase();
    const map: Record<string, AdChannel> = {
      bale: 'BALE',
      بله: 'BALE',
      eitaa: 'EITAA',
      ایتا: 'EITAA',
      rubika: 'RUBIKA',
      روبیکا: 'RUBIKA',
      soroush: 'SOROUSH',
      سروش: 'SOROUSH',
      'سروش پلاس': 'SOROUSH',
    };
    return map[raw] ?? null;
  }

  normalizePlacements(input: unknown): AdPlacement[] {
    if (!Array.isArray(input)) return [];

    const merged = new Map<AdChannel, number>();
    for (const item of input) {
      const channel = this.normalizeChannel((item as any)?.channel);
      const count = Math.max(0, Math.min(50, Number((item as any)?.count ?? 0)));
      if (!channel || !Number.isFinite(count) || count < 1) continue;
      merged.set(channel, Math.floor((merged.get(channel) ?? 0) + count));
    }

    return Array.from(merged.entries()).map(([channel, count]) => ({
      channel,
      count: Math.min(50, count),
    }));
  }

  async createPackage(data: {
    code?: string;
    title: string;
    description?: string | null;
    priceToman: number;
    placements: AdPlacement[];
    pinHours?: number;
    createdBy?: string | null;
  }) {
    const title = this.normalizeText(data.title);
    if (title.length < 3) throw new BadRequestException('عنوان بسته خیلی کوتاه است.');

    const priceToman = Math.floor(Number(data.priceToman));
    if (!Number.isFinite(priceToman) || priceToman < 1000) {
      throw new BadRequestException('قیمت بسته معتبر نیست.');
    }

    const placements = this.normalizePlacements(data.placements);
    if (!placements.length) {
      throw new BadRequestException('حداقل یک کانال و تعداد انتشار لازم است.');
    }

    const requestedCode = this.normalizeText(data.code).toUpperCase();
    const code = requestedCode || this.generatePackageCode();

    return this.prisma.adPackage.create({
      data: {
        code: code.slice(0, 50),
        title: title.slice(0, 160),
        description: this.normalizeText(data.description).slice(0, 1500) || null,
        priceToman,
        placements: placements as any,
        pinHours: Math.max(0, Math.min(720, Math.floor(Number(data.pinHours ?? 0)))),
        createdBy: this.normalizeText(data.createdBy).slice(0, 300) || null,
      },
    });
  }

  async updatePackage(
    id: string,
    data: {
      code?: string;
      title?: string;
      description?: string | null;
      priceToman?: number;
      placements?: AdPlacement[];
      pinHours?: number;
      updatedBy?: string | null;
    },
  ) {
    const payload: Record<string, any> = {};

    if (data.code !== undefined) {
      const code = this.normalizeText(data.code).toUpperCase();
      if (code.length < 2) throw new BadRequestException('کد بسته معتبر نیست.');
      payload.code = code.slice(0, 50);
    }
    if (data.title !== undefined) {
      const title = this.normalizeText(data.title);
      if (title.length < 3) throw new BadRequestException('عنوان بسته خیلی کوتاه است.');
      payload.title = title.slice(0, 160);
    }
    if (data.description !== undefined) {
      payload.description = this.normalizeText(data.description).slice(0, 1500) || null;
    }
    if (data.priceToman !== undefined) {
      const priceToman = Math.floor(Number(data.priceToman));
      if (!Number.isFinite(priceToman) || priceToman < 1000) {
        throw new BadRequestException('قیمت بسته معتبر نیست.');
      }
      payload.priceToman = priceToman;
    }
    if (data.placements !== undefined) {
      const placements = this.normalizePlacements(data.placements);
      if (!placements.length) throw new BadRequestException('انتشارهای بسته معتبر نیست.');
      payload.placements = placements as any;
    }
    if (data.pinHours !== undefined) {
      payload.pinHours = Math.max(0, Math.min(720, Math.floor(Number(data.pinHours))));
    }
    if (data.updatedBy !== undefined) {
      payload.updatedBy = this.normalizeText(data.updatedBy).slice(0, 300) || null;
    }

    if (!Object.keys(payload).length) {
      throw new BadRequestException('هیچ تغییری برای بسته دریافت نشد.');
    }

    return this.prisma.adPackage.update({ where: { id }, data: payload });
  }

  async togglePackage(id: string, actor?: string | null) {
    const item = await this.getPackage(id);
    return this.prisma.adPackage.update({
      where: { id },
      data: {
        isActive: !item.isActive,
        updatedBy: this.normalizeText(actor).slice(0, 300) || null,
      },
    });
  }

  async getPackage(id: string) {
    const item = await this.prisma.adPackage.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('بسته تبلیغاتی پیدا نشد.');
    return item;
  }

  async listActivePackages(limit = 20) {
    return this.prisma.adPackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(1, Math.min(30, limit)),
    });
  }

  async listPackagesAdmin(limit = 30) {
    return this.prisma.adPackage.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { updatedAt: 'desc' }],
      take: Math.max(1, Math.min(50, limit)),
    });
  }

  async createOrder(data: {
    packageId: string;
    platform: string;
    platformUserId: string;
    displayName?: string | null;
    username?: string | null;
  }) {
    const pkg = await this.getPackage(data.packageId);
    if (!pkg.isActive) throw new BadRequestException('این بسته در حال حاضر قابل خرید نیست.');

    const snapshot = {
      code: pkg.code,
      title: pkg.title,
      description: pkg.description,
      priceToman: pkg.priceToman,
      placements: this.normalizePlacements(pkg.placements),
      pinHours: pkg.pinHours,
    };

    return this.prisma.adOrder.create({
      data: {
        orderCode: this.generateOrderCode(),
        platform: this.normalizeText(data.platform).toLowerCase() || 'bale',
        platformUserId: this.normalizeText(data.platformUserId),
        displayName: this.normalizeText(data.displayName).slice(0, 300) || null,
        username: this.normalizeText(data.username).slice(0, 200) || null,
        packageId: pkg.id,
        packageSnapshot: snapshot as any,
        amountToman: pkg.priceToman,
        status: 'AWAITING_PAYMENT',
      },
      include: { package: true },
    });
  }

  async getOrder(id: string) {
    const order = await this.prisma.adOrder.findUnique({
      where: { id },
      include: {
        package: true,
        payments: { orderBy: { createdAt: 'desc' }, take: 5 },
        assets: { orderBy: { createdAt: 'asc' } },
        revisions: { orderBy: { createdAt: 'desc' }, take: 10 },
        publications: { orderBy: [{ channel: 'asc' }, { sequence: 'asc' }] },
      },
    });
    if (!order) throw new NotFoundException('سفارش تبلیغ پیدا نشد.');
    return order;
  }

  async getUserOrder(id: string, platform: string, platformUserId: string) {
    const order = await this.getOrder(id);
    if (
      String(order.platform) !== String(platform) ||
      String(order.platformUserId) !== String(platformUserId)
    ) {
      throw new NotFoundException('سفارش تبلیغ پیدا نشد.');
    }
    return order;
  }

  async listUserOrders(platform: string, platformUserId: string, limit = 10) {
    return this.prisma.adOrder.findMany({
      where: { platform, platformUserId },
      include: { package: true },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(20, limit)),
    });
  }

  async listOrdersAdmin(filter: string, limit = 20) {
    const normalized = String(filter ?? '').trim().toUpperCase();
    let where: Record<string, any> = {};

    if (normalized === 'READY') {
      where = { status: { in: ['READY_REVIEW', 'NEEDS_REVISION'] } };
    } else if (normalized === 'PUBLISHING') {
      where = { status: { in: ['APPROVED', 'PUBLISHING'] } };
    } else if (normalized === 'PAID') {
      where = { status: { in: ['PAID', 'COLLECTING_CONTENT'] } };
    } else if (normalized === 'COMPLETED') {
      where = { status: 'COMPLETED' };
    }

    return this.prisma.adOrder.findMany({
      where,
      include: {
        package: true,
        payments: { where: { status: 'VERIFIED' }, orderBy: { verifiedAt: 'desc' }, take: 1 },
        publications: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(1, Math.min(50, limit)),
    });
  }

  async createPayment(orderId: string) {
    const order = await this.getOrder(orderId);

    if (
      [
        'PAID',
        'COLLECTING_CONTENT',
        'READY_REVIEW',
        'NEEDS_REVISION',
        'APPROVED',
        'PUBLISHING',
        'COMPLETED',
      ].includes(order.status)
    ) {
      return { alreadyPaid: true, order };
    }

    const gateway = await this.adPaymentService.requestPayment({
      orderCode: String(order.orderCode),
      amountToman: Number(order.amountToman),
      description:
        'خرید بسته تبلیغاتی کازرون خبر - ' + String(order.orderCode),
    });

    const payment = await this.prisma.adPayment.create({
      data: {
        orderId: order.id,
        provider: gateway.provider,
        amountRial: gateway.amountRial,
        authority: gateway.authority,
        status: 'PENDING',
      },
    });

    await this.prisma.adOrder.update({
      where: { id: order.id },
      data: { status: 'PAYMENT_PENDING' },
    });

    return {
      alreadyPaid: false,
      order,
      payment,
      authority: gateway.authority,
      paymentUrl: gateway.paymentUrl,
    };
  }

  async verifyPaymentCallback(input: {
    orderCode: string;
    authority: string;
    status: string;
  }) {
    const orderCode = this.normalizeText(input.orderCode);
    const authority = this.normalizeText(input.authority);
    const gatewayStatus = this.normalizeText(input.status).toUpperCase();

    const order = await this.prisma.adOrder.findUnique({
      where: { orderCode },
      include: { payments: { orderBy: { createdAt: 'desc' } } },
    });
    if (!order) throw new NotFoundException('سفارش پیدا نشد.');

    const payment = order.payments.find(
      (item) => String(item.authority) === authority,
    );
    if (!payment) {
      throw new NotFoundException('تراکنش مربوط به این سفارش پیدا نشد.');
    }

    if (payment.status === 'VERIFIED') {
      return { success: true, alreadyVerified: true, order, payment };
    }

    if (gatewayStatus !== 'OK') {
      await this.prisma.adPayment.update({
        where: { id: payment.id },
        data: { status: 'CANCELED' },
      });
      return { success: false, canceled: true, order, payment };
    }

    const verify = await this.adPaymentService.verifyPayment({
      authority,
      amountRial: Number(payment.amountRial),
    });

    if (!verify.success) {
      await this.prisma.adPayment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          providerMessage: String(verify.message ?? '').slice(0, 500) || null,
        },
      });
      return {
        success: false,
        verifyCode: verify.code,
        order,
        payment,
      };
    }

    const updatedPayment = await this.prisma.adPayment.update({
      where: { id: payment.id },
      data: {
        status: 'VERIFIED',
        refId: verify.refId,
        cardPan: verify.cardPan,
        cardHash: verify.cardHash,
        fee: verify.fee,
        verifiedAt: new Date(),
        providerMessage: verify.message,
      },
    });

    const updatedOrder = await this.prisma.adOrder.update({
      where: { id: order.id },
      data: {
        status: ['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(order.status)
          ? 'PAID'
          : order.status,
        paidAt: order.paidAt ?? new Date(),
      },
    });

    await this.notifyBalePaymentVerified(updatedOrder, updatedPayment);

    return {
      success: true,
      alreadyVerified: verify.alreadyVerified,
      order: updatedOrder,
      payment: updatedPayment,
    };
  }

  async isOrderPaid(orderId: string): Promise<boolean> {
    const order = await this.getOrder(orderId);
    return ['PAID', 'COLLECTING_CONTENT', 'READY_REVIEW', 'NEEDS_REVISION', 'APPROVED', 'PUBLISHING', 'COMPLETED'].includes(order.status);
  }

  async updateOrderContent(
    orderId: string,
    platform: string,
    platformUserId: string,
    data: Record<string, string | null>,
  ) {
    const order = await this.getUserOrder(orderId, platform, platformUserId);
    if (!await this.isOrderPaid(order.id)) {
      throw new BadRequestException('ابتدا پرداخت سفارش باید تأیید شود.');
    }

    const allowed = new Set([
      'businessName',
      'subject',
      'rawAdText',
      'phone',
      'address',
      'links',
      'cta',
      'preferredSchedule',
      'extraInfo',
    ]);
    const payload: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!allowed.has(key)) continue;
      const normalized = this.normalizeText(value);
      payload[key] = normalized ? normalized.slice(0, key === 'rawAdText' || key === 'extraInfo' ? 6000 : 1500) : null;
    }

    payload.status = 'COLLECTING_CONTENT';
    return this.prisma.adOrder.update({ where: { id: order.id }, data: payload });
  }

  async addAsset(
    orderId: string,
    platform: string,
    platformUserId: string,
    data: {
      sourceChatId: string;
      sourceMessageId: string;
      mediaType: string;
      fileId?: string | null;
      fileUniqueId?: string | null;
      caption?: string | null;
      mimeType?: string | null;
      fileName?: string | null;
    },
  ) {
    const order = await this.getUserOrder(orderId, platform, platformUserId);
    if (!await this.isOrderPaid(order.id)) throw new BadRequestException('پرداخت سفارش تأیید نشده است.');

    return this.prisma.adAsset.upsert({
      where: {
        orderId_platform_sourceChatId_sourceMessageId: {
          orderId: order.id,
          platform,
          sourceChatId: String(data.sourceChatId),
          sourceMessageId: String(data.sourceMessageId),
        },
      },
      create: {
        orderId: order.id,
        platform,
        platformUserId,
        sourceChatId: String(data.sourceChatId),
        sourceMessageId: String(data.sourceMessageId),
        mediaType: this.normalizeText(data.mediaType).slice(0, 50) || 'media',
        fileId: this.normalizeText(data.fileId).slice(0, 500) || null,
        fileUniqueId: this.normalizeText(data.fileUniqueId).slice(0, 500) || null,
        caption: this.normalizeText(data.caption).slice(0, 2000) || null,
        mimeType: this.normalizeText(data.mimeType).slice(0, 200) || null,
        fileName: this.normalizeText(data.fileName).slice(0, 500) || null,
      },
      update: {
        caption: this.normalizeText(data.caption).slice(0, 2000) || null,
      },
    });
  }

  async markAssetCopied(assetId: string) {
    return this.prisma.adAsset.update({
      where: { id: assetId },
      data: { editorialCopiedAt: new Date() },
    });
  }

  async analyzeOrderWithAi(orderId: string): Promise<AdAiReview | null> {
    const order = await this.getOrder(orderId);
    const baseUrl = this.normalizeText(this.configService.get<string>('ARVAN_AI_BASE_URL'));
    const apiKey = this.normalizeText(this.configService.get<string>('ARVAN_AI_API_KEY'));
    const model = this.normalizeText(this.configService.get<string>('ARVAN_AI_MODEL'));

    if (!baseUrl || !apiKey || !model) return null;

    const endpoint = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const payload = {
      businessName: order.businessName,
      subject: order.subject,
      rawAdText: order.rawAdText,
      phone: order.phone,
      address: order.address,
      links: order.links,
      cta: order.cta,
      preferredSchedule: order.preferredSchedule,
      extraInfo: order.extraInfo,
      mediaCount: order.assets.length,
      package: order.packageSnapshot,
    };

    const systemPrompt = `
تو دستیار حرفه‌ای واحد تبلیغات رسانه محلی «کازرون خبر» هستی.
هدف: بررسی سفارش تبلیغاتی قبل از تحریریه، تشخیص نقص‌های مهم و ساخت متن پیشنهادی فارسی.

قواعد:
1) هیچ آدرس، قیمت، شماره، ادعا، مجوز، تخفیف یا ویژگی محصول را از خودت نساز.
2) فقط از داده سفارش استفاده کن.
3) حداکثر 2 سوال تکمیلی؛ فقط اگر نبودن پاسخ واقعاً مانع آماده‌سازی تبلیغ است.
4) ادعاهای پزشکی/درمانی، مالی، تضمین سود، قرعه‌کشی، محتوای مشکوک، غیرقانونی یا گمراه‌کننده را در riskFlags علامت بزن و humanReviewRequired=true کن.
5) تصمیم نهایی انتشار با تحریریه است؛ تو هرگز انتشار خودکار را پیشنهاد نکن.
6) سه نسخه متن بساز: «رسمی»، «فروش‌محور»، «کوتاه». متن‌ها نباید اطلاعات جدید اختراع کنند.
7) suitability یکی از OK، REVIEW، REJECT باشد. REJECT فقط برای محتوایی که از داده موجود آشکارا نامناسب/غیرقانونی/غیرقابل انتشار است.
8) فقط JSON معتبر و بدون Markdown برگردان.

ساختار:
{
  "summary":"",
  "missingQuestions":[],
  "riskFlags":[],
  "suitability":"OK",
  "prohibitedReason":null,
  "humanReviewRequired":true,
  "variants":[
    {"label":"رسمی","text":""},
    {"label":"فروش‌محور","text":""},
    {"label":"کوتاه","text":""}
  ]
}
`.trim();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: 'apikey ' + apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          temperature: 0.25,
          max_tokens: 2200,
        }),
        signal: controller.signal,
      });

      if (!response.ok) return null;
      const result: any = await response.json();
      const content = String(result?.choices?.[0]?.message?.content ?? '').trim();
      if (!content) return null;

      const parsed = this.parseAiJson(content);
      const review = this.normalizeAiReview(parsed);

      await this.prisma.adOrder.update({
        where: { id: order.id },
        data: {
          aiReview: review as any,
          aiAnalyzedAt: new Date(),
          aiModel: model.slice(0, 150),
        },
      });

      return review;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async markReadyForReview(orderId: string) {
    const order = await this.getOrder(orderId);
    if (!order.businessName || !order.subject || !order.rawAdText) {
      throw new BadRequestException('اطلاعات اصلی تبلیغ هنوز کامل نشده است.');
    }
    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: { status: 'READY_REVIEW', submittedAt: new Date() },
    });
  }

  async addCustomerFollowup(orderId: string, platform: string, platformUserId: string, text: string) {
    const order = await this.getUserOrder(orderId, platform, platformUserId);
    const body = this.normalizeText(text);
    if (body.length < 2) throw new BadRequestException('متن اصلاحات خیلی کوتاه است.');

    await this.prisma.adRevision.create({
      data: {
        orderId: order.id,
        actorType: 'CUSTOMER',
        actorId: platformUserId,
        text: body.slice(0, 6000),
      },
    });

    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: {
        extraInfo: [order.extraInfo, body].filter(Boolean).join('\n\n').slice(0, 6000),
        status: 'READY_REVIEW',
        submittedAt: new Date(),
      },
    });
  }

  async requestRevision(orderId: string, reason: string, actor: string) {
    const order = await this.getOrder(orderId);
    const body = this.normalizeText(reason);
    if (body.length < 2) throw new BadRequestException('دلیل اصلاح خیلی کوتاه است.');

    await this.prisma.adRevision.create({
      data: {
        orderId: order.id,
        actorType: 'EDITOR',
        actorId: actor.slice(0, 300),
        text: body.slice(0, 6000),
      },
    });

    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVISION', reviewNote: body.slice(0, 3000) },
    });
  }

  async rejectOrder(orderId: string, reason: string, actor: string) {
    const order = await this.getOrder(orderId);
    const body = this.normalizeText(reason);
    if (body.length < 2) throw new BadRequestException('دلیل رد خیلی کوتاه است.');

    await this.prisma.adRevision.create({
      data: {
        orderId: order.id,
        actorType: 'EDITOR',
        actorId: actor.slice(0, 300),
        text: body.slice(0, 6000),
      },
    });

    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: { status: 'REJECTED', reviewNote: body.slice(0, 3000) },
    });
  }

  async assignOrder(orderId: string, actorId: string, actorName: string) {
    return this.prisma.adOrder.update({
      where: { id: orderId },
      data: {
        assignedToPlatformUserId: actorId.slice(0, 120),
        assignedToDisplayName: actorName.slice(0, 300),
        assignedAt: new Date(),
      },
    });
  }

  async approveOrder(orderId: string, actor: string) {
    const order = await this.getOrder(orderId);
    if (!order.finalAdText) {
      const ai = this.readAiReview(order.aiReview);
      const fallback = ai?.variants?.[0]?.text || order.rawAdText || '';
      await this.prisma.adOrder.update({
        where: { id: order.id },
        data: { finalAdText: fallback.slice(0, 6000) || null },
      });
    }

    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: {
        status: 'PUBLISHING',
        approvedAt: new Date(),
        approvedBy: actor.slice(0, 300),
      },
    });
  }

  async selectAiVariant(orderId: string, index: number, actor: string) {
    const order = await this.getOrder(orderId);
    const review = this.readAiReview(order.aiReview);
    const variant = review?.variants?.[index];
    if (!variant?.text) throw new BadRequestException('این نسخه متن هوشمند در دسترس نیست.');

    return this.prisma.adOrder.update({
      where: { id: order.id },
      data: {
        finalAdText: String(variant.text).slice(0, 6000),
        finalTextSelectedBy: actor.slice(0, 300),
      },
    });
  }

  async setFinalText(orderId: string, text: string, actor: string) {
    const body = String(text ?? '').trim();
    if (body.length < 10) throw new BadRequestException('متن نهایی خیلی کوتاه است.');
    return this.prisma.adOrder.update({
      where: { id: orderId },
      data: {
        finalAdText: body.slice(0, 6000),
        finalTextSelectedBy: actor.slice(0, 300),
      },
    });
  }

  async recordPublication(orderId: string, channelInput: string, actor: string, url?: string | null) {
    const order = await this.getOrder(orderId);
    if (!['APPROVED', 'PUBLISHING'].includes(order.status)) {
      throw new BadRequestException('این سفارش در مرحله انتشار نیست.');
    }

    const channel = this.normalizeChannel(channelInput);
    if (!channel) throw new BadRequestException('کانال انتشار معتبر نیست.');

    const expected = this.getExpectedPlacements(order).find((item) => item.channel === channel)?.count ?? 0;
    if (expected < 1) throw new BadRequestException('این کانال در بسته سفارش وجود ندارد.');

    const currentCount = order.publications.filter((item) => item.channel === channel).length;
    if (currentCount >= expected) throw new BadRequestException('تعداد انتشار این کانال قبلاً کامل شده است.');

    await this.prisma.adPublication.create({
      data: {
        orderId: order.id,
        channel,
        sequence: currentCount + 1,
        postUrl: this.normalizeText(url).slice(0, 1500) || null,
        publishedBy: actor.slice(0, 300),
        publishedAt: new Date(),
      },
    });

    const refreshed = await this.getOrder(order.id);
    const progress = this.getPublicationProgress(refreshed);

    if (progress.complete) {
      const completed = await this.prisma.adOrder.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return { order: completed, progress, completed: true };
    }

    if (order.status !== 'PUBLISHING') {
      await this.prisma.adOrder.update({ where: { id: order.id }, data: { status: 'PUBLISHING' } });
    }

    return { order: refreshed, progress, completed: false };
  }

  getExpectedPlacements(order: any): AdPlacement[] {
    const snapshot = order?.packageSnapshot as any;
    return this.normalizePlacements(snapshot?.placements ?? order?.package?.placements ?? []);
  }

  getPublicationProgress(order: any) {
    const expected = this.getExpectedPlacements(order);
    const publications = Array.isArray(order?.publications) ? order.publications : [];

    const rows = expected.map((item) => ({
      channel: item.channel,
      expected: item.count,
      done: publications.filter((pub: any) => String(pub.channel) === item.channel).length,
    }));

    return {
      rows,
      expectedTotal: rows.reduce((sum, item) => sum + item.expected, 0),
      doneTotal: rows.reduce((sum, item) => sum + item.done, 0),
      complete: rows.length > 0 && rows.every((item) => item.done >= item.expected),
    };
  }

  async getStats() {
    const [orders, verifiedPayments, activePackages] = await Promise.all([
      this.prisma.adOrder.count(),
      this.prisma.adPayment.findMany({
        where: { status: 'VERIFIED' },
        select: { amountRial: true },
      }),
      this.prisma.adPackage.count({ where: { isActive: true } }),
    ]);

    const revenueRial = verifiedPayments.reduce((sum, item) => sum + Number(item.amountRial || 0), 0);
    const grouped = await this.prisma.adOrder.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return {
      orders,
      activePackages,
      verifiedPayments: verifiedPayments.length,
      revenueToman: Math.floor(revenueRial / 10),
      byStatus: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
    };
  }

  readAiReview(value: unknown): AdAiReview | null {
    if (!value || typeof value !== 'object') return null;
    return this.normalizeAiReview(value as any);
  }

  private parseAiJson(content: string): any {
    let cleaned = content.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
  }

  private normalizeAiReview(data: any): AdAiReview {
    const questions = Array.isArray(data?.missingQuestions)
      ? data.missingQuestions.map((x: any) => this.normalizeText(x)).filter(Boolean).slice(0, 2)
      : [];
    const flags = Array.isArray(data?.riskFlags)
      ? data.riskFlags.map((x: any) => this.normalizeText(x)).filter(Boolean).slice(0, 10)
      : [];
    const variantsRaw = Array.isArray(data?.variants) ? data.variants : [];
    const labels = ['رسمی', 'فروش‌محور', 'کوتاه'];
    const variants = variantsRaw
      .map((item: any, index: number) => ({
        label: this.normalizeText(item?.label) || labels[index] || 'نسخه ' + String(index + 1),
        text: String(item?.text ?? '').trim().slice(0, 6000),
      }))
      .filter((item: any) => item.text)
      .slice(0, 3);

    const rawSuitability = this.normalizeText(data?.suitability).toUpperCase();
    const suitability: 'OK' | 'REVIEW' | 'REJECT' =
      rawSuitability === 'REJECT' ? 'REJECT' : rawSuitability === 'OK' ? 'OK' : 'REVIEW';

    return {
      summary: String(data?.summary ?? '').trim().slice(0, 2000),
      missingQuestions: questions,
      riskFlags: flags,
      suitability,
      prohibitedReason: this.normalizeText(data?.prohibitedReason).slice(0, 2000) || null,
      humanReviewRequired: data?.humanReviewRequired !== false,
      variants,
    };
  }

  private generateOrderCode(): string {
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const random = Math.floor(1000 + Math.random() * 9000);
    return 'AD-' + stamp + '-' + random;
  }

  private generatePackageCode(): string {
    return 'PKG-' + Date.now().toString(36).toUpperCase().slice(-6);
  }

  private async notifyBalePaymentVerified(order: any, payment: any): Promise<void> {
    if (String(order.platform) !== 'bale') return;
    const token = this.normalizeText(this.configService.get<string>('BALE_BOT_TOKEN'));
    if (!token) return;

    const chatId = Number(order.platformUserId);
    if (!Number.isFinite(chatId)) return;

    try {
      await fetch('https://tapi.bale.ai/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          chat_id: chatId,
          text: [
            '✅ پرداخت تبلیغ با موفقیت تأیید شد',
            '',
            '🧾 کد سفارش: ' + String(order.orderCode),
            '💳 شماره پیگیری: ' + String(payment.refId ?? 'ثبت شد'),
            '',
            'حالا اطلاعات و فایل‌های تبلیغ را تکمیل کنید تا پرونده برای تحریریه ارسال شود.',
          ].join('\n'),
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 تکمیل سفارش تبلیغ', callback_data: 'usr:adcontinue:' + String(order.id) }],
              [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
            ],
          },
        }),
      });
    } catch {
      // Payment verification must not fail just because Bale notification failed.
    }
  }
}
