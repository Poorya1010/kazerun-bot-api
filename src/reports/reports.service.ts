import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AiService } from '../ai/ai.service';
import type { CitizenReportAnalysis } from '../ai/ai.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AiService,
  ) {}

  private async publicTransaction<T>(
    work: (tx: any) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(work, {
          isolationLevel: 'Serializable',
        });
      } catch (error: any) {
        if (error.code !== 'P2034' || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }

  async registerMessengerChat(
    platform: string,
    platformUserId: string,
    platformChatId: string,
    displayName?: string | null,
    username?: string,
  ) {
    return this.prisma.user.upsert({
      where: { platform_platformUserId: { platform, platformUserId } },
      create: {
        platform,
        platformUserId,
        platformChatId,
        displayName,
        username,
      },
      update: {
        platformChatId,
        displayName: displayName || undefined,
        username: username || undefined,
      },
    });
  }

  async getMessengerChatId(
    platform: string,
    platformUserId: string,
  ): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { platform_platformUserId: { platform, platformUserId } },
    });
    return (
      user?.platformChatId || (platform === 'rubika' ? null : platformUserId)
    );
  }

  async createReport(data: any) {
    const platform = String(data.platform ?? '')
      .trim()
      .toLowerCase();

    const platformUserId = String(data.platformUserId ?? '').trim();

    const text = String(data.text ?? '').trim();

    if (!platform || !platformUserId) {
      throw new BadRequestException('platform and platformUserId are required');
    }

    if (!['bale', 'telegram', 'rubika'].includes(platform))
      throw new BadRequestException('Unsupported platform');
    if (text.length < 10 || text.length > 12000)
      throw new BadRequestException(
        'Report text must contain 10 to 12000 characters',
      );

    if (!text) {
      throw new BadRequestException('Report text is required');
    }

    const sourceMessageKey = data.sourceMessageKey
      ? String(data.sourceMessageKey)
      : null;
    if (sourceMessageKey) {
      const existing = await this.prisma.report.findUnique({
        where: { sourceMessageKey },
        include: { user: true, statusHistory: true },
      });
      if (existing) return existing;
    }

    const recentCount = await this.prisma.report.count({
      where: {
        user: { platform, platformUserId },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recentCount >= 10)
      throw new BadRequestException('Daily report limit reached');

    const trackingCode = `KZ-${Date.now()}-${Math.floor(
      1000 + Math.random() * 9000,
    )}`;

    return this.prisma.report
      .create({
        data: {
          trackingCode,
          sourceMessageKey,
          text,
          location: data.location || null,
          category: data.category || null,

          user: {
            connectOrCreate: {
              where: {
                platform_platformUserId: {
                  platform,
                  platformUserId,
                },
              },
              create: {
                platform,
                platformUserId,
                displayName: data.displayName ?? null,
                username: data.username ?? null,
              },
            },
          },

          statusHistory: {
            create: {
              fromStatus: null,
              toStatus: 'NEW',
              actorType: 'system',
              changedBy: 'system',
              adminNote: 'Report created',
            },
          },
        },

        include: {
          user: true,
          statusHistory: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      })
      .catch(async (error: any) => {
        if (sourceMessageKey && error.code === 'P2002') {
          const existing = await this.prisma.report.findUnique({
            where: { sourceMessageKey },
            include: { user: true, statusHistory: true },
          });
          if (existing) return existing;
        }
        throw error;
      });
  }

  async getReportMediaCount(trackingCode: string): Promise<number> {
    return this.prisma.reportMedia.count({
      where: { report: { trackingCode } },
    });
  }

  async finalizeReport(trackingCode: string) {
    return this.publicTransaction(async (tx: any) => {
      const report = await tx.report.findUnique({ where: { trackingCode } });
      if (!report) throw new NotFoundException('Report not found');
      if (report.submissionCompletedAt) return report;
      const nextStatus = ['NEW', 'NEEDS_INFO'].includes(report.status)
        ? 'READY_FOR_REVIEW'
        : report.status;
      const updated = await tx.report.updateMany({
        where: {
          id: report.id,
          status: report.status,
          submissionCompletedAt: null,
        },
        data: { status: nextStatus, submissionCompletedAt: new Date() },
      });
      if (updated.count && nextStatus !== report.status)
        await tx.reportStatusHistory.create({
          data: {
            reportId: report.id,
            fromStatus: report.status,
            toStatus: nextStatus,
            actorType: 'system',
            changedBy: 'citizen-finalization',
            adminNote: 'Citizen completed submission; review required',
          },
        });
      return tx.report.findUnique({ where: { id: report.id } });
    });
  }

  async getReports() {
    return this.prisma.report.findMany({
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getUserReports(platform: string, platformUserId: string) {
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();

    const normalizedUserId = String(platformUserId ?? '').trim();

    if (!normalizedPlatform || !normalizedUserId) {
      throw new BadRequestException('platform and platformUserId are required');
    }

    const user = await this.prisma.user.findUnique({
      where: {
        platform_platformUserId: {
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      },
      include: {
        reports: {
          orderBy: {
            createdAt: 'desc',
          },
          include: {
            statusHistory: {
              orderBy: {
                createdAt: 'asc',
              },
            },
            media: {
              orderBy: {
                createdAt: 'asc',
              },
            },
          },
        },
      },
    });

    return user?.reports ?? [];
  }

  async getReportByTrackingCode(
    trackingCode: string,
    platform: string,
    platformUserId: string,
  ) {
    const code = String(trackingCode ?? '').trim();

    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();

    const normalizedUserId = String(platformUserId ?? '').trim();

    if (!code || !normalizedPlatform || !normalizedUserId) {
      throw new BadRequestException(
        'trackingCode, platform and platformUserId are required',
      );
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        media: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (
      !report ||
      !report.user ||
      report.user.platform !== normalizedPlatform ||
      report.user.platformUserId !== normalizedUserId
    ) {
      throw new NotFoundException('Report not found');
    }

    return report;
  }

  async updateReportStatus(
    trackingCode: string,
    status: string,
    adminNote?: string,
    finalResult?: string,
    changedBy = 'development-admin',
    actorType = 'editorial',
  ) {
    const code = String(trackingCode ?? '').trim();

    const allowedStatuses = [
      'NEW',
      'NEEDS_INFO',
      'READY_FOR_REVIEW',
      'IN_REVIEW',
      'REFERRED',
      'WAITING_RESPONSE',
      'RESOLVED',
      'REJECTED',
      'PUBLISHED',
    ] as const;

    type AllowedStatus = (typeof allowedStatuses)[number];

    const normalizedStatus = String(status ?? '')
      .trim()
      .toUpperCase() as AllowedStatus;

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    if (!allowedStatuses.includes(normalizedStatus)) {
      throw new BadRequestException('Invalid report status');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    if (report.status === normalizedStatus) {
      return this.prisma.report.update({
        where: {
          trackingCode: code,
        },
        data: {
          adminNote: adminNote !== undefined ? adminNote : undefined,

          finalResult: finalResult !== undefined ? finalResult : undefined,
        },
        include: {
          user: true,
          statusHistory: {
            orderBy: {
              createdAt: 'asc',
            },
          },
          media: {
            orderBy: {
              createdAt: 'asc',
            },
          },
          editorialNotes: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      });
    }

    return this.prisma.report.update({
      where: {
        trackingCode: code,
      },
      data: {
        status: normalizedStatus,

        adminNote: adminNote !== undefined ? adminNote : undefined,

        finalResult: finalResult !== undefined ? finalResult : undefined,

        statusHistory: {
          create: {
            fromStatus: report.status,
            toStatus: normalizedStatus,
            adminNote: adminNote ?? null,
            finalResult: finalResult ?? null,
            actorType,
            changedBy,
          },
        },
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        media: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        editorialNotes: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        departmentResponses: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });
  }

  async getReportForEditorial(trackingCode: string) {
    const code = String(trackingCode ?? '').trim();

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        media: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        editorialNotes: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        departmentResponses: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    return report;
  }

  async setEditorialMessageReference(
    trackingCode: string,
    chatId: string,
    messageId: string,
    platform = 'bale',
  ) {
    const code = String(trackingCode ?? '').trim();

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    return this.prisma.report.update({
      where: {
        trackingCode: code,
      },
      data: {
        editorialPlatform: platform,
        editorialChatId: String(chatId ?? '').trim() || null,
        editorialMessageId: String(messageId ?? '').trim() || null,
      },
    });
  }

  async addEditorialNote(
    trackingCode: string,
    text: string,
    createdByPlatformUserId?: string,
    createdByDisplayName?: string,
    noteType = 'note',
  ) {
    const code = String(trackingCode ?? '').trim();
    const noteText = String(text ?? '').trim();

    if (!code || !noteText) {
      throw new BadRequestException('trackingCode and note text are required');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    const note = await this.prisma.reportEditorialNote.create({
      data: {
        reportId: report.id,
        text: noteText,
        noteType: String(noteType ?? 'note').trim() || 'note',
        createdByPlatformUserId:
          String(createdByPlatformUserId ?? '').trim() || null,
        createdByDisplayName: String(createdByDisplayName ?? '').trim() || null,
      },
    });

    await this.prisma.report.update({
      where: {
        id: report.id,
      },
      data: {
        adminNote: noteText,
      },
    });

    return note;
  }

  async assignReport(
    trackingCode: string,
    platformUserId: string,
    displayName: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const assigneeId = String(platformUserId ?? '').trim();
    const assigneeName = String(displayName ?? '').trim();

    if (!code || !assigneeId) {
      throw new BadRequestException(
        'trackingCode and platformUserId are required',
      );
    }

    const report = await this.prisma.report.update({
      where: {
        trackingCode: code,
      },
      data: {
        assignedToPlatformUserId: assigneeId,
        assignedToDisplayName: assigneeName || assigneeId,
        assignedAt: new Date(),
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        media: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        editorialNotes: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        departmentResponses: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    await this.addEditorialNote(
      code,
      'مسئول پیگیری: ' + (assigneeName || assigneeId),
      assigneeId,
      assigneeName || assigneeId,
      'assignment',
    );

    return report;
  }

  async markReportPublished(trackingCode: string, changedBy = 'editorial') {
    const code = String(trackingCode ?? '').trim();

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    const report = await this.prisma.report.findUnique({
      where: { trackingCode: code },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    const statusChanged = String(report.status) !== 'PUBLISHED';
    const data: any = {
      publishedAt: report.publishedAt ?? new Date(),
      publicLastActivityAt: new Date(),
    };

    if (statusChanged) {
      data.status = 'PUBLISHED';
      data.statusHistory = {
        create: {
          fromStatus: report.status,
          toStatus: 'PUBLISHED',
          actorType: 'editorial',
          changedBy,
          adminNote: 'Report publication registered',
        },
      };
    }

    await this.prisma.report.update({
      where: { id: report.id },
      data,
    });

    return this.getReportForEditorial(code);
  }

  async setCurrentDepartment(trackingCode: string, department: string) {
    const code = String(trackingCode ?? '').trim();
    const value = String(department ?? '').trim();

    if (!code || !value) {
      throw new BadRequestException('trackingCode and department are required');
    }

    await this.prisma.report.update({
      where: { trackingCode: code },
      data: {
        currentDepartment: value.slice(0, 500),
        publicLastActivityAt: new Date(),
      },
    });

    return this.getReportForEditorial(code);
  }

  async setFollowUpDue(
    trackingCode: string,
    days: number,
    changedBy = 'editorial',
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedDays = Math.max(
      1,
      Math.min(30, Math.floor(Number(days) || 0)),
    );

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    const report = await this.prisma.report.findUnique({
      where: { trackingCode: code },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    if (['RESOLVED', 'REJECTED'].includes(String(report.status))) {
      throw new BadRequestException(
        'Closed reports cannot receive a follow-up deadline',
      );
    }

    const dueAt = new Date(Date.now() + normalizedDays * 24 * 60 * 60 * 1000);
    const statusChanged = String(report.status) !== 'WAITING_RESPONSE';
    const data: any = {
      followUpDueAt: dueAt,
      overdueNotifiedAt: null,
      publicLastActivityAt: new Date(),
    };

    if (statusChanged) {
      data.status = 'WAITING_RESPONSE';
      data.statusHistory = {
        create: {
          fromStatus: report.status,
          toStatus: 'WAITING_RESPONSE',
          actorType: 'editorial',
          changedBy,
          adminNote: 'Follow-up deadline set for ' + dueAt.toISOString(),
        },
      };
    }

    await this.prisma.report.update({
      where: { id: report.id },
      data,
    });

    return this.getReportForEditorial(code);
  }

  async registerFollowUp(
    trackingCode: string,
    platformUserId?: string,
    displayName?: string,
  ) {
    const code = String(trackingCode ?? '').trim();

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    const report = await this.prisma.report.findUnique({
      where: { trackingCode: code },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    if (['RESOLVED', 'REJECTED'].includes(String(report.status))) {
      throw new BadRequestException('Closed reports cannot be followed up');
    }

    const actorName =
      String(displayName ?? '').trim() ||
      String(platformUserId ?? '').trim() ||
      'تحریریه';
    const statusChanged = String(report.status) !== 'WAITING_RESPONSE';
    const data: any = {
      followUpCount: { increment: 1 },
      lastFollowUpAt: new Date(),
      followUpDueAt: null,
      overdueNotifiedAt: null,
      publicLastActivityAt: new Date(),
    };

    if (statusChanged) {
      data.status = 'WAITING_RESPONSE';
      data.statusHistory = {
        create: {
          fromStatus: report.status,
          toStatus: 'WAITING_RESPONSE',
          actorType: 'editorial',
          changedBy: actorName,
          adminNote: 'Follow-up registered; waiting for response',
        },
      };
    }

    await this.prisma.report.update({
      where: { id: report.id },
      data,
    });

    await this.addEditorialNote(
      code,
      'پیگیری مجدد ثبت شد؛ منتظر پاسخ دستگاه.',
      platformUserId,
      displayName,
      'followup',
    );

    return this.getReportForEditorial(code);
  }

  async addDepartmentResponse(
    trackingCode: string,
    text: string,
    platformUserId?: string,
    displayName?: string,
    media?: any,
  ) {
    const code = String(trackingCode ?? '').trim();
    const body = String(text ?? '').trim();
    const hasMedia = Boolean(media?.fileId || media?.sourceMessageId);

    if (!code || (!body && !hasMedia)) {
      throw new BadRequestException(
        'trackingCode and a response text or document are required',
      );
    }

    const report = await this.prisma.report.findUnique({
      where: { trackingCode: code },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    await this.prisma.reportDepartmentResponse.create({
      data: {
        reportId: report.id,
        text: body || null,
        sourceChatId: String(media?.sourceChatId ?? '').trim() || null,
        sourceMessageId: String(media?.sourceMessageId ?? '').trim() || null,
        mediaType: String(media?.mediaType ?? '').trim() || null,
        fileId: String(media?.fileId ?? '').trim() || null,
        fileUniqueId: String(media?.fileUniqueId ?? '').trim() || null,
        caption: String(media?.caption ?? '').trim() || null,
        mimeType: String(media?.mimeType ?? '').trim() || null,
        fileName: String(media?.fileName ?? '').trim() || null,
        createdByPlatformUserId: String(platformUserId ?? '').trim() || null,
        createdByDisplayName: String(displayName ?? '').trim() || null,
      },
    });

    const statusChanged = ![
      'RESOLVED',
      'REJECTED',
      'PUBLISHED',
      'IN_REVIEW',
    ].includes(String(report.status));
    const updateData: any = {
      lastFollowUpAt: new Date(),
      followUpDueAt: null,
      overdueNotifiedAt: null,
      publicLastActivityAt: new Date(),
    };

    if (statusChanged) {
      updateData.status = 'IN_REVIEW';
      updateData.statusHistory = {
        create: {
          fromStatus: report.status,
          toStatus: 'IN_REVIEW',
          actorType: 'editorial',
          changedBy: String(displayName ?? '').trim() || 'تحریریه',
          adminNote: 'Response from responsible organization received',
        },
      };
    }

    await this.prisma.report.update({
      where: { id: report.id },
      data: updateData,
    });

    await this.addEditorialNote(
      code,
      body ? 'پاسخ دستگاه: ' + body : 'یک مستند به‌عنوان پاسخ دستگاه ثبت شد.',
      platformUserId,
      displayName,
      'department_response',
    );

    return this.getReportForEditorial(code);
  }

  async getOverdueFollowUps(platform?: string) {
    return this.prisma.report.findMany({
      where: {
        ...(platform ? { user: { platform } } : {}),
        followUpDueAt: {
          lte: new Date(),
        },
        overdueNotifiedAt: null,
        status: {
          notIn: ['RESOLVED', 'REJECTED'],
        },
      },
      include: {
        user: true,
        media: true,
        editorialNotes: {
          orderBy: { createdAt: 'asc' },
        },
        departmentResponses: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: {
        followUpDueAt: 'asc',
      },
      take: 20,
    });
  }

  async markOverdueNotified(trackingCode: string) {
    return this.prisma.report.update({
      where: { trackingCode: String(trackingCode).trim() },
      data: { overdueNotifiedAt: new Date() },
    });
  }

  async publishPublicDemand(
    trackingCode: string,
    title: string,
    summary: string,
    platformUserId?: string,
    displayName?: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const cleanTitle = String(title ?? '').trim();
    const cleanSummary = String(summary ?? '').trim();

    if (!code || cleanTitle.length < 5 || cleanSummary.length < 10) {
      throw new BadRequestException('A public title and summary are required');
    }

    const report = await this.prisma.report.findUnique({
      where: { trackingCode: code },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    await this.prisma.report.update({
      where: { id: report.id },
      data: {
        isPublicDemand: true,
        publicTitle: cleanTitle.slice(0, 180),
        publicSummary: cleanSummary.slice(0, 1500),
        publicPublishedAt: report.publicPublishedAt ?? new Date(),
        publicLastActivityAt: new Date(),
      },
    });

    await this.recalculatePublicDemandMetrics(report.id);

    await this.addEditorialNote(
      code,
      'مطالبه برای نمایش عمومی فعال شد: ' + cleanTitle,
      platformUserId,
      displayName,
      'public_demand',
    );

    return this.getReportForEditorial(code);
  }

  async unpublishPublicDemand(
    trackingCode: string,
    platformUserId?: string,
    displayName?: string,
  ) {
    const code = String(trackingCode ?? '').trim();

    await this.prisma.report.update({
      where: { trackingCode: code },
      data: {
        isPublicDemand: false,
        publicLastActivityAt: new Date(),
      },
    });

    await this.addEditorialNote(
      code,
      'نمایش عمومی مطالبه متوقف شد.',
      platformUserId,
      displayName,
      'public_demand_off',
    );

    return this.getReportForEditorial(code);
  }

  private async recalculatePublicDemandMetrics(
    reportId: string,
    db: any = this.prisma,
  ) {
    const [
      supportCount,
      affectedCount,
      experienceCount,
      evidenceCount,
      followerCount,
      solvedConfirmCount,
      unresolvedCount,
    ] = await Promise.all([
      db.reportPublicSupport.count({ where: { reportId } }),
      db.reportPublicAffected.count({ where: { reportId } }),
      db.reportPublicExperience.count({
        where: { reportId, status: 'APPROVED' },
      }),
      db.reportPublicEvidence.count({
        where: { reportId, status: 'APPROVED' },
      }),
      db.reportPublicFollower.count({ where: { reportId } }),
      db.reportPublicResolutionVote.count({
        where: { reportId, vote: 'SOLVED' },
      }),
      db.reportPublicResolutionVote.count({
        where: { reportId, vote: 'UNRESOLVED' },
      }),
    ]);

    const priorityScore =
      supportCount +
      affectedCount * 2 +
      experienceCount * 2 +
      evidenceCount * 3 +
      unresolvedCount * 2;

    await db.report.update({
      where: { id: reportId },
      data: {
        publicSupportCount: supportCount,
        publicAffectedCount: affectedCount,
        publicExperienceCount: experienceCount,
        publicEvidenceCount: evidenceCount,
        publicFollowerCount: followerCount,
        publicSolvedConfirmCount: solvedConfirmCount,
        publicUnresolvedCount: unresolvedCount,
        publicPriorityScore: priorityScore,
        publicLastActivityAt: new Date(),
      },
    });

    return {
      supportCount,
      affectedCount,
      experienceCount,
      evidenceCount,
      followerCount,
      solvedConfirmCount,
      unresolvedCount,
      priorityScore,
    };
  }

  async getPublicDemands(
    platform: string,
    platformUserId: string,
    limit = 8,
    offset = 0,
    view = 'popular',
  ) {
    const reports = await this.prisma.report.findMany({
      where: {
        isPublicDemand: true,
        ...(view === 'resolved' ? { status: 'RESOLVED' as const } : {}),
        ...(view === 'active'
          ? { status: { notIn: ['RESOLVED', 'REJECTED'] as any } }
          : {}),
        ...(view === 'followed'
          ? {
              publicFollowers: {
                some: {
                  platform: platform.trim().toLowerCase(),
                  platformUserId: platformUserId.trim(),
                },
              },
            }
          : {}),
      },
      skip: Math.max(0, Math.floor(Number(offset) || 0)),
      orderBy:
        view === 'newest'
          ? [{ publicPublishedAt: 'desc' }, { id: 'asc' }]
          : [
              { publicPriorityScore: 'desc' },
              { publicSupportCount: 'desc' },
              { publicPublishedAt: 'desc' },
              { id: 'asc' },
            ],
      take: Math.max(1, Math.min(10, Number(limit) || 8)),
      select: {
        id: true,
        trackingCode: true,
        publicTitle: true,
        publicSummary: true,
        publicSupportCount: true,
        publicAffectedCount: true,
        publicExperienceCount: true,
        publicEvidenceCount: true,
        publicFollowerCount: true,
        publicSolvedConfirmCount: true,
        publicUnresolvedCount: true,
        publicPriorityScore: true,
        publicPublishedAt: true,
        status: true,
        category: true,
        priority: true,
        currentDepartment: true,
        finalResult: true,
        updatedAt: true,
      },
    });

    const ids = reports.map((item: any) => item.id);
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    const [supports, affected, followers, resolutionVotes] = ids.length
      ? await Promise.all([
          this.prisma.reportPublicSupport.findMany({
            where: {
              reportId: { in: ids },
              platform: normalizedPlatform,
              platformUserId: normalizedUserId,
            },
            select: { reportId: true },
          }),
          this.prisma.reportPublicAffected.findMany({
            where: {
              reportId: { in: ids },
              platform: normalizedPlatform,
              platformUserId: normalizedUserId,
            },
            select: { reportId: true },
          }),
          this.prisma.reportPublicFollower.findMany({
            where: {
              reportId: { in: ids },
              platform: normalizedPlatform,
              platformUserId: normalizedUserId,
            },
            select: { reportId: true },
          }),
          this.prisma.reportPublicResolutionVote.findMany({
            where: {
              reportId: { in: ids },
              platform: normalizedPlatform,
              platformUserId: normalizedUserId,
            },
            select: { reportId: true, vote: true },
          }),
        ])
      : [[], [], [], []];

    const supportedIds = new Set(supports.map((item: any) => item.reportId));
    const affectedIds = new Set(affected.map((item: any) => item.reportId));
    const followedIds = new Set(followers.map((item: any) => item.reportId));
    const voteMap = new Map(
      resolutionVotes.map((item: any) => [item.reportId, item.vote]),
    );

    return reports.map((item: any) => ({
      ...item,
      supportedByUser: supportedIds.has(item.id),
      affectedByUser: affectedIds.has(item.id),
      followedByUser: followedIds.has(item.id),
      resolutionVoteByUser: voteMap.get(item.id) ?? null,
    }));
  }

  async getPublicDemandForUser(
    trackingCode: string,
    platform: string,
    platformUserId: string,
  ) {
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    const report = await this.prisma.report.findFirst({
      where: {
        trackingCode: String(trackingCode ?? '').trim(),
        isPublicDemand: true,
      },
      include: {
        departmentResponses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        publicExperiences: {
          where: { status: 'APPROVED' },
          orderBy: [
            { isPinned: 'desc' },
            { likeCount: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 5,
        },
      },
    });

    if (!report) {
      throw new NotFoundException('Public demand not found');
    }

    const experienceIds = report.publicExperiences.map((item: any) => item.id);

    const [support, affected, follower, resolutionVote, experienceVotes] =
      await Promise.all([
        this.prisma.reportPublicSupport.findFirst({
          where: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        }),
        this.prisma.reportPublicAffected.findFirst({
          where: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        }),
        this.prisma.reportPublicFollower.findFirst({
          where: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        }),
        this.prisma.reportPublicResolutionVote.findFirst({
          where: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        }),
        experienceIds.length
          ? this.prisma.reportPublicExperienceVote.findMany({
              where: {
                experienceId: { in: experienceIds },
                platform: normalizedPlatform,
                platformUserId: normalizedUserId,
              },
              select: { experienceId: true },
            })
          : [],
      ]);

    const likedExperienceIds = new Set(
      (experienceVotes as any[]).map((item: any) => item.experienceId),
    );

    return {
      trackingCode: report.trackingCode,
      publicTitle: report.publicTitle,
      publicSummary: report.publicSummary,
      status: report.status,
      category: report.category,
      currentDepartment: report.currentDepartment,
      finalResult: report.finalResult,
      publicPriorityScore: report.publicPriorityScore,
      publicSupportCount: report.publicSupportCount,
      publicAffectedCount: report.publicAffectedCount,
      publicExperienceCount: report.publicExperienceCount,
      publicEvidenceCount: report.publicEvidenceCount,
      publicFollowerCount: report.publicFollowerCount,
      publicPublishedAt: report.publicPublishedAt,
      publicSolvedConfirmCount: report.publicSolvedConfirmCount,
      publicUnresolvedCount: report.publicUnresolvedCount,
      supportedByUser: Boolean(support),
      affectedByUser: Boolean(affected),
      followedByUser: Boolean(follower),
      resolutionVoteByUser: resolutionVote?.vote ?? null,
      departmentResponses: report.departmentResponses.map((item: any) => ({
        text: item.text,
        createdAt: item.createdAt,
      })),
      publicExperiences: report.publicExperiences.map((item: any) => ({
        id: item.id,
        text: item.text,
        isPinned: item.isPinned,
        likeCount: item.likeCount,
        likedByUser: likedExperienceIds.has(item.id),
      })),
    };
  }

  async togglePublicSupport(
    trackingCode: string,
    platform: string,
    platformUserId: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    if (!code || !normalizedPlatform || !normalizedUserId) {
      throw new BadRequestException(
        'trackingCode, platform and platformUserId are required',
      );
    }

    return this.publicTransaction(async (tx: any) => {
      const report = await tx.report.findFirst({
        where: { trackingCode: code, isPublicDemand: true },
      });

      if (!report) {
        throw new NotFoundException('Public demand not found');
      }

      const existing = await tx.reportPublicSupport.findFirst({
        where: {
          reportId: report.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });

      let supported = true;

      if (existing) {
        await tx.reportPublicSupport.delete({ where: { id: existing.id } });
        supported = false;
      } else {
        await tx.reportPublicSupport.create({
          data: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        });
      }

      const metrics = await this.recalculatePublicDemandMetrics(report.id, tx);

      return {
        supported,
        count: metrics.supportCount,
        priorityScore: metrics.priorityScore,
      };
    });
  }

  async togglePublicAffected(
    trackingCode: string,
    platform: string,
    platformUserId: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    return this.publicTransaction(async (tx: any) => {
      const report = await tx.report.findFirst({
        where: { trackingCode: code, isPublicDemand: true },
      });
      if (!report) throw new NotFoundException('Public demand not found');

      const existing = await tx.reportPublicAffected.findFirst({
        where: {
          reportId: report.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });

      let affected = true;
      if (existing) {
        await tx.reportPublicAffected.delete({ where: { id: existing.id } });
        affected = false;
      } else {
        await tx.reportPublicAffected.create({
          data: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        });
      }

      const metrics = await this.recalculatePublicDemandMetrics(report.id, tx);
      return {
        affected,
        count: metrics.affectedCount,
        priorityScore: metrics.priorityScore,
      };
    });
  }

  async togglePublicFollower(
    trackingCode: string,
    platform: string,
    platformUserId: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    return this.publicTransaction(async (tx: any) => {
      const report = await tx.report.findFirst({
        where: { trackingCode: code, isPublicDemand: true },
      });
      if (!report) throw new NotFoundException('Public demand not found');

      const existing = await tx.reportPublicFollower.findFirst({
        where: {
          reportId: report.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });

      let followed = true;
      if (existing) {
        await tx.reportPublicFollower.delete({ where: { id: existing.id } });
        followed = false;
      } else {
        await tx.reportPublicFollower.create({
          data: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        });
      }

      const metrics = await this.recalculatePublicDemandMetrics(report.id, tx);
      return { followed, count: metrics.followerCount };
    });
  }

  async getPublicFollowers(trackingCode: string, platform: string, offset = 0) {
    const report = await this.prisma.report.findFirst({
      where: {
        trackingCode: String(trackingCode ?? '').trim(),
        isPublicDemand: true,
      },
      select: { id: true },
    });
    if (!report) return [];

    return this.prisma.reportPublicFollower.findMany({
      where: {
        reportId: report.id,
        platform: String(platform ?? '')
          .trim()
          .toLowerCase(),
      },
      select: { platformUserId: true },
      skip: offset,
      take: 100,
      orderBy: { id: 'asc' },
    });
  }

  async createPublicExperience(
    trackingCode: string,
    platform: string,
    platformUserId: string,
    text: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();
    const cleanText = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 10 || cleanText.length > 700) {
      throw new BadRequestException('Experience text length is invalid');
    }

    const report = await this.prisma.report.findFirst({
      where: { trackingCode: code, isPublicDemand: true },
    });
    if (!report) throw new NotFoundException('Public demand not found');

    const recentCount = await this.prisma.reportPublicExperience.count({
      where: {
        reportId: report.id,
        platform: normalizedPlatform,
        platformUserId: normalizedUserId,
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    });

    if (recentCount >= 3) {
      throw new BadRequestException('Daily experience limit reached');
    }

    const experience = await this.prisma.reportPublicExperience.create({
      data: {
        reportId: report.id,
        platform: normalizedPlatform,
        platformUserId: normalizedUserId,
        text: cleanText,
        status: 'PENDING',
      },
    });

    await this.prisma.report.update({
      where: { id: report.id },
      data: { publicLastActivityAt: new Date() },
    });

    return { experience, report };
  }

  async moderatePublicExperience(
    experienceId: string,
    approved: boolean,
    moderatedBy?: string,
    pinned = false,
  ) {
    const experience = await this.prisma.reportPublicExperience.findUnique({
      where: { id: String(experienceId ?? '').trim() },
      include: { report: true },
    });
    if (!experience) throw new NotFoundException('Experience not found');

    await this.prisma.reportPublicExperience.update({
      where: { id: experience.id },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        isPinned: approved ? Boolean(pinned || experience.isPinned) : false,
        moderatedBy: String(moderatedBy ?? '').trim() || null,
        moderatedAt: new Date(),
      },
    });

    const metrics = await this.recalculatePublicDemandMetrics(
      experience.reportId,
    );
    return {
      approved,
      trackingCode: experience.report.trackingCode,
      text: experience.text,
      metrics,
    };
  }

  async togglePublicExperienceVote(
    experienceId: string,
    platform: string,
    platformUserId: string,
  ) {
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    return this.publicTransaction(async (tx: any) => {
      const experience = await tx.reportPublicExperience.findFirst({
        where: {
          id: String(experienceId ?? '').trim(),
          status: 'APPROVED',
          report: { isPublicDemand: true },
        },
        include: { report: true },
      });
      if (!experience) throw new NotFoundException('Experience not found');

      const existing = await tx.reportPublicExperienceVote.findFirst({
        where: {
          experienceId: experience.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });

      let liked = true;
      if (existing) {
        await tx.reportPublicExperienceVote.delete({
          where: { id: existing.id },
        });
        liked = false;
      } else {
        await tx.reportPublicExperienceVote.create({
          data: {
            experienceId: experience.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
          },
        });
      }

      const count = await tx.reportPublicExperienceVote.count({
        where: { experienceId: experience.id },
      });
      await tx.reportPublicExperience.update({
        where: { id: experience.id },
        data: { likeCount: count },
      });

      return {
        liked,
        count,
        trackingCode: experience.report.trackingCode,
      };
    });
  }

  async flagPublicExperience(
    experienceId: string,
    platform: string,
    platformUserId: string,
  ) {
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    return this.publicTransaction(async (tx: any) => {
      const experience = await tx.reportPublicExperience.findFirst({
        where: {
          id: String(experienceId ?? '').trim(),
          status: { in: ['APPROVED', 'REVIEW'] },
        },
        include: { report: true },
      });
      if (!experience) throw new NotFoundException('Experience not found');

      const existing = await tx.reportPublicExperienceFlag.findFirst({
        where: {
          experienceId: experience.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });
      if (existing) {
        return {
          alreadyFlagged: true,
          flagCount: experience.flagCount,
          trackingCode: experience.report.trackingCode,
          experienceId: experience.id,
          text: experience.text,
        };
      }

      await tx.reportPublicExperienceFlag.create({
        data: {
          experienceId: experience.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });
      const flagCount = await tx.reportPublicExperienceFlag.count({
        where: { experienceId: experience.id },
      });

      await tx.reportPublicExperience.update({
        where: { id: experience.id },
        data: {
          flagCount,
          status: flagCount >= 3 ? 'REVIEW' : experience.status,
        },
      });

      if (flagCount >= 3) {
        await this.recalculatePublicDemandMetrics(experience.reportId, tx);
      }

      return {
        alreadyFlagged: false,
        flagCount,
        hiddenForReview: flagCount >= 3,
        trackingCode: experience.report.trackingCode,
        experienceId: experience.id,
        text: experience.text,
      };
    });
  }

  async createPublicEvidence(trackingCode: string, data: any) {
    const code = String(trackingCode ?? '').trim();
    const platform = String(data?.platform ?? '')
      .trim()
      .toLowerCase();
    const platformUserId = String(data?.platformUserId ?? '').trim();
    const sourceChatId = String(data?.sourceChatId ?? '').trim();
    const sourceMessageId = String(data?.sourceMessageId ?? '').trim();
    const mediaType = String(data?.mediaType ?? 'media').trim();

    const report = await this.prisma.report.findFirst({
      where: { trackingCode: code, isPublicDemand: true },
    });
    if (!report) throw new NotFoundException('Public demand not found');

    const todayCount = await this.prisma.reportPublicEvidence.count({
      where: {
        reportId: report.id,
        platform,
        platformUserId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (todayCount >= 5) {
      throw new BadRequestException('Daily evidence limit reached');
    }

    const existing = await this.prisma.reportPublicEvidence.findFirst({
      where: {
        reportId: report.id,
        platform,
        sourceChatId,
        sourceMessageId,
        mediaType,
      },
    });
    if (existing) return { evidence: existing, report };

    const evidence = await this.prisma.reportPublicEvidence.create({
      data: {
        reportId: report.id,
        platform,
        platformUserId,
        sourceChatId,
        sourceMessageId,
        mediaType,
        fileId: String(data?.fileId ?? '').trim() || null,
        fileUniqueId: String(data?.fileUniqueId ?? '').trim() || null,
        caption:
          String(data?.caption ?? '')
            .trim()
            .slice(0, 1000) || null,
        mimeType: String(data?.mimeType ?? '').trim() || null,
        fileName: String(data?.fileName ?? '').trim() || null,
        status: 'PENDING',
      },
    });

    await this.prisma.report.update({
      where: { id: report.id },
      data: { publicLastActivityAt: new Date() },
    });

    return { evidence, report };
  }

  async moderatePublicEvidence(
    evidenceId: string,
    approved: boolean,
    moderatedBy?: string,
  ) {
    const evidence = await this.prisma.reportPublicEvidence.findUnique({
      where: { id: String(evidenceId ?? '').trim() },
      include: { report: true },
    });
    if (!evidence) throw new NotFoundException('Evidence not found');

    await this.prisma.reportPublicEvidence.update({
      where: { id: evidence.id },
      data: {
        status: approved ? 'APPROVED' : 'REJECTED',
        moderatedBy: String(moderatedBy ?? '').trim() || null,
        moderatedAt: new Date(),
      },
    });

    const metrics = await this.recalculatePublicDemandMetrics(
      evidence.reportId,
    );
    return {
      approved,
      trackingCode: evidence.report.trackingCode,
      caption: evidence.caption,
      metrics,
    };
  }

  async togglePublicResolutionVote(
    trackingCode: string,
    vote: 'SOLVED' | 'UNRESOLVED',
    platform: string,
    platformUserId: string,
  ) {
    const code = String(trackingCode ?? '').trim();
    const normalizedPlatform = String(platform ?? '')
      .trim()
      .toLowerCase();
    const normalizedUserId = String(platformUserId ?? '').trim();

    return this.publicTransaction(async (tx: any) => {
      const report = await tx.report.findFirst({
        where: { trackingCode: code, isPublicDemand: true },
      });
      if (!report) throw new NotFoundException('Public demand not found');
      if (report.status !== 'RESOLVED') {
        throw new BadRequestException('Resolution verification is not open');
      }

      const existing = await tx.reportPublicResolutionVote.findFirst({
        where: {
          reportId: report.id,
          platform: normalizedPlatform,
          platformUserId: normalizedUserId,
        },
      });

      let currentVote: string | null = vote;
      if (existing?.vote === vote) {
        await tx.reportPublicResolutionVote.delete({
          where: { id: existing.id },
        });
        currentVote = null;
      } else if (existing) {
        await tx.reportPublicResolutionVote.update({
          where: { id: existing.id },
          data: { vote },
        });
      } else {
        await tx.reportPublicResolutionVote.create({
          data: {
            reportId: report.id,
            platform: normalizedPlatform,
            platformUserId: normalizedUserId,
            vote,
          },
        });
      }

      const metrics = await this.recalculatePublicDemandMetrics(report.id, tx);
      return {
        currentVote,
        solvedCount: metrics.solvedConfirmCount,
        unresolvedCount: metrics.unresolvedCount,
        priorityScore: metrics.priorityScore,
      };
    });
  }

  async addReportMedia(trackingCode: string, data: any) {
    const code = String(trackingCode ?? '').trim();
    const platform = String(data?.platform ?? '')
      .trim()
      .toLowerCase();
    const platformUserId = String(data?.platformUserId ?? '').trim();
    const sourceChatId = String(data?.sourceChatId ?? '').trim();
    const sourceMessageId = String(data?.sourceMessageId ?? '').trim();
    const mediaType = String(data?.mediaType ?? 'media').trim();

    if (
      !code ||
      !platform ||
      !platformUserId ||
      !sourceChatId ||
      !sourceMessageId
    ) {
      throw new BadRequestException('Media source information is incomplete');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
      include: {
        user: true,
      },
    });

    if (
      !report ||
      !report.user ||
      report.user.platform !== platform ||
      report.user.platformUserId !== platformUserId
    ) {
      throw new NotFoundException('Report not found');
    }

    const existing = await this.prisma.reportMedia.findFirst({
      where: {
        reportId: report.id,
        platform,
        sourceChatId,
        sourceMessageId,
        mediaType,
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.reportMedia.create({
      data: {
        reportId: report.id,
        platform,
        sourceChatId,
        sourceMessageId,
        mediaType,
        fileId: String(data?.fileId ?? '').trim() || null,
        fileUniqueId: String(data?.fileUniqueId ?? '').trim() || null,
        caption: String(data?.caption ?? '').trim() || null,
        mimeType: String(data?.mimeType ?? '').trim() || null,
        fileName: String(data?.fileName ?? '').trim() || null,
      },
    });
  }

  async analyzeReportWithAi(trackingCode: string) {
    const code = String(trackingCode ?? '').trim();

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (!report) {
      throw new NotFoundException('Report not found');
    }

    await this.prisma.report.update({
      where: {
        id: report.id,
      },
      data: {
        aiStatus: 'processing',
      },
    });

    try {
      const analysis = await this.aiService.analyzeCitizenReport({
        text: report.text,
        location: report.location ?? undefined,
        category: report.category ?? undefined,
        previousAnswers: report.userAnswers ?? undefined,
      });

      return await this.saveAiAnalysis(report, analysis);
    } catch (error) {
      await this.prisma.report.update({
        where: {
          id: report.id,
        },
        data: {
          aiStatus: 'failed',
        },
      });

      throw error;
    }
  }

  async submitAnswersAndReanalyze(trackingCode: string, data: any) {
    const code = String(trackingCode ?? '').trim();

    const platform = String(data.platform ?? '')
      .trim()
      .toLowerCase();

    const platformUserId = String(data.platformUserId ?? '').trim();

    const answers = data.answers;

    if (!code) {
      throw new BadRequestException('trackingCode is required');
    }

    if (!platform || !platformUserId) {
      throw new BadRequestException('platform and platformUserId are required');
    }

    if (!Array.isArray(answers) || answers.length === 0) {
      throw new BadRequestException('answers must be a non-empty array');
    }

    const cleanedAnswers = answers
      .map((item: any, index: number) => {
        return {
          number: index + 1,
          question: String(item?.question ?? '').trim(),
          answer: String(item?.answer ?? '').trim(),
        };
      })
      .filter((item: any) => item.answer.length > 0);

    if (cleanedAnswers.length === 0) {
      throw new BadRequestException('At least one answer is required');
    }

    const report = await this.prisma.report.findUnique({
      where: {
        trackingCode: code,
      },
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    if (
      !report ||
      !report.user ||
      report.user.platform !== platform ||
      report.user.platformUserId !== platformUserId
    ) {
      throw new NotFoundException('Report not found');
    }

    if (report.aiStatus !== 'needs_info') {
      throw new BadRequestException(
        'This report is not waiting for additional information',
      );
    }

    const oldAnswers: any = report.userAnswers;

    let previousRounds: any[] = [];

    if (
      oldAnswers &&
      typeof oldAnswers === 'object' &&
      !Array.isArray(oldAnswers) &&
      Array.isArray(oldAnswers.rounds)
    ) {
      previousRounds = oldAnswers.rounds;
    }

    const currentQuestions = Array.isArray(report.aiQuestions)
      ? report.aiQuestions
      : [];

    const currentRound = {
      submittedAt: new Date().toISOString(),
      questions: currentQuestions,
      answers: cleanedAnswers,
    };

    const answerHistory = {
      rounds: [...previousRounds, currentRound],
    };

    await this.prisma.report.update({
      where: {
        id: report.id,
      },
      data: {
        userAnswers: answerHistory,
        aiStatus: 'processing',
      },
    });

    try {
      const analysis = await this.aiService.analyzeCitizenReport({
        text: report.text,
        location: report.location ?? undefined,
        category: report.category ?? undefined,
        previousAnswers: answerHistory,
      });

      // تجربه کاربری کازرون خبر:
      // فقط یک دور سؤال تکمیلی از شهروند گرفته می‌شود.
      // پس از پاسخ، گزارش برای بررسی تحریریه آماده می‌شود.
      const finalAnalysis: CitizenReportAnalysis = {
        ...analysis,
        isComplete: true,
        questions: [],
        needsHumanReview:
          analysis.needsHumanReview ||
          (analysis.actionability === 'NEEDS_INFO' &&
            analysis.missingCriticalInfo.length > 0),
      };

      const result = await this.saveAiAnalysis(report, finalAnalysis);

      return {
        answers: cleanedAnswers,
        analysis: finalAnalysis,
        report: result.report,
      };
    } catch (error) {
      await this.prisma.report.update({
        where: {
          id: report.id,
        },
        data: {
          userAnswers: answerHistory,
          aiStatus: 'failed',
        },
      });

      throw error;
    }
  }

  private async saveAiAnalysis(report: any, analysis: CitizenReportAnalysis) {
    const nextStatus = ['NEW', 'NEEDS_INFO', 'READY_FOR_REVIEW'].includes(
      report.status,
    )
      ? analysis.isComplete
        ? report.submissionCompletedAt
          ? 'READY_FOR_REVIEW'
          : 'NEW'
        : 'NEEDS_INFO'
      : report.status;

    const nextAiStatus = analysis.isComplete ? 'ready' : 'needs_info';

    const finalCategory = analysis.category || report.category || null;

    const aiModel = process.env.ARVAN_AI_MODEL || 'GPT-5.6-Luna';

    const statusChanged = report.status !== nextStatus;

    const updateData: any = {
      category: finalCategory,
      priority: analysis.priority,
      status: nextStatus,
      aiStatus: nextAiStatus,
      aiQuestions: analysis.questions,
      aiSummary: analysis.summary,
      aiSuggestedDepartments: analysis.suggestedDepartments,
      aiRiskFlags: analysis.riskFlags,
      aiConfidence: analysis.confidence,
      aiActionability: analysis.actionability,
      aiMissingCriticalInfo: analysis.missingCriticalInfo,
      aiNeedsHumanReview: analysis.needsHumanReview,
      aiModel,
      aiAnalyzedAt: new Date(),
    };

    if (statusChanged) {
      updateData.statusHistory = {
        create: {
          fromStatus: report.status,
          toStatus: nextStatus,
          actorType: 'ai',
          changedBy: 'ai-report-investigator',
          adminNote: analysis.isComplete
            ? analysis.actionability === 'NOT_ACTIONABLE'
              ? 'AI analysis completed. Message may not be an actionable citizen report and needs editorial review.'
              : analysis.needsHumanReview
                ? 'AI analysis completed. Report is ready for editorial review and requires human attention.'
                : 'AI analysis completed. Report is ready for editorial review.'
            : 'AI analysis completed. More information is required.',
        },
      };
    }

    const updatedReport = await this.prisma.report.update({
      where: {
        id: report.id,
      },
      data: updateData,
      include: {
        user: true,
        statusHistory: {
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });

    return {
      analysis,
      report: updatedReport,
    };
  }
}
