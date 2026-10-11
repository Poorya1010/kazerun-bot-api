import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export type CityNewsCategory =
  | 'CITY'
  | 'SERVICES'
  | 'HEALTH'
  | 'TRAFFIC'
  | 'CULTURE'
  | 'SPORTS'
  | 'OTHER';

export type CityNewsAlertLevel = 'NORMAL' | 'IMPORTANT' | 'URGENT';

@Injectable()
export class NewsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeText(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/ة/g, 'ه')
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeCategory(value: unknown): CityNewsCategory {
    const raw = this.normalizeText(value);
    const map: Record<string, CityNewsCategory> = {
      city: 'CITY',
      شهری: 'CITY',
      شهر: 'CITY',
      عمومی: 'CITY',
      services: 'SERVICES',
      service: 'SERVICES',
      خدمات: 'SERVICES',
      خدماتی: 'SERVICES',
      قطعی: 'SERVICES',
      آب: 'SERVICES',
      برق: 'SERVICES',
      گاز: 'SERVICES',
      health: 'HEALTH',
      سلامت: 'HEALTH',
      درمان: 'HEALTH',
      بهداشت: 'HEALTH',
      traffic: 'TRAFFIC',
      ترافیک: 'TRAFFIC',
      راه: 'TRAFFIC',
      جاده: 'TRAFFIC',
      culture: 'CULTURE',
      فرهنگی: 'CULTURE',
      فرهنگ: 'CULTURE',
      رویداد: 'CULTURE',
      sports: 'SPORTS',
      sport: 'SPORTS',
      ورزش: 'SPORTS',
      ورزشی: 'SPORTS',
      other: 'OTHER',
      سایر: 'OTHER',
      متفرقه: 'OTHER',
    };

    const direct = map[raw];
    if (direct) return direct;

    const upper = String(value ?? '').trim().toUpperCase();
    const allowed: CityNewsCategory[] = [
      'CITY',
      'SERVICES',
      'HEALTH',
      'TRAFFIC',
      'CULTURE',
      'SPORTS',
      'OTHER',
    ];
    return allowed.includes(upper as CityNewsCategory)
      ? (upper as CityNewsCategory)
      : 'OTHER';
  }

  normalizeAlertLevel(value: unknown): CityNewsAlertLevel {
    const raw = this.normalizeText(value);
    if (['فوری', 'urgent', 'اضطراری'].includes(raw)) return 'URGENT';
    if (['مهم', 'important', 'ویژه'].includes(raw)) return 'IMPORTANT';
    return 'NORMAL';
  }

  async createNews(data: {
    title: string;
    category?: string;
    body: string;
    alertLevel?: string;
    sourceLabel?: string | null;
    sourceUrl?: string | null;
    createdBy?: string | null;
  }) {
    const title = String(data.title ?? '').trim();
    const body = String(data.body ?? '').trim();

    if (title.length < 3) {
      throw new BadRequestException('عنوان خبر خیلی کوتاه است.');
    }
    if (body.length < 10) {
      throw new BadRequestException('متن خبر خیلی کوتاه است.');
    }

    return this.prisma.cityNews.create({
      data: {
        title: title.slice(0, 240),
        category: this.normalizeCategory(data.category ?? 'CITY'),
        body: body.slice(0, 6000),
        alertLevel: this.normalizeAlertLevel(data.alertLevel ?? 'NORMAL'),
        sourceLabel: String(data.sourceLabel ?? '').trim().slice(0, 300) || null,
        sourceUrl: String(data.sourceUrl ?? '').trim().slice(0, 1000) || null,
        createdBy: String(data.createdBy ?? '').trim().slice(0, 300) || null,
      },
    });
  }

  async updateNews(
    id: string,
    data: {
      title?: string;
      category?: string;
      body?: string;
      alertLevel?: string;
      sourceLabel?: string | null;
      sourceUrl?: string | null;
      updatedBy?: string | null;
    },
  ) {
    const payload: Record<string, any> = {};

    if (data.title !== undefined) {
      const title = String(data.title).trim();
      if (title.length < 3) throw new BadRequestException('عنوان خبر خیلی کوتاه است.');
      payload.title = title.slice(0, 240);
    }
    if (data.body !== undefined) {
      const body = String(data.body).trim();
      if (body.length < 10) throw new BadRequestException('متن خبر خیلی کوتاه است.');
      payload.body = body.slice(0, 6000);
    }
    if (data.category !== undefined) payload.category = this.normalizeCategory(data.category);
    if (data.alertLevel !== undefined) payload.alertLevel = this.normalizeAlertLevel(data.alertLevel);
    if (data.sourceLabel !== undefined) payload.sourceLabel = String(data.sourceLabel ?? '').trim().slice(0, 300) || null;
    if (data.sourceUrl !== undefined) payload.sourceUrl = String(data.sourceUrl ?? '').trim().slice(0, 1000) || null;
    if (data.updatedBy !== undefined) payload.updatedBy = String(data.updatedBy ?? '').trim().slice(0, 300) || null;

    if (!Object.keys(payload).length) {
      throw new BadRequestException('هیچ تغییری برای خبر دریافت نشد.');
    }

    return this.prisma.cityNews.update({ where: { id }, data: payload });
  }

  async getById(id: string) {
    const item = await this.prisma.cityNews.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('خبر پیدا نشد.');
    return item;
  }

  async getPublicById(id: string) {
    const item = await this.prisma.cityNews.findFirst({
      where: { id, isPublished: true, isArchived: false },
    });
    if (!item) throw new NotFoundException('این خبر در دسترس نیست.');
    return item;
  }

  async listPublished(category?: string, limit = 10) {
    return this.prisma.cityNews.findMany({
      where: {
        isPublished: true,
        isArchived: false,
        ...(category ? { category: this.normalizeCategory(category) } : {}),
      },
      orderBy: [
        { publishedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: Math.max(1, Math.min(20, limit)),
    });
  }

  async listUrgent(limit = 10) {
    return this.prisma.cityNews.findMany({
      where: {
        isPublished: true,
        isArchived: false,
        alertLevel: 'URGENT',
      },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(20, limit)),
    });
  }

  async listDrafts(limit = 15) {
    return this.prisma.cityNews.findMany({
      where: { isPublished: false, isArchived: false },
      orderBy: { updatedAt: 'desc' },
      take: Math.max(1, Math.min(30, limit)),
    });
  }

  async listPublishedForAdmin(limit = 15) {
    return this.prisma.cityNews.findMany({
      where: { isPublished: true, isArchived: false },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(30, limit)),
    });
  }

  async publish(id: string, actor?: string | null) {
    return this.prisma.cityNews.update({
      where: { id },
      data: {
        isPublished: true,
        isArchived: false,
        publishedAt: new Date(),
        updatedBy: String(actor ?? '').trim().slice(0, 300) || null,
      },
    });
  }

  async archive(id: string, actor?: string | null) {
    return this.prisma.cityNews.update({
      where: { id },
      data: {
        isArchived: true,
        updatedBy: String(actor ?? '').trim().slice(0, 300) || null,
      },
    });
  }

  async toggleSubscription(
    platform: string,
    platformUserId: string,
    category: string,
  ) {
    const normalizedCategory = String(category ?? '').trim().toUpperCase();
    const allowed = [
      'ALL',
      'URGENT',
      'CITY',
      'SERVICES',
      'HEALTH',
      'TRAFFIC',
      'CULTURE',
      'SPORTS',
    ];
    if (!allowed.includes(normalizedCategory)) {
      throw new BadRequestException('دسته اعلان معتبر نیست.');
    }

    const where = {
      platform_platformUserId_category: {
        platform,
        platformUserId,
        category: normalizedCategory,
      },
    } as const;

    const existing = await this.prisma.cityNewsSubscription.findUnique({ where });
    if (!existing) {
      return this.prisma.cityNewsSubscription.create({
        data: { platform, platformUserId, category: normalizedCategory, isActive: true },
      });
    }

    return this.prisma.cityNewsSubscription.update({
      where,
      data: { isActive: !existing.isActive },
    });
  }

  async disableAllSubscriptions(platform: string, platformUserId: string) {
    await this.prisma.cityNewsSubscription.updateMany({
      where: { platform, platformUserId, isActive: true },
      data: { isActive: false },
    });
  }

  async getUserSubscriptions(platform: string, platformUserId: string) {
    const rows = await this.prisma.cityNewsSubscription.findMany({
      where: { platform, platformUserId, isActive: true },
      select: { category: true },
    });
    return new Set(rows.map((row) => String(row.category)));
  }

  async getNotificationRecipients(newsId: string) {
    const news = await this.getById(newsId);
    const categories = new Set<string>(['ALL', String(news.category)]);
    if (news.alertLevel === 'URGENT') categories.add('URGENT');

    const subscriptions = await this.prisma.cityNewsSubscription.findMany({
      where: {
        platform: 'bale',
        isActive: true,
        category: { in: Array.from(categories) },
      },
      select: { platformUserId: true },
    });

    const delivered = await this.prisma.cityNewsDelivery.findMany({
      where: { newsId, platform: 'bale', status: 'SENT' },
      select: { platformUserId: true },
    });
    const deliveredSet = new Set(delivered.map((row) => String(row.platformUserId)));

    return Array.from(
      new Set(subscriptions.map((row) => String(row.platformUserId))),
    ).filter((id) => !deliveredSet.has(id));
  }

  async recordDelivery(newsId: string, platformUserId: string, status: 'SENT' | 'FAILED') {
    await this.prisma.cityNewsDelivery.upsert({
      where: {
        newsId_platform_platformUserId: {
          newsId,
          platform: 'bale',
          platformUserId,
        },
      },
      create: {
        newsId,
        platform: 'bale',
        platformUserId,
        status,
        deliveredAt: status === 'SENT' ? new Date() : null,
      },
      update: {
        status,
        deliveredAt: status === 'SENT' ? new Date() : null,
      },
    });
  }

  async searchPublished(keyword: string, limit = 5) {
    const text = String(keyword ?? '').trim();

    if (!text) {
      return [];
    }

    return this.prisma.cityNews.findMany({
      where: {
        isPublished: true,
        isArchived: false,
        OR: [
          {
            title: {
              contains: text,
              mode: 'insensitive',
            },
          },
          {
            body: {
              contains: text,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: [
        { publishedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: limit,
    });
  }

}
