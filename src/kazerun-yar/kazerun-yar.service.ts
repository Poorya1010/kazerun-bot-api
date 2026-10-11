import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export type KazerunYarCategory =
  | 'HEALTH'
  | 'EMERGENCY'
  | 'UTILITIES'
  | 'GOVERNMENT'
  | 'TRANSPORT'
  | 'EDUCATION'
  | 'TOURISM'
  | 'MUNICIPAL'
  | 'OTHER';

@Injectable()
export class KazerunYarService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeText(value: unknown): string {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/ي/g, 'ی')
      .replace(/ك/g, 'ک')
      .replace(/ة/g, 'ه')
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeCategory(value: unknown): KazerunYarCategory {
    const raw = this.normalizeText(value);

    const map: Record<string, KazerunYarCategory> = {
      health: 'HEALTH',
      سلامت: 'HEALTH',
      درمان: 'HEALTH',
      بهداشت: 'HEALTH',
      پزشکی: 'HEALTH',

      emergency: 'EMERGENCY',
      ضروری: 'EMERGENCY',
      اضطراری: 'EMERGENCY',
      امدادی: 'EMERGENCY',
      اورژانس: 'EMERGENCY',

      utilities: 'UTILITIES',
      خدمات: 'UTILITIES',
      آب: 'UTILITIES',
      برق: 'UTILITIES',
      گاز: 'UTILITIES',
      مخابرات: 'UTILITIES',

      government: 'GOVERNMENT',
      ادارات: 'GOVERNMENT',
      اداره: 'GOVERNMENT',
      دولتی: 'GOVERNMENT',

      transport: 'TRANSPORT',
      حملونقل: 'TRANSPORT',
      'حمل ونقل': 'TRANSPORT',
      حمل: 'TRANSPORT',
      تاکسی: 'TRANSPORT',
      ترمینال: 'TRANSPORT',

      education: 'EDUCATION',
      آموزش: 'EDUCATION',
      دانشگاه: 'EDUCATION',
      مدرسه: 'EDUCATION',

      tourism: 'TOURISM',
      گردشگری: 'TOURISM',
      دیدنی: 'TOURISM',
      تفریح: 'TOURISM',

      municipal: 'MUNICIPAL',
      شهری: 'MUNICIPAL',
      شهرداری: 'MUNICIPAL',
      شهرسازی: 'MUNICIPAL',

      other: 'OTHER',
      سایر: 'OTHER',
      متفرقه: 'OTHER',
    };

    const direct = map[raw];
    if (direct) {
      return direct;
    }

    const upper = String(value ?? '').trim().toUpperCase();
    const allowed: KazerunYarCategory[] = [
      'HEALTH',
      'EMERGENCY',
      'UTILITIES',
      'GOVERNMENT',
      'TRANSPORT',
      'EDUCATION',
      'TOURISM',
      'MUNICIPAL',
      'OTHER',
    ];

    if (allowed.includes(upper as KazerunYarCategory)) {
      return upper as KazerunYarCategory;
    }

    return 'OTHER';
  }

  private buildSlug(title: string): string {
    const base = this.normalizeText(title)
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);

    return `${base || 'service'}-${Date.now().toString(36)}`;
  }

  async createService(data: {
    title: string;
    category: string;
    aliases?: string[];
    shortDescription?: string | null;
    address?: string | null;
    phone?: string | null;
    hours?: string | null;
    website?: string | null;
    mapUrl?: string | null;
    sourceLabel?: string | null;
    sourceUrl?: string | null;
    createdBy?: string | null;
  }) {
    const title = String(data.title ?? '').trim();
    if (title.length < 2) {
      throw new BadRequestException('عنوان خدمت خیلی کوتاه است.');
    }

    const category = this.normalizeCategory(data.category);
    const aliases = Array.from(
      new Set(
        (Array.isArray(data.aliases) ? data.aliases : [])
          .map((item) => String(item).trim())
          .filter(Boolean),
      ),
    ).slice(0, 20);

    return this.prisma.cityService.create({
      data: {
        slug: this.buildSlug(title),
        title,
        category,
        aliases,
        shortDescription:
          String(data.shortDescription ?? '').trim() || null,
        address: String(data.address ?? '').trim() || null,
        phone: String(data.phone ?? '').trim() || null,
        hours: String(data.hours ?? '').trim() || null,
        website: String(data.website ?? '').trim() || null,
        mapUrl: String(data.mapUrl ?? '').trim() || null,
        sourceLabel: String(data.sourceLabel ?? '').trim() || null,
        sourceUrl: String(data.sourceUrl ?? '').trim() || null,
        createdBy: String(data.createdBy ?? '').trim() || null,
        isVerified: false,
        isActive: true,
      },
    });
  }


  async updateService(
    id: string,
    data: {
      title?: string;
      category?: string;
      aliases?: string[];
      shortDescription?: string | null;
      address?: string | null;
      phone?: string | null;
      hours?: string | null;
      website?: string | null;
      mapUrl?: string | null;
      sourceLabel?: string | null;
      sourceUrl?: string | null;
    },
  ) {
    const payload: Record<string, any> = {};

    if (data.title !== undefined) {
      const title = String(data.title).trim();
      if (title.length < 2) {
        throw new BadRequestException('عنوان خدمت خیلی کوتاه است.');
      }
      payload.title = title;
    }

    if (data.category !== undefined) {
      payload.category = this.normalizeCategory(data.category);
    }

    if (data.aliases !== undefined) {
      payload.aliases = Array.from(
        new Set(
          data.aliases
            .map((item) => String(item).trim())
            .filter(Boolean),
        ),
      ).slice(0, 20);
    }

    const nullableFields: Array<
      keyof Pick<
        typeof data,
        | 'shortDescription'
        | 'address'
        | 'phone'
        | 'hours'
        | 'website'
        | 'mapUrl'
        | 'sourceLabel'
        | 'sourceUrl'
      >
    > = [
      'shortDescription',
      'address',
      'phone',
      'hours',
      'website',
      'mapUrl',
      'sourceLabel',
      'sourceUrl',
    ];

    for (const field of nullableFields) {
      if (data[field] !== undefined) {
        payload[field] = String(data[field] ?? '').trim() || null;
      }
    }

    if (!Object.keys(payload).length) {
      throw new BadRequestException('هیچ تغییری برای ذخیره دریافت نشد.');
    }

    payload.isVerified = false;
    payload.verifiedAt = null;
    payload.verifiedBy = null;

    return this.prisma.cityService.update({
      where: { id: String(id).trim() },
      data: payload,
    });
  }

  async listByCategory(category: string, limit = 12) {
    const normalized = this.normalizeCategory(category);

    return this.prisma.cityService.findMany({
      where: {
        category: normalized,
        isActive: true,
      },
      orderBy: [
        { isVerified: 'desc' },
        { sortOrder: 'desc' },
        { title: 'asc' },
      ],
      take: Math.min(Math.max(Number(limit) || 12, 1), 20),
    });
  }

  async getService(id: string) {
    const service = await this.prisma.cityService.findUnique({
      where: { id: String(id).trim() },
    });

    if (!service || !service.isActive) {
      throw new NotFoundException('این مورد در کازرون‌یار پیدا نشد.');
    }

    return service;
  }

  async getServiceForAdmin(id: string) {
    const service = await this.prisma.cityService.findUnique({
      where: { id: String(id).trim() },
    });

    if (!service) {
      throw new NotFoundException('این مورد در بانک کازرون‌یار پیدا نشد.');
    }

    return service;
  }

  async searchServices(query: string, limit = 8) {
    const normalizedQuery = this.normalizeText(query);
    if (normalizedQuery.length < 2) {
      return [];
    }

    const tokens = Array.from(
      new Set(normalizedQuery.split(' ').filter((item) => item.length > 1)),
    ).slice(0, 8);

    const rows = await this.prisma.cityService.findMany({
      where: { isActive: true },
      orderBy: [
        { isVerified: 'desc' },
        { sortOrder: 'desc' },
      ],
      take: 400,
    });

    const scored = rows
      .map((row: any) => {
        const aliases = Array.isArray(row.aliases)
          ? row.aliases.map((item: unknown) => String(item))
          : [];

        const title = this.normalizeText(row.title);
        const aliasText = this.normalizeText(aliases.join(' '));
        const description = this.normalizeText(row.shortDescription);
        const address = this.normalizeText(row.address);
        const category = this.normalizeText(row.category);
        const haystack = [
          title,
          aliasText,
          description,
          address,
          category,
        ].join(' ');

        let score = 0;

        if (title === normalizedQuery) score += 120;
        if (title.includes(normalizedQuery)) score += 70;
        if (aliasText.includes(normalizedQuery)) score += 55;
        if (description.includes(normalizedQuery)) score += 25;
        if (address.includes(normalizedQuery)) score += 20;

        for (const token of tokens) {
          if (title.includes(token)) score += 18;
          else if (aliasText.includes(token)) score += 14;
          else if (description.includes(token)) score += 8;
          else if (address.includes(token)) score += 6;
          else if (haystack.includes(token)) score += 3;
        }

        if (row.isVerified) score += 7;
        score += Math.min(Number(row.sortOrder ?? 0), 10);

        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(Number(limit) || 8, 1), 12))
      .map((item) => item.row);

    return scored;
  }

  async listRecentServices(limit = 15) {
    return this.prisma.cityService.findMany({
      orderBy: [{ updatedAt: 'desc' }],
      take: Math.min(Math.max(Number(limit) || 15, 1), 30),
    });
  }

  async setVerified(id: string, verified: boolean, actor?: string) {
    return this.prisma.cityService.update({
      where: { id: String(id).trim() },
      data: {
        isVerified: Boolean(verified),
        verifiedAt: verified ? new Date() : null,
        verifiedBy: verified ? String(actor ?? '').trim() || null : null,
      },
    });
  }

  async setActive(id: string, active: boolean) {
    return this.prisma.cityService.update({
      where: { id: String(id).trim() },
      data: { isActive: Boolean(active) },
    });
  }

  async createFeedback(data: {
    cityServiceId?: string | null;
    platform: string;
    platformUserId: string;
    feedbackType: 'CORRECTION' | 'MISSING' | 'OTHER';
    text: string;
  }) {
    const text = String(data.text ?? '').trim();
    if (text.length < 5) {
      throw new BadRequestException('توضیح خیلی کوتاه است.');
    }

    const cityServiceId = String(data.cityServiceId ?? '').trim() || null;

    if (cityServiceId) {
      const exists = await this.prisma.cityService.findUnique({
        where: { id: cityServiceId },
        select: { id: true },
      });

      if (!exists) {
        throw new NotFoundException('خدمت موردنظر پیدا نشد.');
      }
    }

    return this.prisma.cityServiceFeedback.create({
      data: {
        cityServiceId,
        platform: String(data.platform ?? '').trim().toLowerCase(),
        platformUserId: String(data.platformUserId ?? '').trim(),
        feedbackType: data.feedbackType,
        text: text.slice(0, 3000),
        status: 'NEW',
      },
      include: {
        cityService: true,
      },
    });
  }

  async listPendingFeedback(limit = 10) {
    return this.prisma.cityServiceFeedback.findMany({
      where: { status: 'NEW' },
      include: { cityService: true },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(Number(limit) || 10, 1), 20),
    });
  }

  async moderateFeedback(id: string, accepted: boolean, actor?: string) {
    return this.prisma.cityServiceFeedback.update({
      where: { id: String(id).trim() },
      data: {
        status: accepted ? 'ACCEPTED' : 'DISMISSED',
        reviewedAt: new Date(),
        reviewedBy: String(actor ?? '').trim() || null,
      },
      include: { cityService: true },
    });
  }
}
