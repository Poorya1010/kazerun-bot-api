import { ReportsService } from './reports.service';

const code = 'KZ-1786378025672-6221';
function fixture() {
  const report: any = {
    id: 'r1',
    trackingCode: code,
    status: 'NEW',
    user: { platform: 'telegram', platformUserId: '7' },
  };
  const prisma: any = {
    report: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(report),
      create: jest.fn().mockResolvedValue(report),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(report),
      findFirst: jest.fn().mockResolvedValue(report),
      findMany: jest.fn().mockResolvedValue([]),
    },
    reportStatusHistory: { create: jest.fn() },
    user: {
      findUnique: jest.fn().mockResolvedValue({ platformChatId: 'chat-guid' }),
      upsert: jest.fn(),
    },
    reportPublicSupport: { findFirst: jest.fn().mockResolvedValue(null) },
    reportPublicAffected: { findFirst: jest.fn().mockResolvedValue(null) },
    reportPublicFollower: { findFirst: jest.fn().mockResolvedValue(null) },
    reportPublicResolutionVote: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    reportPublicExperienceVote: { findMany: jest.fn().mockResolvedValue([]) },
    reportMedia: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
  };
  prisma.$transaction = jest.fn((callback: any) => callback(prisma));
  const ai: any = { analyzeCitizenReport: jest.fn() };
  return { service: new ReportsService(prisma, ai), prisma, report, ai };
}

describe('Report persistence and ownership', () => {
  it('repeated delivery returns the existing report', async () => {
    const { service, prisma, report } = fixture();
    expect(
      await service.createReport({
        platform: 'telegram',
        platformUserId: '7',
        text: 'گزارش مشکل روشنایی خیابان',
        sourceMessageKey: 'telegram:7:1',
      }),
    ).toBe(report);
    expect(prisma.report.create).not.toHaveBeenCalled();
  });
  it('final submission changes failed or incomplete AI reports to the review queue atomically', async () => {
    const { service, prisma } = fixture();
    await service.finalizeReport(code);
    expect(prisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: 'NEW', submissionCompletedAt: null },
      data: {
        status: 'READY_FOR_REVIEW',
        submissionCompletedAt: expect.any(Date),
      },
    });
    expect(prisma.reportStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fromStatus: 'NEW',
          toStatus: 'READY_FOR_REVIEW',
        }),
      }),
    );
  });
  it('does not overwrite an editorial decision on repeated finalization', async () => {
    const { service, prisma, report } = fixture();
    report.status = 'RESOLVED';
    report.submissionCompletedAt = new Date();
    await service.finalizeReport(code);
    expect(prisma.report.updateMany).not.toHaveBeenCalled();
  });
  it('the same numeric user ID on another platform cannot read a private report', async () => {
    const { service } = fixture();
    await expect(
      service.getReportByTrackingCode(code, 'bale', '7'),
    ).rejects.toThrow('Report not found');
    await expect(
      service.getReportByTrackingCode(code, 'telegram', '8'),
    ).rejects.toThrow('Report not found');
    await expect(
      service.getReportByTrackingCode(code, 'telegram', '7'),
    ).resolves.toBeDefined();
  });
  it('unauthorized users cannot attach evidence to a private report', async () => {
    const { service, prisma } = fixture();
    await expect(
      service.addReportMedia(code, {
        platform: 'rubika',
        platformUserId: '7',
        sourceChatId: 'c',
        sourceMessageId: 'm',
      }),
    ).rejects.toThrow('Report not found');
    expect(prisma.reportMedia.create).not.toHaveBeenCalled();
  });
  it('public demand responses exclude private report and author data', async () => {
    const { service, report } = fixture();
    Object.assign(report, {
      text: 'PRIVATE ORIGINAL REPORT',
      adminNote: 'PRIVATE NOTE',
      userId: 'private-user',
      publicTitle: 'روشنایی خیابان',
      publicSummary: 'متن عمومی تأییدشده',
      departmentResponses: [
        { text: 'پاسخ', fileId: 'secret', createdByPlatformUserId: 'editor' },
      ],
      publicExperiences: [
        {
          id: 'e',
          text: 'تجربه عمومی',
          platformUserId: 'private-author',
          platform: 'bale',
          isPinned: false,
          likeCount: 1,
        },
      ],
    });
    const result: any = await service.getPublicDemandForUser(
      code,
      'telegram',
      '7',
    );
    expect(result.text).toBeUndefined();
    expect(result.adminNote).toBeUndefined();
    expect(result.user).toBeUndefined();
    expect(result.userId).toBeUndefined();
    expect(result.publicExperiences[0].platformUserId).toBeUndefined();
    expect(result.departmentResponses[0].fileId).toBeUndefined();
    expect(result.publicSummary).toBe('متن عمومی تأییدشده');
  });
  it('supports followed and active filters with pagination', async () => {
    const { service, prisma } = fixture();
    await service.getPublicDemands('rubika', 'u-guid', 7, 12, 'followed');
    expect(prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 12,
        where: expect.objectContaining({
          publicFollowers: {
            some: { platform: 'rubika', platformUserId: 'u-guid' },
          },
        }),
      }),
    );
  });
  it('uses the saved Rubika chat ID and never guesses it from user ID', async () => {
    const { service, prisma } = fixture();
    expect(await service.getMessengerChatId('rubika', 'u-guid')).toBe(
      'chat-guid',
    );
    prisma.user.findUnique.mockResolvedValue(null);
    expect(await service.getMessengerChatId('rubika', 'u-guid')).toBeNull();
    expect(await service.getMessengerChatId('telegram', '7')).toBe('7');
  });
  it('AI reanalysis cannot reset a resolved report to the intake queue', async () => {
    const { service, prisma, report, ai } = fixture();
    report.status = 'RESOLVED';
    ai.analyzeCitizenReport.mockResolvedValue({
      isComplete: false,
      category: 'ایمنی',
      priority: 'NORMAL',
      questions: ['کجا؟'],
      missingCriticalInfo: [],
      summary: 'متن',
      suggestedDepartments: [],
      riskFlags: [],
      needsHumanReview: true,
      confidence: 0.7,
      actionability: 'NEEDS_INFO',
    });
    await service.analyzeReportWithAi(code);
    expect(prisma.report.update.mock.calls[1][0].data.status).toBe('RESOLVED');
  });
  it('rate-limits new reports before spending AI or creating another record', async () => {
    const { service, prisma } = fixture();
    prisma.report.count.mockResolvedValue(10);
    await expect(
      service.createReport({
        platform: 'telegram',
        platformUserId: '7',
        text: 'گزارش روشنایی معبر عمومی',
      }),
    ).rejects.toThrow('Daily report limit');
    expect(prisma.report.create).not.toHaveBeenCalled();
  });

  it('retries a serializable transaction conflict instead of dropping a finalization', async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await service.finalizeReport(code);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.reportStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('AI completeness does not finalize a report before the citizen confirmation', async () => {
    const { service, prisma, ai } = fixture();
    ai.analyzeCitizenReport.mockResolvedValue({
      isComplete: true,
      category: 'روشنایی',
      priority: 'NORMAL',
      questions: [],
      summary: 'شرح',
      suggestedDepartments: [],
      riskFlags: [],
      confidence: 0.9,
      needsHumanReview: false,
      actionability: 'ACTIONABLE',
      missingCriticalInfo: [],
    });
    await service.analyzeReportWithAi(code);
    expect(prisma.report.update.mock.calls[1][0].data.status).toBe('NEW');
    expect(prisma.report.update.mock.calls[1][0].data.aiStatus).toBe('ready');
  });
});
