import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreateUser(data: any) {
    const platform = String(data.platform ?? '').trim().toLowerCase();
    const platformUserId = String(data.platformUserId ?? '').trim();

    if (!platform || !platformUserId) {
      throw new BadRequestException(
        'platform and platformUserId are required',
      );
    }

    return this.prisma.user.upsert({
      where: {
        platform_platformUserId: {
          platform,
          platformUserId,
        },
      },

      update: {
        displayName: data.displayName ?? undefined,
        username: data.username ?? undefined,
        phone: data.phone ?? undefined,
      },

      create: {
        platform,
        platformUserId,
        displayName: data.displayName ?? null,
        username: data.username ?? null,
        phone: data.phone ?? null,
      },
    });
  }

  async getUsers() {
    return this.prisma.user.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }
}