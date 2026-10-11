import { ConfigService } from '@nestjs/config';
import { BaleService } from './bale.service';

const code = 'KZ-1786378025672-6221';
function fixture(
  platform: 'bale' | 'telegram' | 'rubika' = 'bale',
  settings: Record<string, string> = {},
) {
  const report: any = {
    trackingCode: code,
    status: 'NEW',
    media: [],
    user: { platform, platformUserId: 'user-7' },
  };
  const reports: any = {
    createReport: jest.fn().mockResolvedValue(report),
    analyzeReportWithAi: jest.fn().mockResolvedValue({
      report,
      analysis: { isComplete: true, questions: [] },
    }),
    getReportForEditorial: jest.fn().mockResolvedValue(report),
    setEditorialMessageReference: jest.fn().mockResolvedValue({}),
    finalizeReport: jest
      .fn()
      .mockResolvedValue({ ...report, status: 'READY_FOR_REVIEW' }),
    getReportByTrackingCode: jest.fn().mockResolvedValue(report),
    getPublicDemands: jest.fn().mockResolvedValue([]),
    getPublicDemandForUser: jest.fn().mockResolvedValue({
      ...report,
      publicTitle: 'مشکل روشنایی محله',
      publicSummary: 'روشنایی معبر نیازمند بررسی است.',
    }),
    getMessengerChatId: jest.fn().mockResolvedValue('chat-7'),
    registerMessengerChat: jest.fn().mockResolvedValue({}),
    addReportMedia: jest.fn().mockResolvedValue({ id: 'media-1' }),
    getReportMediaCount: jest.fn().mockResolvedValue(1),
    togglePublicSupport: jest.fn(),
    submitAnswersAndReanalyze: jest
      .fn()
      .mockResolvedValue({ report, analysis: { isComplete: true } }),
  };
  const assistant: any = { chat: jest.fn() };
  const config = new ConfigService(settings);
  const bot: any = new BaleService(
    config,
    reports,
    {} as any,
    {} as any,
    {} as any,
    assistant,
    platform,
  );
  bot.sendMessage = jest.fn().mockResolvedValue({ message_id: 'out-1' });
  bot.sendChatAction = jest.fn();
  bot.answerCallbackQuery = jest.fn();
  const incoming = (text: string, id = 'in-1') => ({
    message_id: id,
    text,
    chat: { id: 'chat-7', type: 'private' },
    from: { id: 'user-7' },
  });
  return { bot, reports, report, incoming, assistant };
}

describe('Citizen reports across messengers', () => {
  it.each(['bale', 'telegram', 'rubika'] as const)(
    'creates, completes and tracks a report on %s',
    async (platform) => {
      const { bot, reports, incoming } = fixture(platform);
      await bot.handleUpdate({ message: incoming('/report') });
      expect(bot.sessions.get('chat-7').mode).toBe('awaiting_report');
      await bot.handleUpdate({
        message: incoming('چراغ‌های خیابان حافظ از دیشب خاموش است.', 'in-2'),
      });
      expect(reports.createReport).toHaveBeenCalledWith(
        expect.objectContaining({
          platform,
          platformUserId: 'user-7',
          sourceMessageKey: platform + ':chat-7:in-2',
        }),
      );
      expect(bot.sessions.get('chat-7').mode).toBe('awaiting_media');
      await bot.handleCallbackQuery({
        id: 'cb',
        from: { id: 'user-7' },
        message: incoming(''),
        data: 'usr:finishmedia:' + code,
      });
      expect(reports.finalizeReport).toHaveBeenCalledWith(code);
      expect(bot.sessions.has('chat-7')).toBe(false);
      await bot.handleUpdate({ message: incoming('/track') });
      await bot.handleUpdate({ message: incoming(code) });
      expect(reports.getReportByTrackingCode).toHaveBeenCalledWith(
        code,
        platform,
        'user-7',
      );
    },
  );

  it('AI failure still permits media and final submission', async () => {
    const { bot, reports, incoming } = fixture();
    reports.analyzeReportWithAi.mockRejectedValue(new Error('AI unavailable'));
    await bot.startReportFlow('chat-7');
    await bot.handleUpdate({
      message: incoming('روشنایی خیابان از دیشب قطع شده است.'),
    });
    expect(bot.sessions.get('chat-7').mode).toBe('awaiting_media');
    await bot.finishMediaCollection('chat-7', bot.sessions.get('chat-7'));
    expect(reports.finalizeReport).toHaveBeenCalledWith(code);
  });

  it('editorial delivery failure does not claim report creation failed', async () => {
    const { bot, reports, incoming } = fixture('telegram', {
      TELEGRAM_EDITORIAL_CHAT_ID: '-10077',
    });
    bot.sendMessage.mockImplementation(async (id: string) => {
      if (id === '-10077') throw new Error('Group unavailable');
      return { message_id: 'out-1' };
    });
    await bot.startReportFlow('chat-7');
    await bot.handleUpdate({
      message: incoming('چراغ‌های خیابان حافظ از دیشب خاموش است.'),
    });
    expect(reports.createReport).toHaveBeenCalledTimes(1);
    expect(bot.sessions.get('chat-7').mode).toBe('awaiting_media');
    expect(
      bot.sendMessage.mock.calls.some(([, text]: any) =>
        text.includes('پیام شما هنوز به‌عنوان گزارش ثبت نشده'),
      ),
    ).toBe(false);
  });

  it.each(['telegram', 'rubika'] as const)(
    'sends %s report notices to the Bale editorial bot',
    async (platform) => {
      const sourceFixture = fixture(platform);
      const source = sourceFixture.bot;
      const bale = fixture('bale').bot;
      source.sendEditorialMessage = jest.fn();
      bale.sendEditorialMessage = jest
        .fn()
        .mockResolvedValue({ message_id: 'editorial-1' });
      source.setPeers([source, bale]);

      await source.sendEditorialNewReport(sourceFixture.report);

      expect(bale.sendEditorialMessage).toHaveBeenCalledWith(
        expect.stringContaining('مبدأ: ' + platform),
      );
      expect(source.sendEditorialMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['telegram', 'rubika'] as const)(
    'sends the %s final report card to Bale and records its reference',
    async (platform) => {
      const sourceFixture = fixture(platform);
      const source = sourceFixture.bot;
      const baleFixture = fixture('bale', {
        BALE_EDITORIAL_CHAT_ID: 'bale-editorial-group',
      });
      const bale = baleFixture.bot;
      bale.sendEditorialMessage = jest.fn().mockResolvedValue({
        message_id: 'editorial-card-1',
        chat: { id: 'bale-editorial-group' },
      });
      source.setPeers([source, bale]);

      await source.sendEditorialReadyForReview(sourceFixture.report);

      expect(bale.sendEditorialMessage).toHaveBeenCalled();
      expect(sourceFixture.reports.setEditorialMessageReference).toHaveBeenCalledWith(
        code,
        'bale-editorial-group',
        'editorial-card-1',
        'bale',
      );
    },
  );

  it('failed finalization leaves the session available for retry', async () => {
    const { bot, reports, report } = fixture();
    reports.finalizeReport.mockRejectedValue(new Error('Database unavailable'));
    const session = {
      mode: 'awaiting_media',
      trackingCode: code,
      report,
      mediaCount: 0,
    };
    bot.sessions.set('chat-7', session);
    await bot.finishMediaCollection('chat-7', session);
    expect(bot.sessions.get('chat-7')).toBe(session);
    expect(bot.sendMessage.mock.calls[0][1]).toContain('ثبت نهایی انجام نشد');
  });

  it('old finish buttons cannot finalize a different active report', async () => {
    const { bot, reports, incoming, report } = fixture();
    bot.sessions.set('chat-7', {
      mode: 'awaiting_media',
      trackingCode: code,
      report,
      mediaCount: 0,
    });
    await bot.handleCallbackQuery({
      id: 'cb',
      from: { id: 'user-7' },
      message: incoming(''),
      data: 'usr:finishmedia:KZ-old',
    });
    expect(reports.finalizeReport).not.toHaveBeenCalled();
  });

  it('waiting for media never falls through to the general AI assistant', async () => {
    const { bot, incoming, report, assistant } = fixture();
    bot.sessions.set('chat-7', {
      mode: 'awaiting_media',
      trackingCode: code,
      report,
      mediaCount: 0,
    });
    await bot.handleUpdate({ message: incoming('چطور عکس ارسال کنم؟') });
    expect(assistant.chat).not.toHaveBeenCalled();
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    'usr:ads',
    'usr:adpkgs',
    'usr:kzs',
    'usr:news',
    'usr:ncat:test',
    'usr:nsub:test',
  ])('blocks disabled legacy button %s', async (data) => {
    const { bot, incoming } = fixture();
    await bot.handleCallbackQuery({
      id: 'cb',
      from: { id: 'user-7' },
      message: incoming(''),
      data,
    });
    expect(bot.sendMessage.mock.calls[0][1]).toContain('غیرفعال');
  });

  it('welcome and main menu contain only the current citizen services', async () => {
    const { bot } = fixture();
    await bot.sendMainMenu('chat-7');
    const [, text, keyboard] = bot.sendMessage.mock.calls[0];
    expect(text).not.toMatch(/تبلیغات|اطلاعات شهری|کازرون‌یار/);
    expect(JSON.stringify(keyboard)).not.toMatch(/usr:(ads|news|kz|ai)/);
  });

  it('paginates past the original eight demands with a stable next page', async () => {
    const { bot, reports } = fixture('rubika');
    reports.getPublicDemands.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        trackingCode: code + i,
        publicTitle: 'مطالبه ' + i,
      })),
    );
    await bot.sendPublicDemands('chat-7', 'user-7', 'active', 2);
    expect(reports.getPublicDemands).toHaveBeenCalledWith(
      'rubika',
      'user-7',
      7,
      12,
      'active',
    );
    const markup = bot.sendMessage.mock.calls[0][2];
    expect(JSON.stringify(markup)).toContain('usr:dl:active:3');
    expect(JSON.stringify(markup)).not.toContain(code + '6');
  });

  it('compact demand cards keep experiences on their separate page', async () => {
    const { bot } = fixture();
    const demand = {
      trackingCode: code,
      publicTitle: 'روشنایی خیابان',
      publicSummary: 'توضیح',
      publicExperiences: [
        {
          id: 'exp',
          text: 'این تجربه طولانی باید در صفحه جدا باشد',
          likeCount: 1,
        },
      ],
    };
    expect(bot.buildPublicDemandCard(demand)).not.toContain('این تجربه طولانی');
    expect(JSON.stringify(bot.getPublicDemandCardKeyboard(demand))).toContain(
      'usr:dx:',
    );
    await bot.sendDemandExperiences('chat-7', demand);
    expect(bot.sendMessage.mock.calls[0][1]).toContain('این تجربه طولانی');
  });

  it('duplicate webhook messages are processed once', async () => {
    const { bot, incoming } = fixture('rubika');
    const update = { message: incoming('/report') };
    await bot.processIncoming(update);
    await bot.processIncoming(update);
    expect(bot.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reporter notification uses the correct platform and actual chat ID', async () => {
    const bale = fixture();
    const rubika = fixture('rubika');
    bale.bot.setPeers([bale.bot, rubika.bot]);
    rubika.bot.setPeers([bale.bot, rubika.bot]);
    await bale.bot.notifyCitizenOfStatus(
      {
        ...rubika.report,
        user: { platform: 'rubika', platformUserId: 'u-guid' },
      },
      'RESOLVED',
      'رفع شد',
    );
    expect(rubika.reports.getMessengerChatId).toHaveBeenCalledWith(
      'rubika',
      'u-guid',
    );
    expect(rubika.bot.sendMessage.mock.calls[0][0]).toBe('chat-7');
    expect(bale.bot.sendMessage).not.toHaveBeenCalled();
  });

  it('editorial actions require configured operator IDs', () => {
    const { bot } = fixture('telegram', {
      TELEGRAM_EDITORIAL_ADMIN_IDS: '42, 43',
    });
    expect(bot.isEditorialOperatorAllowed({ id: 42 })).toBe(true);
    expect(bot.isEditorialOperatorAllowed({ id: 99 })).toBe(false);
    expect(fixture().bot.isEditorialOperatorAllowed({ id: 42 })).toBe(false);
  });

  it('saves true media count and does not increment on replay', async () => {
    const { bot, reports, report, incoming } = fixture('rubika');
    const message = { ...incoming(''), document: { file_id: 'file-guid' } };
    const session = {
      mode: 'awaiting_media',
      trackingCode: code,
      report,
      mediaCount: 0,
    };
    await bot.handleOptionalMedia(message, session);
    await bot.handleOptionalMedia(message, session);
    expect(session.mediaCount).toBe(1);
    expect(reports.addReportMedia).toHaveBeenCalledWith(
      code,
      expect.objectContaining({
        platform: 'rubika',
        sourceChatId: 'chat-7',
        sourceMessageId: 'in-1',
      }),
    );
  });
  it('pending updates are handled before advancing the polling offset', async () => {
    const { bot, incoming } = fixture('telegram');
    bot.running = true;
    bot.transport.request = jest
      .fn()
      .mockResolvedValue([{ update_id: 17, message: incoming('/report') }]);
    bot.handleUpdate = jest.fn().mockImplementation(async () => {
      bot.running = false;
    });
    await bot.pollLoop();
    expect(bot.handleUpdate).toHaveBeenCalledTimes(1);
    expect(bot.offset).toBe(18);
    expect(bot.transport.request.mock.calls[0][1]).not.toHaveProperty('offset');
  });

  it('a report can be resumed from its private status card after returning home', async () => {
    const { bot, reports, incoming, report } = fixture('telegram');
    await bot.handleCallbackQuery({
      id: 'cb',
      from: { id: 'user-7' },
      message: incoming(''),
      data: 'usr:resume:' + code,
    });
    expect(reports.getReportByTrackingCode).toHaveBeenCalledWith(
      code,
      'telegram',
      'user-7',
    );
    expect(bot.sessions.get('chat-7').mode).toBe('awaiting_media');
    report.submissionCompletedAt = new Date();
    bot.sessions.clear();
    await bot.handleCallbackQuery({
      id: 'cb2',
      from: { id: 'user-7' },
      message: incoming(''),
      data: 'usr:resume:' + code,
    });
    expect(bot.sessions.has('chat-7')).toBe(false);
  });

  it('old question buttons cannot answer a newer question', async () => {
    const { bot, reports, incoming } = fixture();
    bot.sessions.set('chat-7', {
      mode: 'awaiting_ai_answers',
      trackingCode: code,
      questions: ['کجا؟', 'از کی؟'],
      answers: [],
      questionIndex: 1,
      mediaCount: 0,
    });
    await bot.handleCallbackQuery({
      id: 'cb',
      from: { id: 'user-7' },
      message: incoming(''),
      data: 'usr:dontknow:' + code + ':0',
    });
    expect(bot.sessions.get('chat-7').questionIndex).toBe(1);
    expect(reports.submitAnswersAndReanalyze).not.toHaveBeenCalled();
  });
});
