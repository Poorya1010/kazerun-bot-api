import {
  Injectable,
  Inject,
  Optional,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from '../reports/reports.service';
import { KazerunYarService } from '../kazerun-yar/kazerun-yar.service';
import { NewsService } from '../news/news.service';
import { AdsService, AdPlacement } from '../ads/ads.service';
import { AssistantService } from '../ai/assistant.service';

import { BotTransport } from '../messaging/bot-transport';
import type { BotPlatform } from '../messaging/bot-transport';
import { BotState } from '../messaging/bot-state';

type ChatId = string | number;

interface BaleUser {
  id: ChatId;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface BaleChat {
  id: ChatId;
  type: string;
  title?: string;
}

interface BalePhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
}

interface BaleMediaFile {
  file_id: string;
  file_unique_id?: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

interface BaleMessage {
  message_id: ChatId;
  text?: string;
  caption?: string;
  photo?: BalePhotoSize[];
  video?: BaleMediaFile;
  document?: BaleMediaFile;
  animation?: BaleMediaFile;
  audio?: BaleMediaFile;
  voice?: BaleMediaFile;
  chat: BaleChat;
  from?: BaleUser;
}

interface BaleCallbackQuery {
  id: string;
  from: BaleUser;
  message?: BaleMessage;
  data?: string;
}

interface BaleUpdate {
  update_id: number;
  message?: BaleMessage;
  callback_query?: BaleCallbackQuery;
}

interface AwaitingReportSession {
  mode: 'awaiting_report';
}

interface AwaitingTrackSession {
  mode: 'awaiting_track';
}

interface AnswerItem {
  question: string;
  answer: string;
}

interface AwaitingAiAnswersSession {
  mode: 'awaiting_ai_answers';
  trackingCode: string;
  questions: string[];
  answers: AnswerItem[];
  questionIndex: number;
  mediaCount: number;
}

interface AwaitingMediaSession {
  mode: 'awaiting_media';
  trackingCode: string;
  report: any;
  mediaCount: number;
}

interface AwaitingPublicExperienceSession {
  mode: 'awaiting_public_experience';
  trackingCode: string;
}

interface AwaitingPublicEvidenceSession {
  mode: 'awaiting_public_evidence';
  trackingCode: string;
}

interface AwaitingKazerunYarSearchSession {
  mode: 'awaiting_kazerunyar_search';
}

interface AwaitingKazerunYarFeedbackSession {
  mode: 'awaiting_kazerunyar_feedback';
  cityServiceId?: string;
  feedbackType: 'CORRECTION' | 'MISSING';
}

interface KazerunYarEditorialSession {
  action: 'add_service' | 'edit_service';
  cityServiceId?: string;
}

interface NewsEditorialSession {
  action: 'add_news' | 'add_urgent' | 'edit_news';
  newsId?: string;
}

interface AwaitingAdContentSession {
  mode: 'awaiting_ad_content';
  orderId: string;
  step:
    | 'businessName'
    | 'subject'
    | 'rawAdText'
    | 'phone'
    | 'address'
    | 'links'
    | 'cta'
    | 'preferredSchedule'
    | 'media';
  mediaCount: number;
}

interface AwaitingAdAiFollowupSession {
  mode: 'awaiting_ad_ai_followup';
  orderId: string;
  questions: string[];
}

interface AwaitingAdRevisionSession {
  mode: 'awaiting_ad_revision';
  orderId: string;
}

interface AdEditorialSession {
  action:
    | 'add_package'
    | 'edit_package'
    | 'revision_request'
    | 'reject_order'
    | 'publication_link'
    | 'set_final_text';
  packageId?: string;
  orderId?: string;
  channel?: string;
}

type EditorialInputAction =
  'note' | 'refer' | 'resolve' | 'reject' | 'response' | 'publicize';

interface EditorialInputSession {
  trackingCode: string;
  action: EditorialInputAction;
  sourceChatId: ChatId;
  sourceMessageId: ChatId;
}

type ReportSession =
  | AwaitingReportSession
  | AwaitingTrackSession
  | AwaitingAiAnswersSession
  | AwaitingMediaSession
  | AwaitingPublicExperienceSession
  | AwaitingPublicEvidenceSession
  | AwaitingKazerunYarSearchSession
  | AwaitingKazerunYarFeedbackSession
  | AwaitingAdContentSession
  | AwaitingAdAiFollowupSession
  | AwaitingAdRevisionSession;

@Injectable()
export class BaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BaleService.name);
  private readonly sessions = new Map<ChatId, ReportSession>();
  private readonly editorialSessions = new Map<string, EditorialInputSession>();
  private readonly kazerunYarEditorialSessions = new Map<
    string,
    KazerunYarEditorialSession
  >();
  private readonly newsEditorialSessions = new Map<
    string,
    NewsEditorialSession
  >();
  private readonly adEditorialSessions = new Map<string, AdEditorialSession>();

  private running = false;
  private followUpReminderTimer: ReturnType<typeof setInterval> | null = null;
  private offset: number | undefined;
  private completedMessages: string[] = [];
  private reminderStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private transport!: BotTransport;
  private state?: BotState;
  private rubikaOffset?: string;
  private peers: BaleService[] = [];
  private webhookQueue: Promise<void> = Promise.resolve();

  private readonly buttonReport = '📍 ارسال گزارش مردمی';
  private readonly buttonTrack = '🔎 پیگیری گزارش';
  private readonly buttonNews = '📰 خبر و اعلان';
  private readonly buttonAds = '📣 سفارش تبلیغات';
  private readonly buttonAi = '🤖 امکانات هوشمند';
  private readonly buttonMyReports = '📂 گزارش‌های من';
  private readonly buttonGuide = 'ℹ️ راهنمای ارسال گزارش';
  private readonly buttonHome = '🏠 منوی اصلی';
  private readonly buttonKazerunYar = '🧭 کازرون‌یار';
  private readonly buttonFinishMedia = '✅ ثبت نهایی گزارش';

  constructor(
    private readonly configService: ConfigService,
    private readonly reportsService: ReportsService,
    private readonly kazerunYarService: KazerunYarService,
    private readonly newsService: NewsService,
    private readonly adsService: AdsService,
    private readonly assistantService: AssistantService,
    @Optional() @Inject('BOT_PLATFORM') readonly platform: BotPlatform = 'bale',
  ) {
    this.transport = new BotTransport(
      platform,
      !!configService.get<string>('RUBIKA_WEBHOOK_URL'),
    );
  }

  setPeers(peers: BaleService[]): void {
    this.peers = peers;
  }

  private saveState(): void {
    this.state?.write({
      offset: this.offset,
      rubikaOffset: this.rubikaOffset,
      completedMessages: this.completedMessages,
      editorialSessions: [...this.editorialSessions],
      sessions: [...this.sessions].map(([id, session]) => [
        id,
        session.mode === 'awaiting_media'
          ? { ...session, report: { trackingCode: session.trackingCode } }
          : session,
      ]),
    });
  }

  async receiveRubikaWebhook(body: any): Promise<void> {
    if (!this.running || this.platform !== 'rubika')
      throw new Error('Rubika is not running');
    const update = await this.transport.normalizeRubika(
      body,
      this.getEditorialChatId(),
    );
    if (!update) return;
    const task = this.webhookQueue.then(async () => {
      await this.processIncoming(update);
      this.saveState();
    });
    this.webhookQueue = task.catch(() => undefined);
    await task;
  }

  onModuleInit(): void {
    const token = this.configService.get<string>(
      this.platform.toUpperCase() + '_BOT_TOKEN',
    );

    if (!token || !token.trim()) {
      this.logger.warn(
        this.platform.toUpperCase() + '_BOT_TOKEN is not configured',
      );
      return;
    }

    if (
      this.platform === 'rubika' &&
      this.configService.get<string>('RUBIKA_WEBHOOK_URL')
    ) {
      const url = this.configService.get<string>('RUBIKA_WEBHOOK_URL') ?? '';
      const secret =
        this.configService.get<string>('RUBIKA_WEBHOOK_SECRET') ?? '';
      if (!url.startsWith('https://') || !/^[A-Za-z0-9_-]{32,}$/.test(secret))
        throw new Error(
          'Rubika webhooks require an HTTPS URL and a random secret of at least 32 characters',
        );
    }

    this.transport.configure(token);
    this.state = new BotState(
      this.configService.get<string>('BOT_STATE_DIR') || './var/bot-state',
      this.platform,
    );
    const saved = this.state.read();
    this.offset = saved.offset;
    this.completedMessages = saved.completedMessages ?? [];
    for (const [key, session] of saved.editorialSessions ?? [])
      this.editorialSessions.set(key, session);
    this.rubikaOffset = saved.rubikaOffset;
    for (const [id, session] of saved.sessions ?? [])
      this.sessions.set(String(id), session);
    this.running = true;

    this.logger.log('REPORT QA FLOW ACTIVE');

    if (this.getEditorialChatId() !== null) {
      this.logger.log(
        this.platform.toUpperCase() + '_EDITORIAL_CHAT_ID is configured',
      );
    } else {
      this.logger.warn(
        this.platform.toUpperCase() + '_EDITORIAL_CHAT_ID is not configured',
      );
    }

    if (
      this.platform !== 'rubika' ||
      !this.configService.get<string>('RUBIKA_WEBHOOK_URL')
    )
      void this.startPolling();
    this.startFollowUpReminderLoop();
  }

  onModuleDestroy(): void {
    this.running = false;
    if (this.reminderStartupTimer) clearTimeout(this.reminderStartupTimer);
    this.saveState();

    if (this.followUpReminderTimer) {
      clearInterval(this.followUpReminderTimer);
      this.followUpReminderTimer = null;
    }
  }

  private async startPolling(): Promise<void> {
    // Pending reports must not be discarded at startup.
    this.logger.log(this.platform + ' long polling started');
    await this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const result =
          this.platform === 'rubika'
            ? await this.transport.request('getUpdates', {
                limit: 100,
                ...(this.rubikaOffset ? { offset_id: this.rubikaOffset } : {}),
              })
            : await this.transport.request('getUpdates', {
                limit: 100,
                timeout: 20,
                ...(this.offset === undefined ? {} : { offset: this.offset }),
              });
        const updates =
          this.platform === 'rubika' ? (result.updates ?? []) : result;
        for (const raw of Array.isArray(updates) ? updates : []) {
          const update =
            this.platform === 'rubika'
              ? await this.transport.normalizeRubika(
                  raw,
                  this.getEditorialChatId(),
                )
              : raw;
          if (update) await this.processIncoming(update);
          if (this.platform !== 'rubika')
            this.offset = Number(raw.update_id) + 1;
          this.saveState();
        }
        if (this.platform === 'rubika') {
          this.rubikaOffset = result.next_offset_id ?? this.rubikaOffset;
          this.saveState();
          await this.delay(3000);
        }
      } catch (error: any) {
        if (!this.running) return;
        this.logger.error(
          `${this.platform} polling failed: ${error?.message ?? 'Unknown error'}`,
        );
        await this.delay(3000);
      }
    }
  }

  private async processIncoming(update: BaleUpdate): Promise<void> {
    const message = update.message;
    const key = message?.message_id
      ? String(message.chat.id) + ':' + String(message.message_id)
      : null;
    if (key && this.completedMessages.includes(key)) return;
    const inbound = update.message ?? update.callback_query?.message;
    const user = update.message?.from ?? update.callback_query?.from;
    if (
      inbound?.chat.type === 'private' &&
      user &&
      !this.isEditorialChat(inbound.chat.id)
    ) {
      await this.reportsService.registerMessengerChat(
        this.platform,
        String(user.id),
        String(inbound.chat.id),
        this.getDisplayName({ ...inbound, from: user }),
        user.username,
      );
    }
    await this.handleUpdate(update);
    if (key)
      this.completedMessages = [...this.completedMessages, key].slice(-2000);
    this.saveState();
  }

  private async handleUpdate(update: BaleUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;

    if (!message) {
      return;
    }

    if (this.isEditorialChat(message.chat.id)) {
      await this.handleEditorialTextInput(message);
      return;
    }
    if (message.chat.type !== 'private') return;

    const text = String(message.text ?? message.caption ?? '').trim();

    const hasMedia = this.hasSupportedMedia(message);

    if (text === '/cancel') {
      this.sessions.delete(String(message.chat.id));
      await this.sendMainMenu(String(message.chat.id));
      return;
    }
    if (
      [
        '/ads',
        '/news',
        '/kazerunyar',
        this.buttonAds,
        this.buttonNews,
        this.buttonKazerunYar,
      ].includes(text)
    ) {
      await this.sendMessage(
        String(message.chat.id),
        'این بخش فعلاً غیرفعال است. خدمات فعلی: ثبت و پیگیری گزارش و مطالبات مردمی.',
        this.getMainInlineKeyboard(),
      );
      return;
    }
    if (text === '/demands') {
      this.sessions.delete(String(message.chat.id));
      await this.sendPublicDemands(
        String(message.chat.id),
        this.getPlatformUserId(message),
      );
      return;
    }

    if (!text && !hasMedia) {
      return;
    }

    const chatId = String(message.chat.id);

    this.logger.log(this.platform + ' incoming private message');

    if (text === '/start' || text.startsWith('/start ')) {
      this.sessions.delete(chatId);
      await this.removeLegacyReplyKeyboard(chatId);
      await this.sendMainMenu(chatId);
      return;
    }

    if (text === this.buttonHome) {
      this.sessions.delete(chatId);
      await this.sendMainMenu(chatId);
      return;
    }

    if (text === this.buttonKazerunYar || text === '/kazerunyar') {
      this.sessions.delete(chatId);
      await this.sendKazerunYarMenu(chatId);
      return;
    }

    if (text === this.buttonReport || text === '/report') {
      await this.startReportFlow(chatId);
      return;
    }

    if (text === this.buttonTrack || text === '/track') {
      await this.startTrackingFlow(chatId);
      return;
    }

    if (text === this.buttonMyReports || text === '/myreports') {
      this.sessions.delete(chatId);
      await this.sendMyReports(chatId, this.getPlatformUserId(message));
      return;
    }

    if (text === this.buttonGuide || text === '/help') {
      this.sessions.delete(chatId);
      await this.sendReportGuide(chatId);
      return;
    }

    if (text === this.buttonNews || text === '/news') {
      this.sessions.delete(chatId);
      await this.sendNewsMenu(chatId);
      return;
    }

    if (text === this.buttonAds || text === '/ads') {
      this.sessions.delete(chatId);
      await this.sendAdsMenu(chatId, this.getPlatformUserId(message));
      return;
    }

    if (text === this.buttonAi) {
      await this.sendReportGuide(chatId);
      return;
    }

    const session = this.sessions.get(chatId);

    if (!session) {
      if (text && !hasMedia) {
        await this.sendMessage(
          chatId,
          'برای ثبت موضوع جدید «ثبت گزارش مردمی» را انتخاب کنید؛ برای مشاهده پرونده‌های عمومی وارد «مطالبات مردمی» شوید.',
          this.getMainInlineKeyboard(),
        );
        return;
      }

      if (hasMedia) {
        await this.sendMessage(
          chatId,
          [
            '📎 مستند شما دریافت شد، اما پرونده گزارش فعالی برای پیوست‌کردن آن وجود ندارد.',
            '',
            'برای ثبت درست عکس، ویدئو یا فایل، ابتدا از منوی اصلی «📍 ارسال گزارش مردمی» را انتخاب کنید و شرح گزارش را بفرستید.',
          ].join('\n'),
          this.getHomeKeyboard(),
        );
      }

      return;
    }

    if (session.mode === 'awaiting_kazerunyar_search') {
      if (!text) {
        await this.sendMessage(
          chatId,
          '🔎 نام خدمت، اداره، مکان یا موضوع موردنظر را به‌صورت متنی بنویسید.',
          this.getKazerunYarBackKeyboard(),
        );
        return;
      }

      this.sessions.delete(chatId);
      await this.sendKazerunYarSearchResults(chatId, text);
      return;
    }

    if (session.mode === 'awaiting_kazerunyar_feedback') {
      if (!text || text.length < 5) {
        await this.sendMessage(
          chatId,
          '✍️ لطفاً توضیح کوتاه و روشن‌تری بنویسید.',
          this.getKazerunYarBackKeyboard(),
        );
        return;
      }

      try {
        const feedback = await this.kazerunYarService.createFeedback({
          cityServiceId: session.cityServiceId ?? null,
          platform: this.platform,
          platformUserId: this.getPlatformUserId(message),
          feedbackType: session.feedbackType,
          text,
        });

        this.sessions.delete(chatId);
        await this.sendMessage(
          chatId,
          [
            '✅ پیشنهاد شما برای کازرون‌یار ثبت شد.',
            '',
            'اطلاعات قبل از انتشار یا اصلاح توسط تحریریه بررسی می‌شود.',
            'ممنون که به دقیق‌تر شدن بانک اطلاعات شهری کمک می‌کنید. 🌱',
          ].join('\n'),
          this.getKazerunYarMenuKeyboard(),
        );

        await this.notifyEditorialOfKazerunYarFeedback(feedback);
      } catch (error: any) {
        this.logger.warn(
          'KazerunYar feedback failed: ' + (error?.message ?? 'Unknown error'),
        );
        await this.sendMessage(
          chatId,
          'ثبت پیشنهاد با خطا روبه‌رو شد. لطفاً کمی بعد دوباره تلاش کنید.',
          this.getKazerunYarMenuKeyboard(),
        );
      }
      return;
    }

    if (session.mode === 'awaiting_ad_content') {
      await this.handleAdContentInput(message, session, text, hasMedia);
      return;
    }

    if (session.mode === 'awaiting_ad_ai_followup') {
      if (!text || text.length < 2) {
        await this.sendMessage(
          chatId,
          '✍️ لطفاً پاسخ اطلاعات تکمیلی تبلیغ را در یک پیام متنی ارسال کنید.',
          this.getAdsHomeKeyboard(),
        );
        return;
      }

      try {
        await this.adsService.updateOrderContent(
          session.orderId,
          this.platform,
          this.getPlatformUserId(message),
          { extraInfo: text },
        );
        this.sessions.delete(chatId);
        await this.finalizeAdOrder(chatId, session.orderId, true);
      } catch (error: any) {
        this.logger.warn(
          'Ad AI followup failed: ' + (error?.message ?? 'Unknown error'),
        );
        await this.sendMessage(
          chatId,
          'ثبت اطلاعات تکمیلی با خطا روبه‌رو شد. دوباره تلاش کنید.',
        );
      }
      return;
    }

    if (session.mode === 'awaiting_ad_revision') {
      if (!text || text.length < 2) {
        await this.sendMessage(
          chatId,
          '✍️ اصلاحات یا توضیحات جدید را در یک پیام متنی ارسال کنید.',
        );
        return;
      }

      try {
        const order = await this.adsService.addCustomerFollowup(
          session.orderId,
          this.platform,
          this.getPlatformUserId(message),
          text,
        );
        this.sessions.delete(chatId);
        await this.sendMessage(
          chatId,
          [
            '✅ اصلاحات شما ثبت شد و دوباره برای تحریریه ارسال می‌شود.',
            '',
            '🧾 کد سفارش: ' + String(order.orderCode),
          ].join('\n'),
          this.getAdsHomeKeyboard(),
        );
        await this.sendAdEditorialCard(String(order.id), true);
      } catch (error: any) {
        this.logger.warn(
          'Ad revision failed: ' + (error?.message ?? 'Unknown error'),
        );
        await this.sendMessage(chatId, 'ثبت اصلاحات با خطا روبه‌رو شد.');
      }
      return;
    }

    if (session.mode === 'awaiting_track') {
      if (!text) {
        await this.sendMessage(
          chatId,
          [
            '🔎 برای پیگیری، کد رهگیری گزارش را به‌صورت متنی ارسال کنید.',
            '',
            'نمونه: KZ-1786378025672-6221',
          ].join('\n'),
          this.getTrackingInlineKeyboard(),
        );
        return;
      }

      await this.handleTrackingLookup(message, text);
      return;
    }

    if (session.mode === 'awaiting_report') {
      if (!text) {
        await this.sendMessage(
          chatId,
          [
            '📎 مستند دریافت شد.',
            '',
            'برای تشکیل پرونده، ابتدا لازم است موضوع گزارش را در یک پیام متنی کوتاه توضیح دهید.',
            'بعد از ثبت متن، همین ربات از شما می‌خواهد عکس، ویدئو یا سایر مستندات مرتبط را ارسال کنید.',
          ].join('\n'),
          this.getHomeKeyboard(),
        );
        return;
      }

      await this.handleNewReport(message, text);
      return;
    }

    if (session.mode === 'awaiting_ai_answers') {
      if (hasMedia) {
        await this.handleAiMediaAnswer(message, session);
        return;
      }

      if (text) {
        await this.handleAiAnswer(message, text, session);
      }
      return;
    }

    if (session.mode === 'awaiting_public_experience') {
      if (hasMedia || !text) {
        await this.sendMessage(
          chatId,
          '💬 برای ثبت تجربه، لطفاً فقط یک پیام متنی کوتاه و روشن ارسال کنید.',
        );
        return;
      }

      await this.handlePublicExperienceInput(message, text, session);
      return;
    }

    if (session.mode === 'awaiting_public_evidence') {
      if (!hasMedia) {
        await this.sendMessage(
          chatId,
          '📎 برای این بخش لازم است عکس، ویدئو، اسکرین‌شات یا فایل مرتبط ارسال کنید.',
        );
        return;
      }

      await this.handlePublicEvidenceInput(message, session);
      return;
    }

    if (session.mode === 'awaiting_media') {
      const normalizedMediaReply = text.replace(/[.!؟?]/g, '').trim();

      const noMediaReplies = new Set([
        this.buttonFinishMedia,
        'ندارم',
        'خیر',
        'نه',
        'مستندی ندارم',
        'مدرکی ندارم',
        'چیزی ندارم',
      ]);

      if (noMediaReplies.has(normalizedMediaReply)) {
        await this.finishMediaCollection(chatId, session);
        return;
      }

      if (hasMedia) {
        await this.handleOptionalMedia(message, session);
        return;
      }

      await this.sendMessage(
        chatId,
        [
          '📎 مرحله مستندات گزارش هنوز باز است.',
          '',
          'اگر عکس، ویدئو، اسکرین‌شات، فایل، نامه یا سند مرتبط دارید همین‌جا ارسال کنید.',
          'اگر مستندی ندارید یا ارسال‌تان تمام شده، از دکمه ثبت نهایی استفاده کنید.',
        ].join('\n'),
        this.getMediaInlineKeyboard(session.mediaCount, session.trackingCode),
      );
      return;
    }
    if (text && !hasMedia) {
      try {
        const reply = await this.assistantService.chat(text);

        await this.sendMessage(chatId, reply, this.getHomeKeyboard());
      } catch (error: any) {
        this.logger.error(
          'Assistant failed: ' + (error?.message ?? 'Unknown error'),
        );
      }

      return;
    }
  }
  private async handleNewReport(
    message: BaleMessage,
    text: string,
  ): Promise<void> {
    const chatId = String(message.chat.id);

    if (text.length > 12000) {
      await this.sendMessage(
        chatId,
        'لطفاً شرح گزارش را در حداکثر ۱۲۰۰۰ نویسه خلاصه کنید.',
      );
      return;
    }

    if (text.length < 10) {
      await this.sendMessage(
        chatId,
        [
          '✍️ برای اینکه گزارش قابل پیگیری باشد، توضیح کمی بیشتری لازم است.',
          '',
          'لطفاً در یک پیام کوتاه بفرمایید چه مشکلی رخ داده و در چه محدوده‌ای است.',
          'لازم نیست متن طولانی یا رسمی بنویسید.',
        ].join('\n'),
        this.getHomeKeyboard(),
      );
      return;
    }

    this.sessions.delete(chatId);

    const platformUserId = this.getPlatformUserId(message);
    const displayName = this.getDisplayName(message);

    let report: any;

    try {
      this.logger.log('Creating ' + this.platform + ' report');

      report = await this.reportsService.createReport({
        platform: this.platform,
        platformUserId,
        displayName,
        username: message.from?.username ?? null,
        text,
        sourceMessageKey:
          this.platform + ':' + message.chat.id + ':' + message.message_id,
      });

      this.logger.log('Report created: ' + report.trackingCode);
    } catch (error: any) {
      this.logger.error(
        'Report creation failed: ' + (error?.message ?? 'Unknown error'),
      );
      if (String(error?.message).includes('Daily report limit')) {
        this.sessions.set(chatId, { mode: 'awaiting_report' });
        await this.sendMessage(
          chatId,
          'سقف ثبت گزارش برای این حساب در ۲۴ ساعت اخیر پر شده است (۱۰ گزارش). پرونده‌های قبلی را می‌توانید پیگیری کنید.',
          this.getMainInlineKeyboard(),
        );
        return;
      }

      this.sessions.set(chatId, {
        mode: 'awaiting_report',
      });

      await this.sendMessage(
        chatId,
        [
          '⚠️ در ثبت گزارش اختلال موقتی پیش آمد.',
          '',
          'پیام شما هنوز به‌عنوان گزارش ثبت نشده است. لطفاً چند لحظه بعد دوباره ارسال کنید.',
          '',
          'اگر مشکل ادامه داشت، از منوی اصلی دوباره «📍 ارسال گزارش مردمی» را انتخاب کنید.',
        ].join('\n'),
        this.getHomeKeyboard(),
      );
      return;
    }

    this.sessions.set(chatId, {
      mode: 'awaiting_media',
      trackingCode: String(report.trackingCode),
      report,
      mediaCount: 0,
    });
    this.saveState();
    await this.sendEditorialNewReport(report);

    let initialMediaCount = 0;

    if (this.hasSupportedMedia(message)) {
      try {
        initialMediaCount = await this.persistAndCopyMedia(
          message,
          String(report.trackingCode),
        );
      } catch (error: any) {
        this.logger.error(
          'Initial media handling failed: ' +
            (error?.message ?? 'Unknown error'),
        );
      }
    }

    await this.sendMessage(
      chatId,
      [
        '✅ پرونده گزارش شما تشکیل شد',
        '',
        '🆔 کد رهگیری: ' + String(report.trackingCode),
        '🧭 مرحله ۱ از ۳: دریافت شرح گزارش — انجام شد',
        '',
        initialMediaCount > 0
          ? '📎 مستند همراه پیام نیز به پرونده پیوست شد.'
          : '📝 شرح گزارش با موفقیت ثبت شد.',
        '',
        '🤖 مرحله ۲ از ۳: بررسی هوشمند اطلاعات',
        'سامانه اکنون گزارش را بررسی می‌کند و فقط اگر اطلاعات ضروری برای پیگیری کم باشد، سؤال کوتاه تکمیلی مطرح می‌کند.',
      ].join('\n'),
      this.getReportProgressInlineKeyboard(),
    );

    await this.sendChatAction(chatId, 'typing');

    try {
      this.logger.log('Starting AI analysis for ' + report.trackingCode);

      const result = await this.reportsService.analyzeReportWithAi(
        report.trackingCode,
      );

      const analysis = result?.analysis;

      this.logger.log('AI analysis completed for ' + report.trackingCode);

      if (!analysis) {
        throw new Error('AI returned empty analysis');
      }

      if (String(analysis.priority ?? '').toUpperCase() === 'URGENT') {
        await this.sendMessage(
          chatId,
          [
            '🚨 این گزارش نشانه‌های یک وضعیت فوری دارد.',
            '',
            'اگر هم‌اکنون خطر جانی، حادثه فعال یا تهدید فوری برای سلامت و ایمنی وجود دارد، همزمان از مسیرهای امدادی و دستگاه مسئول نیز اقدام کنید.',
            '',
            'ارسال گزارش به «کازرون خبر» جایگزین اقدام اضطراری نیست.',
          ].join('\n'),
        );
      }

      if (analysis.isComplete === true) {
        await this.beginMediaCollection(
          chatId,
          result.report,
          initialMediaCount,
        );
        return;
      }

      const questions = this.normalizeQuestions(analysis.questions);

      if (questions.length === 0) {
        await this.beginMediaCollection(
          chatId,
          result.report,
          initialMediaCount,
        );
        return;
      }

      const newSession: AwaitingAiAnswersSession = {
        mode: 'awaiting_ai_answers',
        trackingCode: report.trackingCode,
        questions,
        answers: [],
        questionIndex: 0,
        mediaCount: initialMediaCount,
      };

      this.sessions.set(chatId, newSession);
      this.saveState();

      this.logger.log(
        'AI Q&A session started for ' +
          report.trackingCode +
          ' with ' +
          questions.length +
          ' questions',
      );

      await this.sendAiQuestion(chatId, newSession);
    } catch (error: any) {
      this.logger.error(
        'AI analysis failed for ' +
          report.trackingCode +
          ': ' +
          (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        chatId,
        [
          '✅ اصل گزارش شما محفوظ و ثبت شده است.',
          '',
          '⚠️ بررسی هوشمند در این لحظه با اختلال موقتی روبه‌رو شد؛ پرونده از بین نرفته و روند ثبت ادامه دارد.',
          '',
          'اکنون مستندات احتمالی گزارش را دریافت می‌کنیم.',
          '',
          '🆔 کد رهگیری: ' + String(report.trackingCode),
        ].join('\n'),
      );

      await this.beginMediaCollection(chatId, report, initialMediaCount);
    }
  }

  private async handleAiMediaAnswer(
    message: BaleMessage,
    session: AwaitingAiAnswersSession,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const mediaLabel = this.getMediaLabel(message);

    session.mediaCount = await this.persistAndCopyMedia(
      message,
      session.trackingCode,
    );
    this.sessions.set(chatId, session);
    this.saveState();

    await this.sendMessage(
      chatId,
      [
        '✅ ' + mediaLabel + ' شما به پرونده گزارش پیوست شد.',
        '',
        '📎 مستند با موفقیت ذخیره شد و برای تحریریه نیز ارسال می‌شود.',
        'این فایل به‌عنوان پاسخ پرسش متنی حساب نمی‌شود؛ لطفاً پاسخ پرسش فعلی را جداگانه ارسال کنید.',
        '',
        '🆔 کد رهگیری: ' + session.trackingCode,
      ].join('\n'),
      this.getAiQuestionInlineKeyboard(
        session.trackingCode,
        session.questionIndex,
      ),
    );
  }

  private async beginMediaCollection(
    chatId: ChatId,
    report: any,
    initialMediaCount = 0,
  ): Promise<void> {
    const session: AwaitingMediaSession = {
      mode: 'awaiting_media',
      trackingCode: String(report.trackingCode),
      report,
      mediaCount: initialMediaCount,
    };

    this.sessions.set(chatId, session);
    this.saveState();

    await this.sendMessage(
      chatId,
      [
        '📎 مستندات گزارش',
        '',
        'مرحله ۳ از ۳ | پیوست اختیاری',
        '',
        'اگر درباره این موضوع عکس، ویدئو، اسکرین‌شات، فایل، نامه، پاسخ اداره یا هر مستند مرتبط دیگری در اختیار دارید، لطفاً همین‌جا ارسال کنید.',
        '',
        '📸 می‌توانید چند عکس یا فایل را پشت‌سرهم بفرستید.',
        '🎥 ویدئو و فایل نیز قابل ارسال است.',
        initialMediaCount > 0
          ? '✅ تاکنون ' +
            this.toPersianNumber(initialMediaCount) +
            ' مستند برای این پرونده دریافت شده است.'
          : 'اگر مستندی ندارید، اشکالی ندارد؛ گزارش شما بدون مستند نیز قابل بررسی است.',
        '',
        'پس از پایان ارسال، دکمه ثبت نهایی را بزنید.',
        '',
        '🔐 از ارسال اطلاعات شخصی نامرتبطِ افراد دیگر خودداری کنید.',
        '🆔 ' + session.trackingCode,
      ].join('\n'),
      this.getMediaInlineKeyboard(initialMediaCount, session.trackingCode),
    );
  }

  private async handleOptionalMedia(
    message: BaleMessage,
    session: AwaitingMediaSession,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const mediaLabel = this.getMediaLabel(message);

    session.mediaCount = await this.persistAndCopyMedia(
      message,
      session.trackingCode,
    );
    this.sessions.set(chatId, session);
    this.saveState();

    await this.sendMessage(
      chatId,
      [
        '✅ ' + mediaLabel + ' با موفقیت به پرونده گزارش پیوست شد.',
        '',
        '📎 تعداد مستندات ثبت‌شده: ' + this.toPersianNumber(session.mediaCount),
        '',
        'اگر مستند دیگری دارید، آن را هم ارسال کنید.',
        'در غیر این صورت از دکمه «✅ پایان ارسال و ثبت نهایی» استفاده کنید.',
      ].join('\n'),
      this.getMediaInlineKeyboard(session.mediaCount, session.trackingCode),
    );
  }

  private async finishMediaCollection(
    chatId: ChatId,
    session: AwaitingMediaSession,
  ): Promise<void> {
    try {
      session.report = await this.reportsService.finalizeReport(
        session.trackingCode,
      );
    } catch {
      await this.sendMessage(
        chatId,
        'ثبت نهایی انجام نشد. لطفاً دوباره دکمه ثبت نهایی را بزنید.',
        this.getMediaInlineKeyboard(session.mediaCount, session.trackingCode),
      );
      return;
    }
    this.sessions.delete(chatId);
    this.saveState();

    try {
      const editorialReport = await this.reportsService.getReportForEditorial(
        session.trackingCode,
      );

      if (
        editorialReport.editorialChatId &&
        editorialReport.editorialMessageId &&
        (editorialReport.editorialPlatform ?? 'bale') === this.platform
      ) {
        await this.refreshEditorialCard(
          editorialReport,
          String(editorialReport.editorialChatId),
          String(editorialReport.editorialMessageId),
        );
      } else {
        await this.sendEditorialReadyForReview(
          editorialReport,
          session.mediaCount,
        );
      }
    } catch (error: any) {
      this.logger.error(
        'Editorial final card failed: ' + (error?.message ?? 'Unknown error'),
      );
    }

    await this.sendMessage(
      chatId,
      [
        '✅ گزارش شما با موفقیت ثبت نهایی شد',
        '',
        '🆔 کد رهگیری: ' + session.trackingCode,
        '📌 وضعیت: ' + this.getStatusLabel(session.report.status),
        session.mediaCount > 0
          ? '📎 مستندات پیوست‌شده: ' + this.toPersianNumber(session.mediaCount)
          : '📎 مستند پیوست نشده است.',
        '',
        'از اینجا به بعد پرونده وارد چرخه بررسی و پیگیری «کازرون خبر» می‌شود.',
        'کد رهگیری را نگه دارید؛ از دکمه زیر می‌توانید آخرین وضعیت همین گزارش را مشاهده کنید.',
        '',
        'از اعتماد شما سپاسگزاریم.',
        '✨ کازرون خبر؛ روایت اول کازرون',
      ].join('\n'),
      this.getFinalReportInlineKeyboard(session.trackingCode),
    );
  }

  private hasSupportedMedia(message: BaleMessage): boolean {
    return Boolean(
      (Array.isArray(message.photo) && message.photo.length > 0) ||
      message.video ||
      message.document ||
      message.animation ||
      message.audio ||
      message.voice,
    );
  }

  private getMediaLabel(message: BaleMessage): string {
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      return 'عکس';
    }

    if (message.video) {
      return 'ویدیو';
    }

    if (message.document) {
      return 'فایل';
    }

    if (message.animation) {
      return 'تصویر متحرک';
    }

    if (message.audio) {
      return 'فایل صوتی';
    }

    if (message.voice) {
      return 'پیام صوتی';
    }

    return 'رسانه';
  }

  private getMediaPersistenceData(message: BaleMessage): {
    mediaType: string;
    fileId: string | null;
    fileUniqueId: string | null;
    caption: string | null;
    mimeType: string | null;
    fileName: string | null;
  } {
    const caption = String(message.caption ?? '').trim() || null;

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];

      return {
        mediaType: 'photo',
        fileId: photo?.file_id ?? null,
        fileUniqueId: photo?.file_unique_id ?? null,
        caption,
        mimeType: 'image',
        fileName: null,
      };
    }

    const candidates: Array<{
      type: string;
      file?: BaleMediaFile;
    }> = [
      { type: 'video', file: message.video },
      { type: 'document', file: message.document },
      { type: 'animation', file: message.animation },
      { type: 'audio', file: message.audio },
      { type: 'voice', file: message.voice },
    ];

    const selected = candidates.find((item) => Boolean(item.file));

    return {
      mediaType: selected?.type ?? 'media',
      fileId: selected?.file?.file_id ?? null,
      fileUniqueId: selected?.file?.file_unique_id ?? null,
      caption,
      mimeType: selected?.file?.mime_type ?? null,
      fileName: selected?.file?.file_name ?? null,
    };
  }

  private async persistAndCopyMedia(
    message: BaleMessage,
    trackingCode: string,
  ): Promise<number> {
    const mediaData = this.getMediaPersistenceData(message);
    const platformUserId = this.getPlatformUserId(message);

    await this.reportsService.addReportMedia(trackingCode, {
      platform: this.platform,
      platformUserId,
      sourceChatId: String(message.chat.id),
      sourceMessageId: String(message.message_id),
      ...mediaData,
    });

    await this.copyMediaToEditorial(
      message,
      trackingCode,
      this.getMediaLabel(message),
    );
    return this.reportsService.getReportMediaCount(trackingCode);
  }

  private async copyMediaToEditorial(
    message: BaleMessage,
    trackingCode: string,
    mediaLabel: string,
  ): Promise<void> {
    const editorialPeer = this.getReportEditorialPeer();
    const editorialChatId = editorialPeer.getEditorialChatId();

    if (editorialChatId === null) {
      this.logger.warn(
        'Editorial chat is not configured. Media was not copied.',
      );
      return;
    }

    try {
      await editorialPeer.sendEditorialMessage(
        [
          '📎 مستند جدید برای پرونده گزارش',
          '🆔 کد رهگیری: ' + trackingCode,
          '🗃 نوع مستند: ' + mediaLabel,
        ].join('\n'),
      );

      if (editorialPeer.platform !== this.platform) {
        this.logger.warn(
          'Report media is stored, but cross-platform file copying is not supported for ' +
            this.platform,
        );
        return;
      }

      await this.apiPost('copyMessage', {
        chat_id: editorialChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      });

      this.logger.log(
        'Media copied to editorial chat for report ' + trackingCode,
      );
    } catch (error: any) {
      this.logger.error(
        'Copy media to editorial failed: ' +
          (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        String(message.chat.id),
        [
          '⚠️ مستند شما در پرونده ثبت شد، اما انتقال نسخه نمایشی آن به گروه تحریریه با اختلال روبه‌رو شد.',
          '',
          'اصل گزارش و اطلاعات ثبت‌شده محفوظ است و این مورد می‌تواند توسط تحریریه بررسی شود.',
        ].join('\n'),
        this.getMediaInlineKeyboard(0, trackingCode),
      );
    }
  }

  private publicExperienceHasSensitiveInfo(text: string): boolean {
    const value = String(text ?? '').trim();
    const compactDigits = value.replace(/[\s\-()]/g, '');

    return (
      /(?:https?:\/\/|www\.)/i.test(value) ||
      /@[A-Za-z0-9_]{3,}/.test(value) ||
      /[0-9۰-۹]{8,}/.test(compactDigits)
    );
  }

  private async handlePublicExperienceInput(
    message: BaleMessage,
    text: string,
    session: AwaitingPublicExperienceSession,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const cleanText = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length < 10) {
      await this.sendMessage(
        chatId,
        '✍️ توضیح کمی بیشتر لازم است؛ تجربه خودتان را در یک یا دو جمله روشن بنویسید.',
      );
      return;
    }

    if (cleanText.length > 700) {
      await this.sendMessage(
        chatId,
        '✂️ متن خیلی طولانی است. لطفاً تجربه را در حداکثر حدود ۷۰۰ نویسه خلاصه کنید.',
      );
      return;
    }

    if (this.publicExperienceHasSensitiveInfo(cleanText)) {
      await this.sendMessage(
        chatId,
        [
          '🔐 برای حفظ حریم خصوصی، متن شما شامل شماره، لینک یا آیدی شخصی تشخیص داده شد.',
          '',
          'لطفاً همان تجربه را بدون اطلاعات تماس و شناسه‌های شخصی دوباره ارسال کنید.',
        ].join('\n'),
      );
      return;
    }

    try {
      const result = await this.reportsService.createPublicExperience(
        session.trackingCode,
        this.platform,
        this.getPlatformUserId(message),
        cleanText,
      );

      this.sessions.delete(chatId);

      await this.sendMessage(
        chatId,
        [
          '✅ تجربه شما دریافت شد.',
          '',
          '🛡 برای جلوگیری از توهین، اطلاعات شخصی و ادعاهای تأییدنشده، تجربه ابتدا توسط تحریریه بررسی می‌شود.',
          'پس از تأیید، بدون نمایش هویت شما زیر همین مطالبه قرار می‌گیرد.',
        ].join('\n'),
        {
          inline_keyboard: [
            [
              {
                text: '🔥 بازگشت به مطالبه',
                callback_data: 'usr:dm:' + session.trackingCode,
              },
            ],
          ],
        },
      );

      await this.sendPublicExperienceModerationCard(result);
    } catch (error: any) {
      const messageText = String(error?.message ?? '');
      await this.sendMessage(
        chatId,
        messageText.includes('Daily experience limit')
          ? '⏳ برای جلوگیری از اسپم، فعلاً سقف ارسال تجربه برای این مطالبه پر شده است. بعداً دوباره تلاش کنید.'
          : '⚠️ ثبت تجربه با خطا روبه‌رو شد. لطفاً دوباره تلاش کنید.',
      );
    }
  }

  private async handlePublicEvidenceInput(
    message: BaleMessage,
    session: AwaitingPublicEvidenceSession,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const mediaData = this.getMediaPersistenceData(message);

    try {
      const result = await this.reportsService.createPublicEvidence(
        session.trackingCode,
        {
          platform: this.platform,
          platformUserId: this.getPlatformUserId(message),
          sourceChatId: String(message.chat.id),
          sourceMessageId: String(message.message_id),
          ...mediaData,
        },
      );

      this.sessions.delete(chatId);

      await this.copyPublicEvidenceToEditorial(message, session.trackingCode);
      await this.sendPublicEvidenceModerationCard(result);

      await this.sendMessage(
        chatId,
        [
          '✅ مستند تکمیلی دریافت شد.',
          '',
          'این فایل در اختیار تحریریه قرار گرفت و پس از بررسی، در آمار مستندات تأییدشده مطالبه لحاظ می‌شود.',
          'هویت ارسال‌کننده در بخش عمومی نمایش داده نمی‌شود.',
        ].join('\n'),
        {
          inline_keyboard: [
            [
              {
                text: '🔥 بازگشت به مطالبه',
                callback_data: 'usr:dm:' + session.trackingCode,
              },
            ],
          ],
        },
      );
    } catch (error: any) {
      const messageText = String(error?.message ?? '');
      await this.sendMessage(
        chatId,
        messageText.includes('Daily evidence limit')
          ? '⏳ برای جلوگیری از اسپم، سقف ارسال مستند برای امروز پر شده است.'
          : '⚠️ ثبت مستند با خطا روبه‌رو شد. لطفاً دوباره تلاش کنید.',
      );
    }
  }

  private async copyPublicEvidenceToEditorial(
    message: BaleMessage,
    trackingCode: string,
  ): Promise<void> {
    const editorialPeer = this.getReportEditorialPeer();
    const editorialChatId = editorialPeer.getEditorialChatId();
    if (editorialChatId === null) return;

    try {
      await editorialPeer.sendEditorialMessage(
        [
          '📎 مستند مردمی جدید | نیازمند بررسی',
          '🆔 مطالبه: ' + trackingCode,
          '🗃 نوع: ' + this.getMediaLabel(message),
          '🔐 هویت ارسال‌کننده عمومی نمی‌شود.',
        ].join('\n'),
      );

      if (editorialPeer.platform !== this.platform) {
        this.logger.warn(
          'Public evidence is stored, but cross-platform file copying is not supported for ' +
            this.platform,
        );
        return;
      }

      await this.apiPost('copyMessage', {
        chat_id: editorialChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      });
    } catch (error: any) {
      this.logger.warn(
        'Public evidence copy failed: ' + (error?.message ?? 'Unknown error'),
      );
    }
  }

  private async sendPublicExperienceModerationCard(result: any): Promise<void> {
    const editorialPeer = this.getReportEditorialPeer();
    const editorialChatId = editorialPeer.getEditorialChatId();
    if (editorialChatId === null) return;

    const experience = result?.experience;
    const report = result?.report;
    if (!experience || !report) return;

    await editorialPeer.sendMessage(
      editorialChatId,
      [
        '💬 تجربه مردمی جدید | صف بررسی',
        '',
        '🔥 مطالبه: ' + String(report.publicTitle ?? report.trackingCode),
        '🆔 ' + String(report.trackingCode),
        '',
        '📝 متن تجربه:',
        String(experience.text ?? '').trim(),
        '',
        '🔐 هویت نویسنده در بخش عمومی نمایش داده نمی‌شود.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: '✅ تأیید',
              callback_data: 'adm:ea:' + String(experience.id),
            },
            {
              text: '📌 تأیید و برگزیده',
              callback_data: 'adm:ep:' + String(experience.id),
            },
          ],
          [
            {
              text: '❌ رد',
              callback_data: 'adm:er:' + String(experience.id),
            },
          ],
        ],
      },
    );
  }

  private async sendPublicEvidenceModerationCard(result: any): Promise<void> {
    const editorialPeer = this.getReportEditorialPeer();
    const editorialChatId = editorialPeer.getEditorialChatId();
    if (editorialChatId === null) return;

    const evidence = result?.evidence;
    const report = result?.report;
    if (!evidence || !report) return;

    await editorialPeer.sendMessage(
      editorialChatId,
      [
        '🛡 بررسی مستند مردمی',
        '',
        '🔥 مطالبه: ' + String(report.publicTitle ?? report.trackingCode),
        '🆔 ' + String(report.trackingCode),
        evidence.caption ? '📝 کپشن: ' + String(evidence.caption) : '',
        '',
        'در صورت مرتبط و قابل استفاده بودن، تأیید کنید تا در آمار مستندات معتبر مطالبه لحاظ شود.',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: '✅ تأیید مستند',
              callback_data: 'adm:va:' + String(evidence.id),
            },
            {
              text: '❌ رد مستند',
              callback_data: 'adm:vr:' + String(evidence.id),
            },
          ],
        ],
      },
    );
  }

  private async clearInlineKeyboard(
    chatId: ChatId,
    messageId: ChatId,
  ): Promise<void> {
    try {
      await this.apiPost('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      // Not critical; moderation actions are idempotent enough for retry.
    }
  }

  private async handleAiAnswer(
    message: BaleMessage,
    text: string,
    session: AwaitingAiAnswersSession,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const currentQuestion = session.questions[session.questionIndex];

    if (!currentQuestion) {
      this.sessions.delete(chatId);
      await this.sendMainMenu(chatId);
      return;
    }

    session.answers.push({
      question: currentQuestion,
      answer: text,
    });

    session.questionIndex += 1;

    this.logger.log(
      'AI answer received for ' +
        session.trackingCode +
        ' (' +
        session.questionIndex +
        '/' +
        session.questions.length +
        ')',
    );

    if (session.questionIndex < session.questions.length) {
      this.sessions.set(chatId, session);
      this.saveState();
      await this.sendAiQuestion(chatId, session);
      return;
    }

    await this.sendMessage(
      chatId,
      [
        '✅ اطلاعات تکمیلی شما ثبت شد.',
        '',
        '🤖 گزارش در حال جمع‌بندی نهایی است؛ پس از آن مستندات احتمالی را دریافت می‌کنیم.',
      ].join('\n'),
      this.getReportProgressInlineKeyboard(),
    );

    await this.sendChatAction(chatId, 'typing');

    const platformUserId = this.getPlatformUserId(message);

    try {
      const result = await this.reportsService.submitAnswersAndReanalyze(
        session.trackingCode,
        {
          platform: this.platform,
          platformUserId,
          answers: session.answers,
        },
      );

      const analysis = result?.analysis;

      if (!analysis) {
        throw new Error('Reanalysis returned empty analysis');
      }

      this.logger.log('AI reanalysis completed for ' + session.trackingCode);

      if (analysis.isComplete === true) {
        await this.beginMediaCollection(
          chatId,
          result.report,
          session.mediaCount,
        );
        return;
      }

      const newQuestions = this.normalizeQuestions(analysis.questions);

      if (newQuestions.length === 0) {
        await this.beginMediaCollection(
          chatId,
          result.report,
          session.mediaCount,
        );
        return;
      }

      const newSession: AwaitingAiAnswersSession = {
        mode: 'awaiting_ai_answers',
        trackingCode: session.trackingCode,
        questions: newQuestions,
        answers: [],
        questionIndex: 0,
        mediaCount: session.mediaCount,
      };

      this.sessions.set(chatId, newSession);
      this.saveState();

      this.logger.log(
        'AI requested ' +
          newQuestions.length +
          ' additional questions for ' +
          session.trackingCode,
      );

      await this.sendMessage(
        chatId,
        '🔎 برای اینکه پرونده قابل پیگیری بماند، یک نکته ضروری دیگر لازم است.',
      );

      await this.sendAiQuestion(chatId, newSession);
    } catch (error: any) {
      this.logger.error(
        'Answer reanalysis failed for ' +
          session.trackingCode +
          ': ' +
          (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        chatId,
        [
          '✅ پاسخ‌های تکمیلی شما دریافت شده است.',
          '',
          '⚠️ جمع‌بندی هوشمند در این لحظه با اختلال روبه‌رو شد، اما پرونده گزارش محفوظ است.',
          'برای از دست نرفتن مستندات، مرحله پایانی گزارش را ادامه می‌دهیم.',
          '',
          '🆔 کد رهگیری: ' + session.trackingCode,
        ].join('\n'),
      );

      try {
        const report = await this.reportsService.getReportByTrackingCode(
          session.trackingCode,
          this.platform,
          platformUserId,
        );

        await this.beginMediaCollection(chatId, report, session.mediaCount);
      } catch {
        this.sessions.delete(chatId);
        await this.sendMainMenu(chatId);
      }
    }
  }

  private async sendAiQuestion(
    chatId: ChatId,
    session: AwaitingAiAnswersSession,
  ): Promise<void> {
    const question = session.questions[session.questionIndex];

    if (!question) {
      return;
    }

    await this.sendMessage(
      chatId,
      [
        '🤖 تکمیل هوشمند گزارش',
        '',
        '🧭 مرحله ۲ از ۳',
        'پرسش ' +
          this.toPersianNumber(session.questionIndex + 1) +
          ' از ' +
          this.toPersianNumber(session.questions.length),
        '',
        '❓ ' + question,
        '',
        'پاسخ کوتاه و روشن کافی است.',
        'اگر واقعاً اطلاعاتش را ندارید، از دکمه «🤷 اطلاع ندارم» استفاده کنید.',
      ].join('\n'),
      this.getAiQuestionInlineKeyboard(
        session.trackingCode,
        session.questionIndex,
      ),
    );
  }

  private normalizeQuestions(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item: unknown) => String(item).trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  private async handleCallbackQuery(query: BaleCallbackQuery): Promise<void> {
    const data = String(query.data ?? '').trim();
    const message = query.message;
    if (/^(?:kza|nwa|ada):/.test(data)) {
      await this.answerCallbackQuery(query.id, 'این بخش غیرفعال است.');
      return;
    }
    const chatId = String(message?.chat?.id ?? query.from?.id ?? 0);

    if (!chatId || !data) {
      await this.answerCallbackQuery(query.id);
      return;
    }

    if (
      message &&
      (message.chat.type !== 'private' || this.isEditorialChat(message.chat.id))
    ) {
      if (this.isEditorialChat(message.chat.id) && data.startsWith('adm:')) {
        await this.handleEditorialCallback(query);
        return;
      }

      if (this.isEditorialChat(message.chat.id) && data.startsWith('kza:')) {
        await this.handleKazerunYarAdminCallback(query);
        return;
      }

      if (this.isEditorialChat(message.chat.id) && data.startsWith('nwa:')) {
        await this.handleNewsAdminCallback(query);
        return;
      }

      if (this.isEditorialChat(message.chat.id) && data.startsWith('ada:')) {
        await this.handleAdsAdminCallback(query);
        return;
      }

      await this.answerCallbackQuery(query.id);
      return;
    }

    await this.answerCallbackQuery(query.id);
    if (/^usr:(?:kz|n|ad)/.test(data)) {
      await this.sendMessage(
        chatId,
        'این بخش فعلاً غیرفعال است.',
        this.getMainInlineKeyboard(),
      );
      return;
    }

    if (data === 'usr:home') {
      this.sessions.delete(chatId);
      await this.sendMainMenu(chatId);
      return;
    }

    if (data === 'usr:report') {
      await this.startReportFlow(chatId);
      return;
    }

    if (data.startsWith('usr:resume:')) {
      const code = data.slice('usr:resume:'.length);
      try {
        const report = await this.reportsService.getReportByTrackingCode(
          code,
          this.platform,
          String(query.from.id),
        );
        if (
          report.submissionCompletedAt ||
          !['NEW', 'NEEDS_INFO', 'READY_FOR_REVIEW'].includes(report.status)
        ) {
          await this.sendReportStatus(chatId, String(query.from.id), code);
          return;
        }
        await this.beginMediaCollection(
          chatId,
          report,
          report.media?.length ?? 0,
        );
      } catch {
        await this.sendMessage(
          chatId,
          'این گزارش برای ادامه ثبت در دسترس نیست.',
          this.getHomeKeyboard(),
        );
      }
      return;
    }

    if (data === 'usr:track') {
      await this.startTrackingFlow(chatId);
      return;
    }

    if (data === 'usr:myreports' || data === 'usr:my') {
      this.sessions.delete(chatId);
      await this.sendMyReports(chatId, String(query.from.id));
      return;
    }

    if (data === 'usr:ai') {
      await this.sendReportGuide(chatId);
      return;
    }

    if (data === 'usr:guide') {
      this.sessions.delete(chatId);
      await this.sendReportGuide(chatId);
      return;
    }

    if (data === 'usr:kz') {
      this.sessions.delete(chatId);
      await this.sendKazerunYarMenu(chatId);
      return;
    }

    if (data === 'usr:kzs') {
      this.sessions.set(chatId, {
        mode: 'awaiting_kazerunyar_search',
      });
      await this.sendMessage(
        chatId,
        [
          '🔎 جستجو در کازرون‌یار',
          '',
          'نام اداره، مرکز درمانی، خدمت شهری، مکان یا موضوع موردنظر را بنویسید.',
          '',
          'نمونه: «داروخانه»، «اداره برق»، «ترمینال» یا نام یک مرکز مشخص',
          '',
          'اطلاعات نمایش‌داده‌شده از بانک شهری کازرون‌یار خوانده می‌شود؛ ربات آدرس یا شماره‌ای را از خودش حدس نمی‌زند.',
        ].join('\n'),
        this.getKazerunYarBackKeyboard(),
      );
      return;
    }

    if (data === 'usr:kzmiss') {
      this.sessions.set(chatId, {
        mode: 'awaiting_kazerunyar_feedback',
        feedbackType: 'MISSING',
      });
      await this.sendMessage(
        chatId,
        [
          '➕ پیشنهاد افزودن به کازرون‌یار',
          '',
          'نام مرکز/خدمت و هر اطلاعاتی که مطمئن هستید بنویسید؛ مثل آدرس، شماره تماس یا توضیح کوتاه.',
          '',
          'تحریریه قبل از اضافه‌شدن به بانک عمومی، اطلاعات را بررسی می‌کند.',
        ].join('\n'),
        this.getKazerunYarBackKeyboard(),
      );
      return;
    }

    if (data.startsWith('usr:kzcat:')) {
      const category = data.slice('usr:kzcat:'.length).trim();
      this.sessions.delete(chatId);
      await this.sendKazerunYarCategory(chatId, category);
      return;
    }

    if (data.startsWith('usr:kzi:')) {
      const id = data.slice('usr:kzi:'.length).trim();
      this.sessions.delete(chatId);
      await this.sendKazerunYarServiceDetails(chatId, id);
      return;
    }

    if (data.startsWith('usr:kzf:')) {
      const id = data.slice('usr:kzf:'.length).trim();
      this.sessions.set(chatId, {
        mode: 'awaiting_kazerunyar_feedback',
        cityServiceId: id,
        feedbackType: 'CORRECTION',
      });
      await this.sendMessage(
        chatId,
        [
          '⚠️ گزارش اصلاح اطلاعات',
          '',
          'اگر آدرس، تلفن، ساعت کاری یا توضیح این مورد اشتباه یا قدیمی است، اطلاعات درست را در یک پیام بنویسید.',
          '',
          'گزارش شما ابتدا توسط تحریریه بررسی می‌شود.',
        ].join('\n'),
        this.getKazerunYarBackKeyboard(),
      );
      return;
    }

    if (data === 'usr:news') {
      this.sessions.delete(chatId);
      await this.sendNewsMenu(chatId);
      return;
    }

    if (data === 'usr:nlatest') {
      this.sessions.delete(chatId);
      await this.sendNewsList(chatId);
      return;
    }

    if (data === 'usr:nurgent') {
      this.sessions.delete(chatId);
      await this.sendNewsList(chatId, undefined, true);
      return;
    }

    if (data.startsWith('usr:ncat:')) {
      this.sessions.delete(chatId);
      const category = data.slice('usr:ncat:'.length).trim();
      await this.sendNewsList(chatId, category, false);
      return;
    }

    if (data.startsWith('usr:nview:')) {
      this.sessions.delete(chatId);
      const id = data.slice('usr:nview:'.length).trim();
      await this.sendNewsDetails(chatId, id);
      return;
    }

    if (data === 'usr:nsubs') {
      this.sessions.delete(chatId);
      await this.sendNewsSubscriptionMenu(chatId, String(query.from.id));
      return;
    }

    if (data.startsWith('usr:nsub:')) {
      const category = data.slice('usr:nsub:'.length).trim();
      await this.newsService.toggleSubscription(
        this.platform,
        String(query.from.id),
        category,
      );
      await this.sendNewsSubscriptionMenu(chatId, String(query.from.id));
      return;
    }

    if (data === 'usr:nsuboff') {
      await this.newsService.disableAllSubscriptions(
        this.platform,
        String(query.from.id),
      );
      await this.sendNewsSubscriptionMenu(chatId, String(query.from.id));
      return;
    }

    if (data === 'usr:ads') {
      this.sessions.delete(chatId);
      await this.sendAdsMenu(chatId, String(query.from.id));
      return;
    }

    if (data === 'usr:adpkgs') {
      this.sessions.delete(chatId);
      await this.sendAdPackages(chatId);
      return;
    }

    if (data === 'usr:adorders') {
      this.sessions.delete(chatId);
      await this.sendUserAdOrders(chatId, String(query.from.id));
      return;
    }

    if (data === 'usr:adrules') {
      this.sessions.delete(chatId);
      await this.sendAdRules(chatId);
      return;
    }

    if (data.startsWith('usr:adbuy:')) {
      const packageId = data.slice('usr:adbuy:'.length).trim();
      await this.handleAdPackagePurchase(query, packageId);
      return;
    }

    if (data.startsWith('usr:adorder:')) {
      const orderId = data.slice('usr:adorder:'.length).trim();
      this.sessions.delete(chatId);
      await this.sendUserAdOrderDetails(chatId, String(query.from.id), orderId);
      return;
    }

    if (data.startsWith('usr:adpay:')) {
      const orderId = data.slice('usr:adpay:'.length).trim();
      await this.sendAdPaymentLink(chatId, String(query.from.id), orderId);
      return;
    }

    if (data.startsWith('usr:adcheck:')) {
      const orderId = data.slice('usr:adcheck:'.length).trim();
      await this.handleAdPaymentCheck(chatId, String(query.from.id), orderId);
      return;
    }

    if (data.startsWith('usr:adcontinue:')) {
      const orderId = data.slice('usr:adcontinue:'.length).trim();
      await this.startAdContentFlow(chatId, String(query.from.id), orderId);
      return;
    }

    if (data.startsWith('usr:adfinishmedia:')) {
      const orderId = data.slice('usr:adfinishmedia:'.length).trim();
      const session = this.sessions.get(chatId);
      if (
        session?.mode === 'awaiting_ad_content' &&
        session.orderId === orderId
      ) {
        this.sessions.delete(chatId);
        await this.finalizeAdOrder(chatId, orderId, false);
      } else {
        await this.finalizeAdOrder(chatId, orderId, false);
      }
      return;
    }

    if (data.startsWith('usr:adrev:')) {
      const orderId = data.slice('usr:adrev:'.length).trim();
      try {
        const order = await this.adsService.getUserOrder(
          orderId,
          this.platform,
          String(query.from.id),
        );
        if (String(order.status) !== 'NEEDS_REVISION') {
          await this.sendMessage(
            chatId,
            'این سفارش در حال حاضر نیازمند اصلاح نیست.',
            this.getAdsHomeKeyboard(),
          );
          return;
        }
        this.sessions.set(chatId, { mode: 'awaiting_ad_revision', orderId });
        await this.sendMessage(
          chatId,
          [
            '✏️ ارسال اصلاحات سفارش',
            '',
            order.reviewNote
              ? '📝 توضیح تحریریه: ' + String(order.reviewNote)
              : '',
            '',
            'اصلاحات، توضیحات یا اطلاعات جدید را در یک پیام بنویسید.',
          ]
            .filter(Boolean)
            .join('\n'),
          this.getAdsHomeKeyboard(),
        );
      } catch {
        await this.sendMessage(chatId, 'سفارش پیدا نشد.');
      }
      return;
    }

    if (data.startsWith('usr:dl:')) {
      const [, , view, rawPage] = data.split(':');
      this.sessions.delete(chatId);
      await this.sendPublicDemands(
        chatId,
        String(query.from.id),
        view,
        Number(rawPage) || 0,
      );
      return;
    }
    if (data.startsWith('usr:dx:') || data.startsWith('usr:di:')) {
      const code = data.slice(7);
      this.sessions.delete(chatId);
      try {
        const demand = await this.reportsService.getPublicDemandForUser(
          code,
          this.platform,
          String(query.from.id),
        );
        if (data.startsWith('usr:dx:'))
          await this.sendDemandExperiences(chatId, demand);
        else await this.sendDemandDetails(chatId, demand);
      } catch {
        await this.sendMessage(
          chatId,
          'دریافت جزئیات ممکن نشد؛ دوباره تلاش کنید.',
          this.getSimpleHomeInlineKeyboard(),
        );
      }
      return;
    }

    if (data === 'usr:demands') {
      this.sessions.delete(chatId);
      await this.sendPublicDemands(chatId, String(query.from.id));
      return;
    }

    if (data.startsWith('usr:dm:')) {
      const trackingCode = data.slice('usr:dm:'.length).trim();
      this.sessions.delete(chatId);
      await this.sendPublicDemandDetails(
        chatId,
        String(query.from.id),
        trackingCode,
      );
      return;
    }

    if (data.startsWith('usr:sp:')) {
      const trackingCode = data.slice('usr:sp:'.length).trim();

      try {
        await this.reportsService.togglePublicSupport(
          trackingCode,
          this.platform,
          String(query.from.id),
        );

        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          trackingCode,
        );
      } catch (error: any) {
        this.logger.warn(
          'Public support toggle failed: ' +
            (error?.message ?? 'Unknown error'),
        );
      }

      return;
    }

    if (data.startsWith('usr:ax:')) {
      const trackingCode = data.slice('usr:ax:'.length).trim();
      try {
        await this.reportsService.togglePublicAffected(
          trackingCode,
          this.platform,
          String(query.from.id),
        );
        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          trackingCode,
        );
      } catch (error: any) {
        this.logger.warn(
          'Public affected toggle failed: ' +
            (error?.message ?? 'Unknown error'),
        );
      }
      return;
    }

    if (data.startsWith('usr:fw:')) {
      const trackingCode = data.slice('usr:fw:'.length).trim();
      try {
        const result = await this.reportsService.togglePublicFollower(
          trackingCode,
          this.platform,
          String(query.from.id),
        );
        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          trackingCode,
        );
        if (result.followed) {
          await this.sendMessage(
            chatId,
            '🔔 از این پس بروزرسانی‌های مهم این مطالبه را از طریق ربات دریافت می‌کنید.',
          );
        }
      } catch (error: any) {
        this.logger.warn(
          'Public follow toggle failed: ' + (error?.message ?? 'Unknown error'),
        );
      }
      return;
    }

    if (data.startsWith('usr:xp:')) {
      const trackingCode = data.slice('usr:xp:'.length).trim();
      this.sessions.set(chatId, {
        mode: 'awaiting_public_experience',
        trackingCode,
      });
      await this.sendMessage(
        chatId,
        [
          '💬 تجربه شما درباره این مطالبه',
          '',
          'اگر خودتان این مشکل را دیده‌اید یا اطلاعات مفیدی دارید، در یک پیام کوتاه و روشن بنویسید.',
          '',
          '🔐 نام و هویت شما در بخش عمومی نمایش داده نمی‌شود.',
          '🛡 متن قبل از انتشار توسط تحریریه بررسی می‌شود.',
          '🚫 شماره تلفن، آیدی شخصی، لینک و اطلاعات خصوصی افراد را داخل متن ننویسید.',
          '⚖️ از توهین، نسبت‌دادن جرم یا اتهام قطعی به اشخاص خودداری کنید؛ فقط چیزی را که دیده‌اید یا تجربه کرده‌اید بنویسید.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: 'لغو', callback_data: 'usr:dm:' + trackingCode }],
          ],
        },
      );
      return;
    }

    if (data.startsWith('usr:ed:')) {
      const trackingCode = data.slice('usr:ed:'.length).trim();
      this.sessions.set(chatId, {
        mode: 'awaiting_public_evidence',
        trackingCode,
      });
      await this.sendMessage(
        chatId,
        [
          '📎 ارسال مستند تکمیلی',
          '',
          'یک عکس، ویدئو، اسکرین‌شات، نامه یا فایل مرتبط با همین مطالبه ارسال کنید.',
          'اگر توضیح کوتاهی لازم است، آن را در کپشن همان فایل بنویسید.',
          '',
          '🛡 مستند ابتدا برای تحریریه ارسال می‌شود و بدون تأیید عمومی نخواهد شد.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: 'لغو', callback_data: 'usr:dm:' + trackingCode }],
          ],
        },
      );
      return;
    }

    if (data.startsWith('usr:ev:')) {
      const experienceId = data.slice('usr:ev:'.length).trim();
      try {
        const result = await this.reportsService.togglePublicExperienceVote(
          experienceId,
          this.platform,
          String(query.from.id),
        );
        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          String(result.trackingCode),
        );
      } catch (error: any) {
        this.logger.warn(
          'Experience vote failed: ' + (error?.message ?? 'Unknown error'),
        );
      }
      return;
    }

    if (data.startsWith('usr:fg:')) {
      const experienceId = data.slice('usr:fg:'.length).trim();
      try {
        const result = await this.reportsService.flagPublicExperience(
          experienceId,
          this.platform,
          String(query.from.id),
        );
        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          String(result.trackingCode),
        );
        if (!result.alreadyFlagged) {
          await this.sendMessage(
            chatId,
            result.hiddenForReview
              ? '🚩 این تجربه برای بررسی مجدد تحریریه از نمایش عمومی خارج شد.'
              : '🚩 گزارش شما ثبت شد و در صورت تکرار برای بررسی مجدد تحریریه ارسال می‌شود.',
          );

          if (result.hiddenForReview) {
            const editorialPeer = this.getReportEditorialPeer();
            const editorialChatId = editorialPeer.getEditorialChatId();
            if (editorialChatId !== null) {
              await editorialPeer.sendMessage(
                editorialChatId,
                [
                  '🚩 تجربه مردمی با چند گزارش | بررسی مجدد',
                  '',
                  '🆔 مطالبه: ' + String(result.trackingCode),
                  '🚩 تعداد گزارش: ' +
                    this.toPersianNumber(Number(result.flagCount ?? 0)),
                  '',
                  '📝 متن:',
                  String(result.text ?? '').trim(),
                ].join('\n'),
                {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ تأیید مجدد',
                        callback_data: 'adm:ea:' + String(result.experienceId),
                      },
                      {
                        text: '❌ حذف از نمایش',
                        callback_data: 'adm:er:' + String(result.experienceId),
                      },
                    ],
                  ],
                },
              );
            }
          }
        }
      } catch (error: any) {
        this.logger.warn(
          'Experience flag failed: ' + (error?.message ?? 'Unknown error'),
        );
      }
      return;
    }

    if (data.startsWith('usr:rv:s:') || data.startsWith('usr:rv:u:')) {
      const solved = data.startsWith('usr:rv:s:');
      const prefix = solved ? 'usr:rv:s:' : 'usr:rv:u:';
      const trackingCode = data.slice(prefix.length).trim();
      try {
        await this.reportsService.togglePublicResolutionVote(
          trackingCode,
          solved ? 'SOLVED' : 'UNRESOLVED',
          this.platform,
          String(query.from.id),
        );
        await this.refreshPublicDemandCard(
          chatId,
          String(message?.message_id ?? 0),
          String(query.from.id),
          trackingCode,
        );
      } catch (error: any) {
        this.logger.warn(
          'Public resolution vote failed: ' +
            (error?.message ?? 'Unknown error'),
        );
      }
      return;
    }

    if (data === 'usr:sample') {
      const current = this.sessions.get(chatId);

      if (!current || current.mode !== 'awaiting_report') {
        this.sessions.set(chatId, {
          mode: 'awaiting_report',
        });
      }

      await this.sendMessage(
        chatId,
        [
          '💡 نمونه یک گزارش خوب',
          '',
          '«سه شب است روشنایی بخشی از بلوار خرمشهر، حدفاصل ... تا ... خاموش است. این مسیر شب‌ها تردد زیادی دارد و تاریکی آن برای عابران و رانندگان مشکل ایجاد کرده. تا این لحظه مشکل ادامه دارد.»',
          '',
          'همین اندازه کافی است؛ لازم نیست متن طولانی یا اداری باشد.',
          '',
          'حالا گزارش خودتان را ارسال کنید 👇',
        ].join('\n'),
        this.getReportEntryInlineKeyboard(),
      );
      return;
    }

    if (data.startsWith('usr:dontknow')) {
      const session = this.sessions.get(chatId);

      if (
        session?.mode !== 'awaiting_ai_answers' ||
        data !==
          'usr:dontknow:' + session.trackingCode + ':' + session.questionIndex
      ) {
        await this.sendMessage(
          chatId,
          'این پرسش دیگر فعال نیست.',
          this.getSimpleHomeInlineKeyboard(),
        );
        return;
      }

      const syntheticMessage: BaleMessage = {
        message_id: String(message?.message_id ?? 0),
        chat: {
          id: chatId,
          type: 'private',
        },
        from: query.from,
      };

      await this.handleAiAnswer(syntheticMessage, 'اطلاع ندارم', session);
      return;
    }

    if (data.startsWith('usr:finishmedia')) {
      const session = this.sessions.get(chatId);

      if (
        session?.mode !== 'awaiting_media' ||
        data !== 'usr:finishmedia:' + session.trackingCode
      ) {
        await this.sendMessage(
          chatId,
          'مرحله مستندات این گزارش پایان یافته است.',
          this.getSimpleHomeInlineKeyboard(),
        );
        return;
      }

      await this.finishMediaCollection(chatId, session);
      return;
    }

    if (data.startsWith('usr:status:')) {
      const trackingCode = data.slice('usr:status:'.length).trim();

      await this.sendReportStatus(chatId, String(query.from.id), trackingCode);
      return;
    }
  }

  private async startReportFlow(chatId: ChatId): Promise<void> {
    this.sessions.set(chatId, {
      mode: 'awaiting_report',
    });

    this.logger.log('Report session started for chat ' + chatId);

    await this.sendReportInstructions(chatId);
  }

  private async startTrackingFlow(chatId: ChatId): Promise<void> {
    this.sessions.set(chatId, {
      mode: 'awaiting_track',
    });

    await this.sendMessage(
      chatId,
      [
        '🔎 پیگیری گزارش',
        '',
        'کد رهگیری گزارشی را که با همین حساب ثبت کرده‌اید ارسال کنید.',
        '',
        'نمونه:',
        'KZ-1786378025672-6221',
        '',
        'پس از ارسال کد، آخرین وضعیت ثبت‌شده نمایش داده می‌شود.',
      ].join('\n'),
      this.getTrackingInlineKeyboard(),
    );
  }

  private async handleTrackingLookup(
    message: BaleMessage,
    rawCode: string,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const trackingCode = String(rawCode ?? '')
      .trim()
      .toUpperCase();

    if (!/^KZ-\d{8,}-\d{4}$/.test(trackingCode)) {
      await this.sendMessage(
        chatId,
        [
          '⚠️ قالب کد رهگیری درست نیست.',
          '',
          'کد باید شبیه این باشد:',
          'KZ-1786378025672-6221',
        ].join('\n'),
        this.getTrackingInlineKeyboard(),
      );
      return;
    }

    this.sessions.delete(chatId);

    await this.sendReportStatus(
      chatId,
      this.getPlatformUserId(message),
      trackingCode,
    );
  }

  private async sendReportStatus(
    chatId: ChatId,
    platformUserId: string,
    trackingCode: string,
  ): Promise<void> {
    try {
      const report = await this.reportsService.getReportByTrackingCode(
        trackingCode,
        this.platform,
        platformUserId,
      );

      const lines: string[] = [
        '🔎 وضعیت گزارش شما',
        '',
        '🆔 کد رهگیری: ' + String(report.trackingCode),
        '📌 وضعیت فعلی: ' +
          (!report.submissionCompletedAt &&
          ['NEW', 'NEEDS_INFO'].includes(report.status)
            ? 'در حال تکمیل ثبت'
            : this.getStatusLabel(report.status)),
        '⚡ اولویت: ' + this.getPriorityLabel(report.priority),
      ];

      if (report.category) {
        lines.push('🗂 دسته‌بندی: ' + String(report.category));
      }

      if (Array.isArray(report.media)) {
        lines.push(
          '📎 مستندات ثبت‌شده: ' + this.toPersianNumber(report.media.length),
        );
      }

      lines.push(
        '🕒 آخرین بروزرسانی: ' +
          this.formatDateTime(report.updatedAt ?? report.createdAt),
      );

      if (report.finalResult) {
        lines.push('', '✅ نتیجه ثبت‌شده:', String(report.finalResult));
      }

      lines.push(
        '',
        'این وضعیت بر اساس آخرین اقدام ثبت‌شده در پرونده نمایش داده می‌شود.',
      );

      await this.sendMessage(
        chatId,
        lines.join('\n'),
        !report.submissionCompletedAt &&
          ['NEW', 'NEEDS_INFO', 'READY_FOR_REVIEW'].includes(report.status)
          ? {
              inline_keyboard: [
                [
                  {
                    text: 'ادامه و ثبت نهایی گزارش',
                    callback_data: 'usr:resume:' + report.trackingCode,
                  },
                ],
                [{ text: '🏠 خانه', callback_data: 'usr:home' }],
              ],
            }
          : this.getStatusResultInlineKeyboard(String(report.trackingCode)),
      );
    } catch {
      await this.sendMessage(
        chatId,
        [
          '⚠️ گزارشی با این کد برای حساب شما پیدا نشد.',
          '',
          'کد را بررسی کنید یا از بخش «📂 گزارش‌های من» استفاده کنید.',
        ].join('\n'),
        this.getTrackingInlineKeyboard(),
      );
    }
  }

  private async sendMyReports(
    chatId: ChatId,
    platformUserId: string,
  ): Promise<void> {
    this.logger.log('ENTER sendMyReports');

    try {
      const reports = await this.reportsService.getUserReports(
        this.platform,
        platformUserId,
      );

      this.logger.log(
        'MY REPORTS DEBUG => user=' +
          platformUserId +
          ' count=' +
          reports.length,
      );

      if (reports.length === 0) {
        await this.sendMessage(
          chatId,
          ['📂 گزارش‌های من', '', 'هنوز گزارشی با این حساب ثبت نشده است.'].join(
            '\n',
          ),
          this.getMainInlineKeyboard(),
        );
        return;
      }

      const recent = reports.slice(0, 5);

      const lines: string[] = [
        '📂 گزارش‌های من',
        '',
        'آخرین پرونده‌های ثبت‌شده شما:',
        '',
      ];

      recent.forEach((report: any, index: number) => {
        lines.push(
          this.toPersianNumber(index + 1) + ') ' + String(report.trackingCode),
          '   📌 ' + this.getStatusLabel(report.status),
        );
      });

      if (reports.length > recent.length) {
        lines.push(
          '',
          'نمایش ' +
            this.toPersianNumber(recent.length) +
            ' گزارش آخر از ' +
            this.toPersianNumber(reports.length) +
            ' گزارش.',
        );
      }

      lines.push('', 'برای مشاهده جزئیات، یکی از دکمه‌های زیر را انتخاب کنید.');

      await this.sendMessage(
        chatId,
        lines.join('\n'),
        this.getMyReportsInlineKeyboard(recent),
      );
    } catch (error: any) {
      this.logger.error(
        'Send my reports failed: ' + (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        chatId,
        '⚠️ دریافت فهرست گزارش‌ها در این لحظه ممکن نشد. لطفاً دوباره تلاش کنید.',
        this.getMainInlineKeyboard(),
      );
    }
  }

  private async sendReportGuide(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        'ℹ️ راهنمای یک گزارش مؤثر',
        '',
        'یک گزارش خوب لازم نیست طولانی باشد؛ کافی است تا حد ممکن روشن کند:',
        '',
        '۱) چه مشکلی رخ داده؟',
        '۲) دقیقاً کجا؟',
        '۳) از چه زمانی یا در چه وضعیتی؟',
        '۴) اگر پیگیری قبلی داشته، نتیجه چه بوده؟',
        '۵) آیا عکس، فیلم، نامه، اسکرین‌شات یا مستندی وجود دارد؟',
        '',
        '🤖 اگر بخشی از اطلاعات واقعاً برای پیگیری ضروری باشد و در متن نباشد، دستیار هوشمند سؤال کوتاه تکمیلی مطرح می‌کند.',
        '',
        '📎 عکس، ویدئو یا فایل اختیاری است؛ پس از ارسال، ثبت نهایی را بزنید.',
        '',
        '🔐 از ارسال اطلاعات شخصی نامرتبط و ادعاهای بدون توضیح کافی خودداری کنید.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: '📍 ثبت گزارش',
              callback_data: 'usr:report',
            },
          ],
          [
            {
              text: '🏠 منوی اصلی',
              callback_data: 'usr:home',
            },
          ],
        ],
      },
    );
  }

  private async removeLegacyReplyKeyboard(chatId: ChatId): Promise<void> {
    try {
      const sent = await this.sendMessage(
        chatId,
        '✅ رابط جدید ربات فعال شد.',
        {
          remove_keyboard: true,
        },
      );

      if (sent?.message_id) {
        await this.deleteMessage(chatId, String(sent.message_id));
      }
    } catch {
      // Non-critical compatibility cleanup.
    }
  }

  private formatDateTime(value: unknown): string {
    const date = new Date(value instanceof Date ? value : String(value ?? ''));

    if (Number.isNaN(date.getTime())) {
      return 'نامشخص';
    }

    try {
      return new Intl.DateTimeFormat('fa-IR', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Tehran',
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  private async sendChatAction(
    chatId: ChatId | string,
    action: string,
  ): Promise<void> {
    try {
      await this.apiPost('sendChatAction', {
        chat_id: chatId,
        action,
      });
    } catch {
      // Chat action is only a UX enhancement.
    }
  }

  private async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    try {
      await this.apiPost('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      });
    } catch (error: any) {
      this.logger.warn(
        'answerCallbackQuery failed: ' + (error?.message ?? 'Unknown error'),
      );
    }
  }

  private async deleteMessage(
    chatId: ChatId | string,
    messageId: ChatId,
  ): Promise<void> {
    try {
      await this.apiPost('deleteMessage', {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {
      // Cleanup failure is not critical.
    }
  }

  private async apiPost(
    method: string,
    body: Record<string, unknown>,
  ): Promise<any> {
    return this.transport.call(method, body);
  }

  private getPlatformUserId(message: BaleMessage): string {
    return String(message.from?.id ?? message.chat.id);
  }

  private getDisplayName(message: BaleMessage): string | null {
    const firstName = String(message.from?.first_name ?? '').trim();
    const lastName = String(message.from?.last_name ?? '').trim();

    const result = [firstName, lastName].filter(Boolean).join(' ').trim();

    return result || null;
  }

  private getEditorialChatId(): string | null {
    const rawValue = this.configService.get<string>(
      this.platform.toUpperCase() + '_EDITORIAL_CHAT_ID',
    );

    if (!rawValue || !rawValue.trim()) {
      return null;
    }

    const chatId = rawValue.trim();

    if (!chatId) {
      this.logger.warn(this.platform + ' editorial chat ID is invalid');
      return null;
    }

    return chatId;
  }

  /** Citizen reports from every platform are reviewed in the Bale editorial chat. */
  private getReportEditorialPeer(): BaleService {
    return this.peers.find((peer) => peer.platform === 'bale') ?? this;
  }

  private async sendEditorialNewReport(report: any): Promise<void> {
    const lines: string[] = [
      '🟠 گزارش مردمی جدید | ورودی تحریریه',
      '',
      '🆔 کد رهگیری: ' + String(report.trackingCode),
      '📌 وضعیت: ' + this.getStatusLabel(report.status),
      '📱 مبدأ: ' + String(report.user?.platform ?? this.platform),
      '👤 گزارش‌دهنده: ' + this.formatUserForEditorial(report.user),
      '',
      '📝 متن اولیه گزارش:',
      String(report.text ?? '').trim(),
      '',
      '🤖 وضعیت AI: تحلیل خودکار در حال انجام',
    ];

    await this.getReportEditorialPeer().sendEditorialMessage(lines.join('\n'));
  }

  private async sendEditorialReadyForReview(
    report: any,
    mediaCount = 0,
  ): Promise<void> {
    const text = this.buildEditorialReportCard(report, mediaCount);

    const editorialPeer = this.getReportEditorialPeer();
    const sent = await editorialPeer.sendEditorialMessage(
      text,
      editorialPeer.getEditorialPanelKeyboard(
        String(report.trackingCode),
        report.status,
        Boolean(report.isPublicDemand),
      ),
    );

    if (sent?.message_id) {
      try {
        await this.reportsService.setEditorialMessageReference(
          String(report.trackingCode),
          String(
            sent.chat?.id ?? editorialPeer.getEditorialChatId() ?? '',
          ),
          String(sent.message_id),
          editorialPeer.platform,
        );
      } catch (error: any) {
        this.logger.warn(
          'Could not save editorial message reference: ' +
            (error?.message ?? 'Unknown error'),
        );
      }
    }
  }

  private buildEditorialReportCard(
    report: any,
    mediaCountOverride?: number,
  ): string {
    const mediaCount =
      mediaCountOverride !== undefined
        ? mediaCountOverride
        : Array.isArray(report.media)
          ? report.media.length
          : 0;

    const lines: string[] = [
      '🟢 پرونده گزارش مردمی | کازرون خبر',
      '',
      '🆔 ' + String(report.trackingCode),
      '📌 وضعیت: ' + this.getStatusLabel(report.status),
      '⚡ اولویت: ' + this.getPriorityLabel(report.priority),
    ];

    if (report.category) {
      lines.push('🗂 دسته‌بندی: ' + String(report.category));
    }

    if (report.aiActionability) {
      lines.push(
        '🎯 قابلیت پیگیری: ' +
          this.getActionabilityLabel(report.aiActionability),
      );
    }

    lines.push('📎 مستندات: ' + this.toPersianNumber(mediaCount));

    if (report.assignedToDisplayName) {
      lines.push('👤 مسئول پیگیری: ' + String(report.assignedToDisplayName));
    } else {
      lines.push('👤 مسئول پیگیری: تعیین نشده');
    }

    if (report.currentDepartment) {
      lines.push('🏛 مرجع فعلی: ' + String(report.currentDepartment));
    }

    lines.push(
      '📤 دفعات پیگیری: ' +
        this.toPersianNumber(Number(report.followUpCount ?? 0)),
    );

    if (report.lastFollowUpAt) {
      lines.push(
        '🕒 آخرین پیگیری: ' + this.formatDateTime(report.lastFollowUpAt),
      );
    }

    if (report.followUpDueAt) {
      const due = new Date(report.followUpDueAt);
      const overdue = due.getTime() < Date.now();
      lines.push(
        (overdue ? '🚨 موعد گذشته: ' : '⏰ موعد پیگیری: ') +
          this.formatDateTime(report.followUpDueAt),
      );
    }

    if (report.isPublicDemand) {
      lines.push(
        '🌐 مطالبه عمومی: فعال',
        '📈 امتیاز مردمی: ' +
          this.toPersianNumber(Number(report.publicPriorityScore ?? 0)) +
          ' | 👍 حمایت: ' +
          this.toPersianNumber(Number(report.publicSupportCount ?? 0)) +
          ' | 👥 درگیر: ' +
          this.toPersianNumber(Number(report.publicAffectedCount ?? 0)),
        '💬 تجربه تأییدشده: ' +
          this.toPersianNumber(Number(report.publicExperienceCount ?? 0)) +
          ' | 📎 مستند تأییدشده: ' +
          this.toPersianNumber(Number(report.publicEvidenceCount ?? 0)) +
          ' | 🔔 دنبال‌کننده: ' +
          this.toPersianNumber(Number(report.publicFollowerCount ?? 0)),
      );
    }

    if (report.publishedAt) {
      lines.push(
        '📢 انتشار رسانه‌ای: ' + this.formatDateTime(report.publishedAt),
      );
    }

    if (report.aiNeedsHumanReview === true) {
      lines.push('👁 بررسی انسانی: ضروری');
    }

    lines.push('👥 گزارش‌دهنده: ' + this.formatUserForEditorial(report.user));

    if (report.aiSummary) {
      lines.push('', '🤖 جمع‌بندی هوشمند:', String(report.aiSummary).trim());
    }

    const departments = this.readStringList(report.aiSuggestedDepartments);

    if (departments.length > 0) {
      lines.push('', '🏛 دستگاه‌های مرتبط:', departments.join('، '));
    }

    const riskFlags = this.readStringList(report.aiRiskFlags);

    if (riskFlags.length > 0) {
      lines.push('', '🚩 ملاحظات تحریریه:', riskFlags.join(' | '));
    }

    const answerLines = this.getLatestAnswerLines(report.userAnswers);

    if (answerLines.length > 0) {
      lines.push('', '💬 پاسخ‌های تکمیلی شهروند:', ...answerLines);
    }

    if (report.finalResult) {
      lines.push('', '✅ نتیجه نهایی:', String(report.finalResult).trim());
    }

    const responses = Array.isArray(report.departmentResponses)
      ? report.departmentResponses
      : [];
    const latestResponse =
      responses.length > 0 ? responses[responses.length - 1] : null;

    if (latestResponse) {
      lines.push(
        '',
        '🏛 آخرین پاسخ دستگاه:',
        String(
          latestResponse.text ||
            latestResponse.caption ||
            'پاسخ مستند/فایل ثبت شده است.',
        ).trim(),
      );
    }

    const notes = Array.isArray(report.editorialNotes)
      ? report.editorialNotes
      : [];
    const lastNote = notes.length > 0 ? notes[notes.length - 1] : null;

    if (lastNote?.text) {
      lines.push('', '📝 آخرین یادداشت تحریریه:', String(lastNote.text).trim());
    }

    lines.push(
      '',
      '📝 متن اولیه گزارش:',
      String(report.text ?? '').trim(),
      '',
      '━━━━━━━━━━━━━━',
      '🎛 پنل مدیریت تحریریه',
    );

    return lines.join('\n').slice(0, 4096);
  }

  private async sendEditorialMessage(
    text: string,
    replyMarkup?: object,
  ): Promise<any | null> {
    const editorialChatId = this.getEditorialChatId();

    if (editorialChatId === null) {
      this.logger.warn(
        'Editorial chat is not configured. Message was not sent.',
      );
      return null;
    }

    try {
      const sent = await this.sendMessage(editorialChatId, text, replyMarkup);

      this.logger.log('Editorial message sent for chat ' + editorialChatId);

      return sent;
    } catch (error: any) {
      this.logger.error(
        'Editorial message failed: ' + (error?.message ?? 'Unknown error'),
      );
      return null;
    }
  }

  private isEditorialChat(chatId: ChatId | string): boolean {
    const configured = this.getEditorialChatId();

    return configured !== null && String(chatId) === configured;
  }

  private getEditorialSessionKey(
    chatId: ChatId | string,
    userId: number | string,
  ): string {
    return String(chatId) + ':' + String(userId);
  }

  private getEditorialOperatorName(user: BaleUser): string {
    const fullName = [
      String(user.first_name ?? '').trim(),
      String(user.last_name ?? '').trim(),
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (fullName) {
      return fullName;
    }

    if (user.username) {
      return '@' + String(user.username).trim();
    }

    return String(user.id);
  }

  private getConfiguredEditorialAdminIds(): string[] {
    const raw = this.configService.get<string>(
      this.platform.toUpperCase() + '_EDITORIAL_ADMIN_IDS',
    );

    if (!raw || !raw.trim()) {
      return [];
    }

    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private isEditorialOperatorAllowed(user: BaleUser): boolean {
    const configuredIds = this.getConfiguredEditorialAdminIds();

    if (configuredIds.length === 0) {
      // Editorial actions require explicit operator IDs on every platform.
      return false;
    }

    return configuredIds.includes(String(user.id));
  }

  private async handleEditorialCallback(
    query: BaleCallbackQuery,
  ): Promise<void> {
    const message = query.message;
    const data = String(query.data ?? '').trim();

    if (!message || !this.isEditorialChat(message.chat.id)) {
      await this.answerCallbackQuery(
        query.id,
        'این دکمه فقط در گروه تحریریه فعال است.',
      );
      return;
    }

    if (!this.isEditorialOperatorAllowed(query.from)) {
      await this.answerCallbackQuery(
        query.id,
        'شما مجوز انجام این عملیات را ندارید.',
        true,
      );
      return;
    }

    const parts = data.split(':');
    const action = parts[1] ?? '';
    const trackingCode = parts.slice(2).join(':').trim();

    if (!trackingCode) {
      await this.answerCallbackQuery(query.id, 'کد گزارش نامعتبر است.');
      return;
    }

    const operatorId = String(query.from.id);
    const operatorName = this.getEditorialOperatorName(query.from);
    const actor = operatorName + ' (' + operatorId + ')';

    try {
      if (action === 'ea' || action === 'er' || action === 'ep') {
        const result = await this.reportsService.moderatePublicExperience(
          trackingCode,
          action !== 'er',
          actor,
          action === 'ep',
        );
        await this.answerCallbackQuery(
          query.id,
          action === 'er'
            ? 'تجربه رد شد.'
            : action === 'ep'
              ? 'تجربه تأیید و به‌عنوان برگزیده سنجاق شد.'
              : 'تجربه تأیید و منتشر شد.',
        );
        await this.clearInlineKeyboard(
          String(message.chat.id),
          String(message.message_id),
        );
        await this.sendMessage(
          String(message.chat.id),
          [
            action === 'er'
              ? '❌ تجربه مردمی رد شد.'
              : action === 'ep'
                ? '📌 تجربه مردمی تأیید و برگزیده شد.'
                : '✅ تجربه مردمی تأیید شد.',
            '🆔 ' + String(result.trackingCode),
            action !== 'er'
              ? '📈 امتیاز مردمی جدید: ' +
                this.toPersianNumber(Number(result.metrics?.priorityScore ?? 0))
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      if (action === 'va' || action === 'vr') {
        const result = await this.reportsService.moderatePublicEvidence(
          trackingCode,
          action === 'va',
          actor,
        );
        await this.answerCallbackQuery(
          query.id,
          action === 'va' ? 'مستند تأیید شد.' : 'مستند رد شد.',
        );
        await this.clearInlineKeyboard(
          String(message.chat.id),
          String(message.message_id),
        );
        await this.sendMessage(
          String(message.chat.id),
          [
            action === 'va'
              ? '✅ مستند مردمی تأیید شد.'
              : '❌ مستند مردمی رد شد.',
            '🆔 ' + String(result.trackingCode),
            action === 'va'
              ? '📈 امتیاز مردمی جدید: ' +
                this.toPersianNumber(Number(result.metrics?.priorityScore ?? 0))
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      if (action === 'rv') {
        await this.reportsService.updateReportStatus(
          trackingCode,
          'IN_REVIEW',
          undefined,
          undefined,
          actor,
        );

        await this.answerCallbackQuery(query.id, 'وضعیت: در حال بررسی');

        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );

        return;
      }

      if (action === 'wr') {
        const report = await this.reportsService.updateReportStatus(
          trackingCode,
          'WAITING_RESPONSE',
          undefined,
          undefined,
          actor,
        );
        await this.answerCallbackQuery(query.id, 'وضعیت: منتظر پاسخ دستگاه');
        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        return;
      }

      if (action === 'du') {
        await this.answerCallbackQuery(query.id);
        await this.sendFollowUpDuePrompt(String(message.chat.id), trackingCode);
        return;
      }

      if (['d1', 'd3', 'd7', 'd14'].includes(action)) {
        const days = Number(action.slice(1));
        await this.reportsService.setFollowUpDue(trackingCode, days, actor);
        await this.answerCallbackQuery(query.id, 'موعد پیگیری ثبت شد.');
        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        return;
      }

      if (action === 'fu') {
        await this.reportsService.registerFollowUp(
          trackingCode,
          operatorId,
          operatorName,
        );
        await this.answerCallbackQuery(query.id, 'پیگیری مجدد ثبت شد.');
        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        await this.sendFollowUpDuePrompt(String(message.chat.id), trackingCode);
        return;
      }

      if (action === 'tl') {
        await this.answerCallbackQuery(query.id);
        await this.sendEditorialTimeline(trackingCode, String(message.chat.id));
        return;
      }

      if (action === 'up') {
        await this.reportsService.unpublishPublicDemand(
          trackingCode,
          operatorId,
          operatorName,
        );
        await this.answerCallbackQuery(query.id, 'نمایش عمومی متوقف شد.');
        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        return;
      }

      if (action === 'pb') {
        const report = await this.reportsService.markReportPublished(
          trackingCode,
          actor,
        );

        await this.answerCallbackQuery(query.id, 'گزارش منتشرشده ثبت شد.');

        await this.notifyCitizenOfStatus(report, 'PUBLISHED');

        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );

        return;
      }

      if (action === 'as') {
        await this.reportsService.assignReport(
          trackingCode,
          operatorId,
          operatorName,
        );

        await this.answerCallbackQuery(
          query.id,
          'مسئولیت پیگیری به شما واگذار شد.',
        );

        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );

        return;
      }

      if (action === 'dt') {
        await this.answerCallbackQuery(query.id);
        await this.sendEditorialDetails(trackingCode, String(message.chat.id));
        return;
      }

      if (action === 'rfh') {
        await this.answerCallbackQuery(query.id, 'بروزرسانی شد.');
        await this.refreshEditorialCardByCode(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        return;
      }

      if (action === 'ra') {
        await this.answerCallbackQuery(query.id, 'تحلیل مجدد آغاز شد…');
        await this.reanalyzeFromEditorial(
          trackingCode,
          String(message.chat.id),
          String(message.message_id),
        );
        return;
      }

      if (action === 'cn') {
        const key = this.getEditorialSessionKey(message.chat.id, query.from.id);
        this.editorialSessions.delete(key);
        await this.answerCallbackQuery(query.id, 'عملیات لغو شد.');
        return;
      }

      const inputActionMap: Record<string, EditorialInputAction> = {
        nt: 'note',
        rf: 'refer',
        rs: 'resolve',
        rj: 'reject',
        dr: 'response',
        pu: 'publicize',
      };

      const inputAction = inputActionMap[action];

      if (inputAction) {
        const key = this.getEditorialSessionKey(message.chat.id, query.from.id);

        this.editorialSessions.set(key, {
          trackingCode,
          action: inputAction,
          sourceChatId: String(message.chat.id),
          sourceMessageId: String(message.message_id),
        });

        await this.answerCallbackQuery(query.id, 'منتظر متن شما هستم.');

        await this.sendEditorialInputPrompt(
          String(message.chat.id),
          trackingCode,
          inputAction,
        );

        return;
      }

      await this.answerCallbackQuery(query.id, 'عملیات شناخته نشد.');
    } catch (error: any) {
      this.logger.error(
        'Editorial callback failed: ' + (error?.message ?? 'Unknown error'),
      );

      await this.answerCallbackQuery(
        query.id,
        'انجام عملیات با خطا روبه‌رو شد.',
        true,
      );
    }
  }

  private async sendEditorialInputPrompt(
    chatId: ChatId,
    trackingCode: string,
    action: EditorialInputAction,
  ): Promise<void> {
    const prompts: Record<EditorialInputAction, string[]> = {
      note: [
        '📝 ثبت یادداشت داخلی تحریریه',
        '',
        'یادداشت را در یک پیام ارسال کنید.',
        'این متن برای استفاده داخلی تحریریه ذخیره می‌شود.',
      ],
      refer: [
        '📤 ثبت ارجاع گزارش',
        '',
        'نام دستگاه/مرجع ارجاع و در صورت نیاز توضیح کوتاه را در یک پیام بنویسید.',
        'نمونه: شهرداری کازرون — ارجاع به واحد خدمات شهری',
      ],
      resolve: [
        '✅ ثبت نتیجه نهایی',
        '',
        'نتیجه پیگیری را کوتاه و روشن بنویسید.',
        'این متن به‌عنوان نتیجه نهایی پرونده ذخیره می‌شود.',
      ],
      reject: [
        '❌ رد گزارش',
        '',
        'دلیل رد گزارش را کوتاه و روشن بنویسید.',
        'این دلیل در سابقه پرونده ثبت می‌شود.',
      ],
      response: [
        '🏛 ثبت پاسخ دستگاه',
        '',
        'متن پاسخ دستگاه را ارسال کنید؛ یا نامه، عکس و فایل پاسخ را با کپشن بفرستید.',
        'پاسخ در تایم‌لاین پرونده ذخیره می‌شود و پرونده برای بررسی نتیجه باز می‌ماند.',
      ],
      publicize: [
        '🌐 انتشار در «مطالبات مردمی»',
        '',
        'خط اول: عنوان کوتاه و عمومی مطالبه',
        'از خط دوم به بعد: خلاصه‌ای که مردم ببینند.',
        '',
        'نام و اطلاعات شخصی گزارش‌دهنده را ننویسید. متن باید قابل انتشار و راستی‌آزمایی‌شده باشد.',
      ],
    };

    await this.sendMessage(
      chatId,
      [...prompts[action], '', '🆔 ' + trackingCode].join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: 'لغو عملیات',
              callback_data: 'adm:cn:' + trackingCode,
            },
          ],
        ],
      },
    );
  }

  private async handleEditorialTextInput(message: BaleMessage): Promise<void> {
    const user = message.from;
    const text = String(message.text ?? message.caption ?? '').trim();
    const hasMedia = this.hasSupportedMedia(message);

    if (!user || (!text && !hasMedia)) {
      return;
    }

    if (
      [
        '/kazerunyar',
        '/kz',
        '/newsadmin',
        '/news',
        '/ads',
        '/adadmin',
        '/advertising',
      ].includes(text)
    )
      return;

    if (text === '/kazerunyar' || text === '/kz') {
      if (!this.isEditorialOperatorAllowed(user)) {
        return;
      }
      await this.sendKazerunYarAdminMenu(String(message.chat.id));
      return;
    }

    if (text === '/newsadmin' || text === '/news') {
      if (!this.isEditorialOperatorAllowed(user)) {
        return;
      }
      await this.sendNewsAdminMenu(String(message.chat.id));
      return;
    }

    if (text === '/ads' || text === '/adadmin' || text === '/advertising') {
      if (!this.isEditorialOperatorAllowed(user)) {
        return;
      }
      await this.sendAdsAdminMenu(String(message.chat.id));
      return;
    }

    const key = this.getEditorialSessionKey(message.chat.id, user.id);

    const kzSession = this.kazerunYarEditorialSessions.get(key);
    if (kzSession) {
      await this.handleKazerunYarEditorialText(message, kzSession, key);
      return;
    }

    const newsSession = this.newsEditorialSessions.get(key);
    if (newsSession) {
      await this.handleNewsEditorialText(message, newsSession, key);
      return;
    }

    const adSession = this.adEditorialSessions.get(key);
    if (adSession) {
      await this.handleAdEditorialText(message, adSession, key);
      return;
    }

    const session = this.editorialSessions.get(key);

    if (!session) {
      return;
    }

    if (!this.isEditorialOperatorAllowed(user)) {
      this.editorialSessions.delete(key);
      return;
    }

    if (session.action !== 'response' && text.length < 2) {
      await this.sendMessage(
        message.chat.id,
        'متن خیلی کوتاه است؛ لطفاً توضیح روشن‌تری ارسال کنید.',
      );
      return;
    }

    const operatorId = String(user.id);
    const operatorName = this.getEditorialOperatorName(user);
    const actor = operatorName + ' (' + operatorId + ')';

    try {
      let report: any;

      if (session.action === 'note') {
        await this.reportsService.addEditorialNote(
          session.trackingCode,
          text,
          operatorId,
          operatorName,
          'note',
        );
        report = await this.reportsService.getReportForEditorial(
          session.trackingCode,
        );
      } else if (session.action === 'refer') {
        report = await this.reportsService.updateReportStatus(
          session.trackingCode,
          'REFERRED',
          text,
          undefined,
          actor,
        );
        await this.reportsService.setCurrentDepartment(
          session.trackingCode,
          text,
        );
        await this.reportsService.addEditorialNote(
          session.trackingCode,
          text,
          operatorId,
          operatorName,
          'referral',
        );
        report = await this.reportsService.getReportForEditorial(
          session.trackingCode,
        );
        await this.notifyCitizenOfStatus(report, 'REFERRED');
        await this.notifyPublicFollowersOfUpdate(
          report,
          '📤 مرحله پیگیری بروزرسانی شد',
          report.currentDepartment
            ? 'مرجع فعلی: ' + String(report.currentDepartment)
            : 'پرونده به مسیر پیگیری مرتبط ارجاع شد.',
        );
      } else if (session.action === 'resolve') {
        report = await this.reportsService.updateReportStatus(
          session.trackingCode,
          'RESOLVED',
          undefined,
          text,
          actor,
        );
        await this.reportsService.addEditorialNote(
          session.trackingCode,
          text,
          operatorId,
          operatorName,
          'result',
        );
        await this.notifyCitizenOfStatus(report, 'RESOLVED', text);
        await this.notifyPublicFollowersOfUpdate(
          report,
          '✅ برای این مطالبه نتیجه ثبت شد',
          text,
        );
      } else if (session.action === 'response') {
        const mediaData = hasMedia
          ? {
              ...this.getMediaPersistenceData(message),
              sourceChatId: String(message.chat.id),
              sourceMessageId: String(message.message_id),
            }
          : undefined;

        report = await this.reportsService.addDepartmentResponse(
          session.trackingCode,
          text,
          operatorId,
          operatorName,
          mediaData,
        );

        await this.notifyCitizenOfDepartmentResponse(report);
        await this.notifyPublicFollowersOfUpdate(
          report,
          '🏛 پاسخ جدید در پرونده ثبت شد',
          text || 'یک پاسخ مستند از مسیر دستگاه/مرجع مرتبط ثبت شده است.',
        );
      } else if (session.action === 'publicize') {
        const lines = text
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean);
        const title = lines.shift() ?? '';
        const summary = lines.join('\n').trim();

        if (title.length < 5 || summary.length < 10) {
          await this.sendMessage(
            message.chat.id,
            [
              '⚠️ برای انتشار عمومی، عنوان و خلاصه لازم است.',
              '',
              'خط اول: عنوان',
              'خط دوم به بعد: خلاصه عمومی مطالبه',
            ].join('\n'),
          );
          return;
        }

        report = await this.reportsService.publishPublicDemand(
          session.trackingCode,
          title,
          summary,
          operatorId,
          operatorName,
        );

        await this.notifyCitizenOfPublicDemand(report);
      } else {
        report = await this.reportsService.updateReportStatus(
          session.trackingCode,
          'REJECTED',
          text,
          undefined,
          actor,
        );
        await this.reportsService.addEditorialNote(
          session.trackingCode,
          text,
          operatorId,
          operatorName,
          'rejection',
        );
        await this.notifyCitizenOfStatus(report, 'REJECTED', text);
      }

      this.editorialSessions.delete(key);

      await this.refreshEditorialCardByCode(
        session.trackingCode,
        session.sourceChatId,
        session.sourceMessageId,
      );

      await this.sendMessage(
        message.chat.id,
        '✅ عملیات برای ' + session.trackingCode + ' ثبت شد.',
      );
    } catch (error: any) {
      this.logger.error(
        'Editorial text input failed: ' + (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        message.chat.id,
        '⚠️ ثبت عملیات با خطا روبه‌رو شد. دوباره تلاش کنید.',
      );
    }
  }

  private getEditorialPanelKeyboard(
    trackingCode: string,
    status: unknown,
    isPublicDemand = false,
  ): object {
    const current = String(status ?? '').toUpperCase();
    const mark = (target: string, label: string) =>
      current === target ? label + ' ✓' : label;

    return {
      inline_keyboard: [
        [
          {
            text: mark('IN_REVIEW', '👁 در حال بررسی'),
            callback_data: 'adm:rv:' + trackingCode,
          },
          {
            text: '🔁 ارجاع / تغییر مرجع',
            callback_data: 'adm:rf:' + trackingCode,
          },
        ],
        [
          {
            text: mark('WAITING_RESPONSE', '⏳ منتظر پاسخ'),
            callback_data: 'adm:wr:' + trackingCode,
          },
          {
            text: '🏛 ثبت پاسخ دستگاه',
            callback_data: 'adm:dr:' + trackingCode,
          },
        ],
        [
          {
            text: '⏰ موعد پیگیری',
            callback_data: 'adm:du:' + trackingCode,
          },
          {
            text: '📤 پیگیری مجدد',
            callback_data: 'adm:fu:' + trackingCode,
          },
        ],
        [
          {
            text: mark('RESOLVED', '✅ حل شد'),
            callback_data: 'adm:rs:' + trackingCode,
          },
          {
            text: mark('PUBLISHED', '📢 منتشر شد'),
            callback_data: 'adm:pb:' + trackingCode,
          },
        ],
        [
          {
            text: isPublicDemand
              ? '🛑 توقف نمایش عمومی'
              : '🌐 انتشار در مطالبات',
            callback_data:
              (isPublicDemand ? 'adm:up:' : 'adm:pu:') + trackingCode,
          },
          {
            text: mark('REJECTED', '❌ رد گزارش'),
            callback_data: 'adm:rj:' + trackingCode,
          },
        ],
        [
          {
            text: '👤 مسئولیت با من',
            callback_data: 'adm:as:' + trackingCode,
          },
          {
            text: '📝 یادداشت',
            callback_data: 'adm:nt:' + trackingCode,
          },
        ],
        [
          {
            text: '🧭 تایم‌لاین پرونده',
            callback_data: 'adm:tl:' + trackingCode,
          },
          {
            text: '🤖 تحلیل مجدد',
            callback_data: 'adm:ra:' + trackingCode,
          },
        ],
        [
          {
            text: '📋 جزئیات پرونده',
            callback_data: 'adm:dt:' + trackingCode,
          },
          {
            text: '🔄 تازه‌سازی',
            callback_data: 'adm:rfh:' + trackingCode,
          },
        ],
      ],
    };
  }

  private async refreshEditorialCardByCode(
    trackingCode: string,
    chatId: ChatId,
    messageId: ChatId,
  ): Promise<void> {
    const report =
      await this.reportsService.getReportForEditorial(trackingCode);

    await this.refreshEditorialCard(report, chatId, messageId);
  }

  private async refreshEditorialCard(
    report: any,
    chatId: ChatId,
    messageId: ChatId,
  ): Promise<void> {
    const text = this.buildEditorialReportCard(report);
    const keyboard = this.getEditorialPanelKeyboard(
      String(report.trackingCode),
      report.status,
      Boolean(report.isPublicDemand),
    );

    try {
      await this.apiPost('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: keyboard,
      });
    } catch (error: any) {
      this.logger.warn(
        'editMessageText failed; sending refreshed card: ' +
          (error?.message ?? 'Unknown error'),
      );

      const sent = await this.sendMessage(chatId, text, keyboard);

      if (sent?.message_id) {
        await this.reportsService.setEditorialMessageReference(
          String(report.trackingCode),
          String(chatId),
          String(sent.message_id),
          this.platform,
        );
      }
    }
  }

  private async sendEditorialDetails(
    trackingCode: string,
    chatId: ChatId,
  ): Promise<void> {
    const report =
      await this.reportsService.getReportForEditorial(trackingCode);

    const lines: string[] = [
      '📋 جزئیات پرونده',
      '',
      '🆔 ' + trackingCode,
      '📌 وضعیت: ' + this.getStatusLabel(report.status),
      '⚡ اولویت: ' + this.getPriorityLabel(report.priority),
      '📎 مستندات: ' +
        this.toPersianNumber(
          Array.isArray(report.media) ? report.media.length : 0,
        ),
    ];

    if (report.assignedToDisplayName) {
      lines.push('👤 مسئول پیگیری: ' + String(report.assignedToDisplayName));
    }

    if (report.currentDepartment) {
      lines.push('🏛 مرجع فعلی: ' + String(report.currentDepartment));
    }

    lines.push(
      '📤 دفعات پیگیری: ' +
        this.toPersianNumber(Number(report.followUpCount ?? 0)),
    );

    if (report.followUpDueAt) {
      lines.push(
        '⏰ موعد پیگیری: ' + this.formatDateTime(report.followUpDueAt),
      );
    }

    if (report.isPublicDemand) {
      lines.push(
        '🌐 مطالبه عمومی: فعال',
        '📈 امتیاز مردمی: ' +
          this.toPersianNumber(Number(report.publicPriorityScore ?? 0)),
        '👍 حمایت: ' +
          this.toPersianNumber(Number(report.publicSupportCount ?? 0)) +
          ' | 👥 درگیر: ' +
          this.toPersianNumber(Number(report.publicAffectedCount ?? 0)),
        '💬 تجربه: ' +
          this.toPersianNumber(Number(report.publicExperienceCount ?? 0)) +
          ' | 📎 مستند: ' +
          this.toPersianNumber(Number(report.publicEvidenceCount ?? 0)) +
          ' | 🔔 دنبال‌کننده: ' +
          this.toPersianNumber(Number(report.publicFollowerCount ?? 0)),
      );
    }

    const history = Array.isArray(report.statusHistory)
      ? report.statusHistory
      : [];

    if (history.length > 0) {
      lines.push('', '🕘 تاریخچه وضعیت:');
      history.slice(-8).forEach((item: any) => {
        lines.push(
          '• ' +
            this.getStatusLabel(item.toStatus) +
            ' — ' +
            this.formatDateTime(item.createdAt) +
            (item.changedBy ? ' — ' + String(item.changedBy) : ''),
        );
      });
    }

    const deviceResponses = Array.isArray(report.departmentResponses)
      ? report.departmentResponses
      : [];

    if (deviceResponses.length > 0) {
      lines.push('', '🏛 پاسخ‌های اخیر دستگاه:');
      deviceResponses.slice(-5).forEach((response: any) => {
        lines.push(
          '• ' +
            String(
              response.text || response.caption || 'پاسخ مستند/فایل',
            ).trim() +
            ' — ' +
            this.formatDateTime(response.createdAt),
        );
      });
    }

    const notes = Array.isArray(report.editorialNotes)
      ? report.editorialNotes
      : [];

    if (notes.length > 0) {
      lines.push('', '📝 یادداشت‌های اخیر:');
      notes.slice(-5).forEach((note: any) => {
        lines.push(
          '• ' +
            String(note.text) +
            (note.createdByDisplayName
              ? ' — ' + String(note.createdByDisplayName)
              : ''),
        );
      });
    }

    await this.sendMessage(chatId, lines.join('\n').slice(0, 4096));
  }

  private async sendFollowUpDuePrompt(
    chatId: ChatId,
    trackingCode: string,
  ): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '⏰ تعیین موعد پیگیری بعدی',
        '',
        'چه زمانی دوباره این پرونده یادآوری شود؟',
        'با رسیدن موعد و باز ماندن پرونده، ربات به گروه تحریریه هشدار می‌دهد.',
        '',
        '🆔 ' + trackingCode,
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: 'فردا', callback_data: 'adm:d1:' + trackingCode },
            { text: '۳ روز', callback_data: 'adm:d3:' + trackingCode },
          ],
          [
            { text: '۷ روز', callback_data: 'adm:d7:' + trackingCode },
            { text: '۱۴ روز', callback_data: 'adm:d14:' + trackingCode },
          ],
          [{ text: 'لغو', callback_data: 'adm:cn:' + trackingCode }],
        ],
      },
    );
  }

  private async sendEditorialTimeline(
    trackingCode: string,
    chatId: ChatId,
  ): Promise<void> {
    const report =
      await this.reportsService.getReportForEditorial(trackingCode);
    const events: Array<{ at: Date; text: string }> = [];

    (Array.isArray(report.statusHistory) ? report.statusHistory : []).forEach(
      (item: any) => {
        events.push({
          at: new Date(item.createdAt),
          text:
            '📌 ' +
            this.getStatusLabel(item.toStatus) +
            (item.changedBy ? ' — ' + String(item.changedBy) : ''),
        });
      },
    );

    (Array.isArray(report.editorialNotes) ? report.editorialNotes : []).forEach(
      (item: any) => {
        events.push({
          at: new Date(item.createdAt),
          text:
            '📝 ' +
            String(item.text).trim() +
            (item.createdByDisplayName
              ? ' — ' + String(item.createdByDisplayName)
              : ''),
        });
      },
    );

    (Array.isArray(report.departmentResponses)
      ? report.departmentResponses
      : []
    ).forEach((item: any) => {
      events.push({
        at: new Date(item.createdAt),
        text:
          '🏛 پاسخ دستگاه — ' +
          String(item.text || item.caption || 'مستند/فایل پاسخ').trim(),
      });
    });

    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    const lines = [
      '🧭 تایم‌لاین پرونده',
      '',
      '🆔 ' + trackingCode,
      '',
      ...events
        .slice(-20)
        .map(
          (event) => '• ' + this.formatDateTime(event.at) + '\n  ' + event.text,
        ),
    ];

    await this.sendMessage(chatId, lines.join('\n').slice(0, 4096));
  }

  private startFollowUpReminderLoop(): void {
    if (this.followUpReminderTimer) {
      clearInterval(this.followUpReminderTimer);
    }

    this.followUpReminderTimer = setInterval(
      () => {
        void this.checkFollowUpReminders();
      },
      10 * 60 * 1000,
    );

    this.reminderStartupTimer = setTimeout(() => {
      if (this.running) void this.checkFollowUpReminders();
    }, 20 * 1000);
  }

  private async checkFollowUpReminders(): Promise<void> {
    const editorialPeer = this.getReportEditorialPeer();
    const editorialChatId = editorialPeer.getEditorialChatId();

    if (editorialChatId === null) {
      return;
    }

    try {
      const reports = await this.reportsService.getOverdueFollowUps(
        this.platform,
      );

      for (const report of reports) {
        if (
          !report.followUpDueAt ||
          (report.user?.platform && report.user.platform !== this.platform)
        ) {
          continue;
        }

        const dueAt = new Date(report.followUpDueAt);
        const overdueDays = Math.max(
          0,
          Math.floor((Date.now() - dueAt.getTime()) / (24 * 60 * 60 * 1000)),
        );

        await editorialPeer.sendEditorialMessage(
          [
            '🚨 یادآوری پیگیری پرونده',
            '',
            '🆔 ' + String(report.trackingCode),
            '📌 وضعیت: ' + this.getStatusLabel(report.status),
            report.currentDepartment
              ? '🏛 مرجع: ' + String(report.currentDepartment)
              : '🏛 مرجع: تعیین نشده',
            report.assignedToDisplayName
              ? '👤 مسئول: ' + String(report.assignedToDisplayName)
              : '👤 مسئول: تعیین نشده',
            '⏰ موعد: ' + this.formatDateTime(report.followUpDueAt),
            overdueDays > 0
              ? '⚠️ تأخیر: ' + this.toPersianNumber(overdueDays) + ' روز'
              : '⚠️ موعد پیگیری رسیده است.',
          ].join('\n'),
          {
            inline_keyboard: [
              [
                {
                  text: '📤 پیگیری مجدد',
                  callback_data: 'adm:fu:' + report.trackingCode,
                },
                {
                  text: '⏰ تمدید ۳ روز',
                  callback_data: 'adm:d3:' + report.trackingCode,
                },
              ],
              [
                {
                  text: '📋 پرونده',
                  callback_data: 'adm:dt:' + report.trackingCode,
                },
              ],
            ],
          },
        );

        await this.reportsService.markOverdueNotified(
          String(report.trackingCode),
        );
      }
    } catch (error: any) {
      this.logger.warn(
        'Follow-up reminder check failed: ' +
          (error?.message ?? 'Unknown error'),
      );
    }
  }

  private async sendPublicDemands(
    chatId: ChatId,
    platformUserId: string,
    rawView = 'popular',
    rawPage = 0,
  ): Promise<void> {
    const view = [
      'popular',
      'newest',
      'active',
      'resolved',
      'followed',
    ].includes(rawView)
      ? rawView
      : 'popular';
    const page = Math.max(0, Math.min(10000, Math.floor(rawPage)));
    const results = await this.reportsService.getPublicDemands(
      this.platform,
      platformUserId,
      7,
      page * 6,
      view,
    );
    const demands = results.slice(0, 6);
    const labels: Record<string, string> = {
      popular: 'پرحمایت',
      newest: 'تازه‌ترین',
      active: 'در حال پیگیری',
      resolved: 'دارای نتیجه',
      followed: 'دنبال‌شده‌های من',
    };
    const lines = [
      'مطالبات مردمی کازرون',
      labels[view] + ' · صفحه ' + this.toPersianNumber(page + 1),
      '',
      demands.length
        ? 'برای مشاهده و مشارکت، یک مطالبه را انتخاب کنید.'
        : 'در این فهرست هنوز مطالبه‌ای وجود ندارد.',
      '',
      'فقط پرونده‌های تأییدشده منتشر می‌شوند؛ هویت شهروندان نمایش داده نمی‌شود.',
    ];
    await this.sendMessage(
      chatId,
      lines.join('\n'),
      this.getPublicDemandListKeyboard(demands, view, page, results.length > 6),
    );
  }

  private async sendPublicDemandDetails(
    chatId: ChatId,
    platformUserId: string,
    trackingCode: string,
  ): Promise<void> {
    try {
      const demand = await this.reportsService.getPublicDemandForUser(
        trackingCode,
        this.platform,
        platformUserId,
      );

      await this.sendMessage(
        chatId,
        this.buildPublicDemandCard(demand),
        this.getPublicDemandCardKeyboard(demand),
      );
    } catch {
      await this.sendMessage(
        chatId,
        'این مطالبه دیگر در فهرست عمومی قرار ندارد.',
        this.getSimpleHomeInlineKeyboard(),
      );
    }
  }

  private async refreshPublicDemandCard(
    chatId: ChatId,
    messageId: ChatId,
    platformUserId: string,
    trackingCode: string,
  ): Promise<void> {
    const demand = await this.reportsService.getPublicDemandForUser(
      trackingCode,
      this.platform,
      platformUserId,
    );
    const text = this.buildPublicDemandCard(demand);
    const keyboard = this.getPublicDemandCardKeyboard(demand);

    if (String(messageId) !== '0' && String(messageId) !== '') {
      try {
        await this.apiPost('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: keyboard,
        });
        return;
      } catch {
        // Fall back to a new message.
      }
    }

    await this.sendMessage(chatId, text, keyboard);
  }

  private getPublicPriorityLabel(score: unknown): string {
    const value = Number(score ?? 0);
    if (value >= 50) return '🔥 بسیار بالا';
    if (value >= 25) return '🔴 بالا';
    if (value >= 10) return '🟠 در حال رشد';
    if (value >= 4) return '🟡 متوسط';
    return '⚪ تازه';
  }

  private buildPublicDemandCard(demand: any): string {
    const count = (value: unknown) => this.toPersianNumber(Number(value ?? 0));
    return [
      '📣 ' + String(demand.publicTitle ?? 'مطالبه مردمی'),
      '',
      String(demand.publicSummary ?? '')
        .trim()
        .slice(0, 1000),
      '',
      'وضعیت: ' + this.getStatusLabel(demand.status),
      demand.currentDepartment
        ? 'مرجع پیگیری: ' + String(demand.currentDepartment)
        : '',
      '',
      '👍 ' +
        count(demand.publicSupportCount) +
        ' حمایت  ·  👥 ' +
        count(demand.publicAffectedCount) +
        ' شهروند درگیر',
      '💬 ' +
        count(demand.publicExperienceCount) +
        ' تجربه  ·  📎 ' +
        count(demand.publicEvidenceCount) +
        ' مستند تأییدشده',
      demand.finalResult
        ? '\nنتیجه: ' + String(demand.finalResult).trim().slice(0, 500)
        : '',
      '',
      '🆔 ' + String(demand.trackingCode),
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }

  private async sendDemandDetails(chatId: ChatId, demand: any): Promise<void> {
    const latest = demand.departmentResponses?.[0];
    const text = [
      'جزئیات پیگیری',
      String(demand.publicTitle ?? ''),
      '',
      'وضعیت: ' + this.getStatusLabel(demand.status),
      demand.currentDepartment ? 'مرجع: ' + demand.currentDepartment : '',
      demand.publicPublishedAt
        ? 'انتشار: ' + this.formatDateTime(demand.publicPublishedAt)
        : '',
      'دنبال‌کنندگان: ' +
        this.toPersianNumber(Number(demand.publicFollowerCount ?? 0)),
      '',
      latest?.text
        ? 'آخرین پاسخ ثبت‌شده:\n' + String(latest.text).slice(0, 2000)
        : 'هنوز پاسخی از مرجع پیگیری ثبت نشده است.',
      demand.finalResult
        ? '\nنتیجه ثبت‌شده:\n' + String(demand.finalResult).slice(0, 2000)
        : '',
      '',
      'امتیاز مشارکت: ' +
        this.toPersianNumber(Number(demand.publicPriorityScore ?? 0)),
      'حمایت، شهروندان درگیر، تجربه و مستند تأییدشده در امتیاز اثر دارند. فوریت ایمنی جداگانه بررسی می‌شود.',
    ]
      .filter(Boolean)
      .join('\n');
    await this.sendMessage(chatId, text, {
      inline_keyboard: [
        [
          {
            text: 'بازگشت به مطالبه',
            callback_data: 'usr:dm:' + demand.trackingCode,
          },
        ],
      ],
    });
  }

  private async sendDemandExperiences(
    chatId: ChatId,
    demand: any,
  ): Promise<void> {
    const experiences = demand.publicExperiences ?? [];
    const lines = ['تجربه‌های تأییدشده', String(demand.publicTitle ?? ''), ''];
    for (const [index, item] of experiences.entries()) {
      lines.push(
        (item.isPinned ? '📌 ' : '') +
          this.toPersianNumber(index + 1) +
          ') ' +
          String(item.text).slice(0, 700),
        '',
      );
    }
    if (!experiences.length)
      lines.push('هنوز تجربه‌ای برای نمایش تأیید نشده است.');
    const rows = experiences.map((item: any, index: number) => [
      {
        text:
          (item.likedByUser ? '💚 ' : '👍 ') +
          'تجربه ' +
          this.toPersianNumber(index + 1) +
          ' (' +
          this.toPersianNumber(item.likeCount) +
          ')',
        callback_data: 'usr:ev:' + item.id,
      },
      { text: '🚩 گزارش تخلف', callback_data: 'usr:fg:' + item.id },
    ]);
    rows.push([
      {
        text: '💬 ثبت تجربه من',
        callback_data: 'usr:xp:' + demand.trackingCode,
      },
    ]);
    rows.push([
      {
        text: 'بازگشت به مطالبه',
        callback_data: 'usr:dm:' + demand.trackingCode,
      },
    ]);
    await this.sendMessage(chatId, lines.join('\n'), { inline_keyboard: rows });
  }

  private getPublicDemandListKeyboard(
    demands: any[],
    view = 'popular',
    page = 0,
    hasNext = false,
  ): object {
    const rows: any[][] = [
      [
        {
          text: (view === 'popular' ? '✓ ' : '') + 'پرحمایت',
          callback_data: 'usr:dl:popular:0',
        },
        {
          text: (view === 'newest' ? '✓ ' : '') + 'تازه‌ترین',
          callback_data: 'usr:dl:newest:0',
        },
      ],
      [
        {
          text: (view === 'active' ? '✓ ' : '') + 'در حال پیگیری',
          callback_data: 'usr:dl:active:0',
        },
        {
          text: (view === 'resolved' ? '✓ ' : '') + 'دارای نتیجه',
          callback_data: 'usr:dl:resolved:0',
        },
      ],
      [
        {
          text: (view === 'followed' ? '✓ ' : '') + '🔔 دنبال‌شده‌های من',
          callback_data: 'usr:dl:followed:0',
        },
      ],
      ...demands.map((item: any, index: number) => [
        {
          text:
            this.toPersianNumber(page * 6 + index + 1) +
            ') ' +
            String(item.publicTitle ?? 'مطالبه').slice(0, 48),
          callback_data: 'usr:dm:' + item.trackingCode,
        },
      ]),
    ];
    const pagination: any[] = [];
    if (page > 0)
      pagination.push({
        text: 'صفحه قبل',
        callback_data: 'usr:dl:' + view + ':' + (page - 1),
      });
    if (hasNext)
      pagination.push({
        text: 'صفحه بعد',
        callback_data: 'usr:dl:' + view + ':' + (page + 1),
      });
    if (pagination.length) rows.push(pagination);
    rows.push([
      { text: '🔄 تازه‌سازی', callback_data: 'usr:dl:' + view + ':' + page },
      { text: '🏠 خانه', callback_data: 'usr:home' },
    ]);
    return { inline_keyboard: rows };
  }

  private getPublicDemandCardKeyboard(demand: any): object {
    const code = String(demand.trackingCode);
    const rows: any[][] = [
      [
        {
          text: demand.supportedByUser ? '💚 حمایت کرده‌ام' : '👍 حمایت می‌کنم',
          callback_data: 'usr:sp:' + code,
        },
        {
          text: demand.affectedByUser ? '✓ من هم درگیرم' : '👥 من هم درگیرم',
          callback_data: 'usr:ax:' + code,
        },
      ],
      [
        {
          text: demand.followedByUser ? '🔔 دنبال می‌کنم ✓' : '🔔 دنبال کردن',
          callback_data: 'usr:fw:' + code,
        },
        { text: 'جزئیات پیگیری', callback_data: 'usr:di:' + code },
      ],
      [
        { text: '💬 تجربه‌های مردم', callback_data: 'usr:dx:' + code },
        { text: '📎 ارسال مستند', callback_data: 'usr:ed:' + code },
      ],
    ];
    if (demand.status === 'RESOLVED')
      rows.push([
        {
          text:
            (demand.resolutionVoteByUser === 'SOLVED' ? '✓ ' : '') +
            '✅ واقعاً حل شده',
          callback_data: 'usr:rv:s:' + code,
        },
        {
          text:
            (demand.resolutionVoteByUser === 'UNRESOLVED' ? '✓ ' : '') +
            'هنوز پابرجاست',
          callback_data: 'usr:rv:u:' + code,
        },
      ]);
    rows.push([
      { text: 'همه مطالبات', callback_data: 'usr:demands' },
      { text: '🏠 خانه', callback_data: 'usr:home' },
    ]);
    return { inline_keyboard: rows };
  }

  private async notifyPublicFollowersOfUpdate(
    report: any,
    title: string,
    detail?: string,
    localOnly = false,
  ): Promise<void> {
    if (!report?.isPublicDemand || !report?.trackingCode) return;

    if (!localOnly) {
      for (const peer of this.peers) {
        if (peer !== this)
          await peer.notifyPublicFollowersOfUpdate(report, title, detail, true);
      }
    }
    try {
      for (let offset = 0; ; offset += 100) {
        const followers = await this.reportsService.getPublicFollowers(
          String(report.trackingCode),
          this.platform,
          offset,
        );

        const originalReporterId =
          report.user?.platform === this.platform
            ? String(report.user.platformUserId ?? '')
            : '';

        for (const follower of followers) {
          const targetId = String(follower.platformUserId ?? '').trim();
          if (!targetId || targetId === originalReporterId) continue;

          const chatId = await this.reportsService.getMessengerChatId(
            this.platform,
            targetId,
          );
          if (!chatId) continue;

          try {
            await this.sendMessage(
              chatId,
              [
                '🔔 بروزرسانی مطالبه‌ای که دنبال می‌کنید',
                '',
                '📣 ' + String(report.publicTitle ?? report.trackingCode),
                String(title ?? '').trim(),
                detail ? String(detail).trim().slice(0, 700) : '',
                '',
                'برای مشاهده وضعیت کامل، دکمه زیر را بزنید.',
              ]
                .filter(Boolean)
                .join('\n'),
              {
                inline_keyboard: [
                  [
                    {
                      text: '🔥 مشاهده مطالبه',
                      callback_data: 'usr:dm:' + String(report.trackingCode),
                    },
                  ],
                ],
              },
            );
          } catch {
            // A single blocked/unavailable account must not stop other notifications.
          }
        }
        if (followers.length < 100) break;
      }
    } catch (error: any) {
      this.logger.warn(
        'Public follower notification failed: ' +
          (error?.message ?? 'Unknown error'),
      );
    }
  }

  private async notifyCitizenOfDepartmentResponse(report: any): Promise<void> {
    if (!report?.user) return;
    if (report.user.platform !== this.platform) {
      const peer = this.peers.find(
        (item) => item.platform === report.user.platform,
      );
      if (peer) await peer.notifyCitizenOfDepartmentResponse(report);
      return;
    }
    const chatId = await this.reportsService.getMessengerChatId(
      this.platform,
      String(report.user.platformUserId),
    );
    if (!chatId) return;

    try {
      await this.sendMessage(
        chatId,
        [
          '🏛 بروزرسانی پرونده شما',
          '',
          'برای گزارش با کد ' +
            String(report.trackingCode) +
            ' یک پاسخ از مسیر دستگاه/مرجع مرتبط در پرونده ثبت شده است.',
          'تحریریه پاسخ را بررسی می‌کند و نتیجه نهایی پس از بررسی در وضعیت پرونده ثبت خواهد شد.',
        ].join('\n'),
        this.getStatusResultInlineKeyboard(String(report.trackingCode)),
      );
    } catch {}
  }

  private async notifyCitizenOfPublicDemand(report: any): Promise<void> {
    if (!report?.user) return;
    if (report.user.platform !== this.platform) {
      const peer = this.peers.find(
        (item) => item.platform === report.user.platform,
      );
      if (peer) await peer.notifyCitizenOfPublicDemand(report);
      return;
    }
    const chatId = await this.reportsService.getMessengerChatId(
      this.platform,
      String(report.user.platformUserId),
    );
    if (!chatId) return;

    try {
      await this.sendMessage(
        chatId,
        [
          '🌐 گزارش شما وارد بخش «مطالبات مردمی» شد.',
          '',
          'تحریریه نسخه عمومی و بدون نمایش هویت گزارش‌دهنده را منتشر کرده است.',
          'شهروندان می‌توانند از این مطالبه حمایت کنند و مطالبات دارای حمایت بیشتر در رتبه بالاتری نمایش داده می‌شوند.',
          '',
          '🆔 ' + String(report.trackingCode),
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '🔥 مشاهده مطالبات', callback_data: 'usr:demands' }],
          ],
        },
      );
    } catch {}
  }

  private async reanalyzeFromEditorial(
    trackingCode: string,
    chatId: ChatId,
    messageId: ChatId,
  ): Promise<void> {
    try {
      const result =
        await this.reportsService.analyzeReportWithAi(trackingCode);

      const report =
        await this.reportsService.getReportForEditorial(trackingCode);

      await this.refreshEditorialCard(report, chatId, messageId);

      const questions = this.normalizeQuestions(result?.analysis?.questions);

      if (
        result?.analysis?.isComplete !== true &&
        questions.length > 0 &&
        report.user
      ) {
        const peer =
          report.user.platform === this.platform
            ? this
            : this.peers.find(
                (item) => item.platform === report.user?.platform,
              );
        if (peer) await peer.requestCitizenInfo(report, questions);
      }

      await this.sendMessage(
        chatId,
        '🤖 تحلیل مجدد گزارش ' + trackingCode + ' تکمیل شد.',
      );
    } catch (error: any) {
      this.logger.error(
        'Editorial reanalysis failed: ' + (error?.message ?? 'Unknown error'),
      );

      await this.sendMessage(
        chatId,
        '⚠️ تحلیل مجدد این گزارش با خطا روبه‌رو شد.',
      );
    }
  }

  private async requestCitizenInfo(
    report: any,
    questions: string[],
  ): Promise<void> {
    const citizenChatId = await this.reportsService.getMessengerChatId(
      this.platform,
      String(report.user.platformUserId),
    );
    if (!citizenChatId) return;
    const current = this.sessions.get(citizenChatId);
    if (
      current &&
      'trackingCode' in current &&
      current.trackingCode !== report.trackingCode
    ) {
      await this.sendMessage(
        citizenChatId,
        'تحریریه برای گزارش ' +
          report.trackingCode +
          ' به اطلاعات بیشتری نیاز دارد. پس از پایان ثبت فعلی، گزارش را پیگیری کنید.',
        this.getStatusResultInlineKeyboard(report.trackingCode),
      );
      return;
    }
    const session: AwaitingAiAnswersSession = {
      mode: 'awaiting_ai_answers',
      trackingCode: report.trackingCode,
      questions,
      answers: [],
      questionIndex: 0,
      mediaCount: report.media?.length ?? 0,
    };
    this.sessions.set(citizenChatId, session);
    this.saveState();
    await this.sendMessage(
      citizenChatId,
      'تحریریه برای ادامه پیگیری به اطلاعات تکمیلی نیاز دارد.\n🆔 ' +
        report.trackingCode,
    );
    await this.sendAiQuestion(citizenChatId, session);
  }

  private async notifyCitizenOfStatus(
    report: any,
    status: string,
    detail?: string,
  ): Promise<void> {
    if (!report?.user) return;
    if (report.user.platform !== this.platform) {
      const peer = this.peers.find(
        (item) => item.platform === report.user.platform,
      );
      if (peer) await peer.notifyCitizenOfStatus(report, status, detail);
      return;
    }
    const chatId = await this.reportsService.getMessengerChatId(
      this.platform,
      String(report.user.platformUserId),
    );

    if (!chatId) {
      return;
    }

    const messages: Record<string, string[]> = {
      REFERRED: [
        '📤 گزارش شما وارد مرحله ارجاع و پیگیری شد.',
        'تحریریه موضوع را برای پیگیری از مسیر مرتبط ثبت کرده است.',
      ],
      RESOLVED: [
        '✅ برای گزارش شما نتیجه ثبت شد.',
        detail ? 'نتیجه: ' + detail : '',
      ],
      REJECTED: [
        'ℹ️ بررسی گزارش شما در این مرحله متوقف شد.',
        detail ? 'توضیح: ' + detail : '',
      ],
      PUBLISHED: [
        '📢 وضعیت گزارش شما به «منتشر شده» تغییر کرد.',
        'از همراهی شما با کازرون خبر سپاسگزاریم.',
      ],
    };

    const body = messages[status];

    if (!body) {
      return;
    }

    try {
      await this.sendMessage(
        chatId,
        [
          '🔔 بروزرسانی گزارش مردمی',
          '',
          '🆔 ' + String(report.trackingCode),
          '📌 وضعیت: ' + this.getStatusLabel(status),
          '',
          ...body.filter(Boolean),
          '',
          '✨ کازرون خبر؛ روایت اول کازرون',
        ].join('\n'),
        this.getStatusResultInlineKeyboard(String(report.trackingCode)),
      );
    } catch (error: any) {
      this.logger.warn(
        'Citizen status notification failed: ' +
          (error?.message ?? 'Unknown error'),
      );
    }
  }

  private formatUserForEditorial(user: any): string {
    if (!user) {
      return 'نامشخص';
    }

    const parts = [
      String(user.displayName ?? '').trim(),
      user.username ? '@' + String(user.username).trim() : '',
      user.platformUserId ? '(' + String(user.platformUserId).trim() + ')' : '',
    ].filter(Boolean);

    const result = parts.join(' ').trim();

    return result || 'نامشخص';
  }

  private readStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item: unknown) => String(item).trim()).filter(Boolean);
  }

  private getLatestAnswerLines(value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [];
    }

    const rounds = Array.isArray((value as any).rounds)
      ? (value as any).rounds
      : [];

    if (rounds.length === 0) {
      return [];
    }

    const latestRound = rounds[rounds.length - 1];
    const answers = Array.isArray(latestRound?.answers)
      ? latestRound.answers
      : [];

    return answers
      .map((item: any, index: number) => {
        const question = String(item?.question ?? '').trim();
        const answer = String(item?.answer ?? '').trim();

        if (!question && !answer) {
          return '';
        }

        return [
          this.toPersianNumber(index + 1) + ') ' + question,
          'پاسخ: ' + answer,
        ]
          .filter(Boolean)
          .join('\n')
          .trim();
      })
      .filter(Boolean);
  }

  private getActionabilityLabel(value: unknown): string {
    const map: Record<string, string> = {
      ACTIONABLE: 'قابل پیگیری',
      NEEDS_INFO: 'نیازمند اطلاعات تکمیلی',
      NOT_ACTIONABLE: 'فعلاً غیرقابل پیگیری / نیازمند بررسی تحریریه',
    };

    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();

    return map[normalized] || normalized || 'نامشخص';
  }

  private getStatusLabel(status: unknown): string {
    const map: Record<string, string> = {
      NEW: 'ثبت اولیه',
      NEEDS_INFO: 'نیازمند اطلاعات تکمیلی',
      READY_FOR_REVIEW: 'آماده بررسی تحریریه',
      IN_REVIEW: 'در حال بررسی',
      REFERRED: 'ارجاع شده',
      WAITING_RESPONSE: 'منتظر پاسخ دستگاه',
      RESOLVED: 'حل شده',
      REJECTED: 'رد شده',
      PUBLISHED: 'منتشر شده',
    };

    const normalized = String(status ?? '')
      .trim()
      .toUpperCase();

    return map[normalized] || normalized || 'نامشخص';
  }

  private getPriorityLabel(priority: unknown): string {
    const map: Record<string, string> = {
      NORMAL: 'عادی',
      HIGH: 'بالا',
      URGENT: 'فوری',
    };

    const normalized = String(priority ?? '')
      .trim()
      .toUpperCase();

    return map[normalized] || normalized || 'نامشخص';
  }

  private getKazerunYarCategoryLabel(category: unknown): string {
    const map: Record<string, string> = {
      HEALTH: '🏥 درمان و سلامت',
      EMERGENCY: '🚨 خدمات ضروری و امدادی',
      UTILITIES: '💧 آب، برق، گاز و مخابرات',
      GOVERNMENT: '🏛 ادارات و خدمات دولتی',
      TRANSPORT: '🚕 حمل‌ونقل',
      EDUCATION: '🎓 آموزش و دانشگاه',
      TOURISM: '🧳 گردشگری و دیدنی‌ها',
      MUNICIPAL: '🏙 خدمات شهری',
      OTHER: '📌 سایر خدمات',
    };

    const key = String(category ?? '')
      .trim()
      .toUpperCase();
    return map[key] ?? '📌 سایر خدمات';
  }

  private async sendKazerunYarMenu(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '🧭 کازرون‌یار | راهنمای هوشمند شهر',
        '',
        'دنبال آدرس، شماره تماس، ساعت فعالیت یا یک خدمت شهری هستید؟',
        '',
        'اطلاعات این بخش از بانک داده کازرون‌یار خوانده می‌شود و موارد تأییدشده با نشان ✅ مشخص هستند.',
        'اگر اطلاعاتی ناقص یا قدیمی باشد، خود مردم هم می‌توانند برای اصلاح آن پیشنهاد بفرستند.',
        '',
        'یک دسته را انتخاب کنید یا از جستجو استفاده کنید 👇',
      ].join('\n'),
      this.getKazerunYarMenuKeyboard(),
    );
  }

  private getKazerunYarMenuKeyboard(): object {
    return {
      inline_keyboard: [
        [
          { text: '🏥 درمان و سلامت', callback_data: 'usr:kzcat:HEALTH' },
          { text: '🚨 ضروری و امدادی', callback_data: 'usr:kzcat:EMERGENCY' },
        ],
        [
          {
            text: '💧 آب، برق، گاز و مخابرات',
            callback_data: 'usr:kzcat:UTILITIES',
          },
        ],
        [
          { text: '🏛 ادارات', callback_data: 'usr:kzcat:GOVERNMENT' },
          { text: '🚕 حمل‌ونقل', callback_data: 'usr:kzcat:TRANSPORT' },
        ],
        [
          { text: '🎓 آموزش', callback_data: 'usr:kzcat:EDUCATION' },
          { text: '🧳 گردشگری', callback_data: 'usr:kzcat:TOURISM' },
        ],
        [
          { text: '🏙 خدمات شهری', callback_data: 'usr:kzcat:MUNICIPAL' },
          { text: '📌 سایر', callback_data: 'usr:kzcat:OTHER' },
        ],
        [{ text: '🔎 جستجو در کازرون‌یار', callback_data: 'usr:kzs' }],
        [
          { text: '➕ پیشنهاد افزودن خدمت', callback_data: 'usr:kzmiss' },
          { text: '📍 گزارش مشکل شهری', callback_data: 'usr:report' },
        ],
        [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
      ],
    };
  }

  private getKazerunYarBackKeyboard(): object {
    return {
      inline_keyboard: [
        [
          { text: '🧭 بازگشت به کازرون‌یار', callback_data: 'usr:kz' },
          { text: '🏠 منوی اصلی', callback_data: 'usr:home' },
        ],
      ],
    };
  }

  private async sendKazerunYarCategory(
    chatId: ChatId,
    category: string,
  ): Promise<void> {
    try {
      const items = await this.kazerunYarService.listByCategory(category, 12);
      const label = this.getKazerunYarCategoryLabel(category);

      if (!items.length) {
        await this.sendMessage(
          chatId,
          [
            label,
            '',
            'هنوز مورد تأییدشده‌ای در این دسته ثبت نشده یا بانک این بخش در حال تکمیل است.',
            '',
            'اگر مرکز یا خدمت معتبری می‌شناسید، از «➕ پیشنهاد افزودن خدمت» برای ارسال اطلاعات استفاده کنید.',
          ].join('\n'),
          {
            inline_keyboard: [
              [{ text: '➕ پیشنهاد افزودن خدمت', callback_data: 'usr:kzmiss' }],
              [{ text: '🔎 جستجو', callback_data: 'usr:kzs' }],
              [{ text: '🧭 بازگشت', callback_data: 'usr:kz' }],
            ],
          },
        );
        return;
      }

      const keyboard: any[][] = items.map((item: any) => [
        {
          text: `${item.isVerified ? '✅' : '🟡'} ${String(item.title).slice(0, 48)}`,
          callback_data: 'usr:kzi:' + String(item.id),
        },
      ]);

      keyboard.push([
        { text: '🔎 جستجو', callback_data: 'usr:kzs' },
        { text: '🧭 بازگشت', callback_data: 'usr:kz' },
      ]);

      await this.sendMessage(
        chatId,
        [
          label,
          '',
          'موارد موجود در بانک کازرون‌یار:',
          '',
          '✅ تأییدشده توسط تحریریه',
          '🟡 ثبت‌شده و در انتظار تکمیل/تأیید',
        ].join('\n'),
        { inline_keyboard: keyboard },
      );
    } catch (error: any) {
      this.logger.warn(
        'KazerunYar category failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'دریافت اطلاعات این بخش با خطا روبه‌رو شد. لطفاً دوباره تلاش کنید.',
        this.getKazerunYarBackKeyboard(),
      );
    }
  }

  private async sendKazerunYarSearchResults(
    chatId: ChatId,
    query: string,
  ): Promise<void> {
    try {
      const items = await this.kazerunYarService.searchServices(query, 8);

      if (!items.length) {
        await this.sendMessage(
          chatId,
          [
            '🔎 نتیجه جستجو',
            '',
            `برای «${String(query).slice(0, 80)}» موردی در بانک کازرون‌یار پیدا نشد.`,
            '',
            'این به معنی نبودن آن خدمت در کازرون نیست؛ ممکن است هنوز به بانک اطلاعاتی اضافه نشده باشد.',
          ].join('\n'),
          {
            inline_keyboard: [
              [
                {
                  text: '➕ پیشنهاد افزودن همین مورد',
                  callback_data: 'usr:kzmiss',
                },
              ],
              [{ text: '🔎 جستجوی دوباره', callback_data: 'usr:kzs' }],
              [{ text: '🧭 کازرون‌یار', callback_data: 'usr:kz' }],
            ],
          },
        );
        return;
      }

      const keyboard: any[][] = items.map((item: any) => [
        {
          text: `${item.isVerified ? '✅' : '🟡'} ${String(item.title).slice(0, 48)}`,
          callback_data: 'usr:kzi:' + String(item.id),
        },
      ]);

      keyboard.push([
        { text: '🔎 جستجوی دوباره', callback_data: 'usr:kzs' },
        { text: '🧭 کازرون‌یار', callback_data: 'usr:kz' },
      ]);

      await this.sendMessage(
        chatId,
        [
          '🔎 نتیجه جستجوی کازرون‌یار',
          '',
          `عبارت: ${String(query).slice(0, 100)}`,
          '',
          `${this.toPersianNumber(items.length)} نتیجه نزدیک پیدا شد:`,
        ].join('\n'),
        { inline_keyboard: keyboard },
      );
    } catch (error: any) {
      this.logger.warn(
        'KazerunYar search failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'جستجو با خطا روبه‌رو شد. لطفاً دوباره تلاش کنید.',
        this.getKazerunYarBackKeyboard(),
      );
    }
  }

  private async sendKazerunYarServiceDetails(
    chatId: ChatId,
    id: string,
  ): Promise<void> {
    try {
      const item: any = await this.kazerunYarService.getService(id);
      const lines: string[] = [
        '🧭 کازرون‌یار',
        '',
        `${item.isVerified ? '✅ اطلاعات تأییدشده' : '🟡 اطلاعات در انتظار تأیید کامل'}`,
        '',
        `📌 ${String(item.title)}`,
        `🗂 ${this.getKazerunYarCategoryLabel(item.category)}`,
      ];

      if (item.shortDescription) {
        lines.push('', 'ℹ️ ' + String(item.shortDescription));
      }
      if (item.address) {
        lines.push('', '📍 آدرس:', String(item.address));
      }
      if (item.phone) {
        lines.push('', '☎️ تماس: ' + String(item.phone));
      }
      if (item.hours) {
        lines.push('🕒 ساعت فعالیت: ' + String(item.hours));
      }
      if (item.sourceLabel) {
        lines.push('', '🧾 منبع بررسی: ' + String(item.sourceLabel));
      }
      if (item.verifiedAt) {
        lines.push('🗓 آخرین تأیید: ' + this.formatDateTime(item.verifiedAt));
      }

      lines.push(
        '',
        '⚠️ اگر اطلاعات تغییر کرده یا اشتباه است، از دکمه «گزارش اصلاح» استفاده کنید.',
      );

      const rows: any[][] = [];
      const urlRow: any[] = [];
      const website = String(item.website ?? '').trim();
      const mapUrl = String(item.mapUrl ?? '').trim();

      if (/^https?:\/\//i.test(website)) {
        urlRow.push({ text: '🌐 وب‌سایت', url: website });
      }
      if (/^https?:\/\//i.test(mapUrl)) {
        urlRow.push({ text: '🗺 مسیر روی نقشه', url: mapUrl });
      }
      if (urlRow.length) rows.push(urlRow);

      rows.push([
        {
          text: '⚠️ گزارش اصلاح اطلاعات',
          callback_data: 'usr:kzf:' + String(item.id),
        },
      ]);
      rows.push([
        { text: '🔎 جستجو', callback_data: 'usr:kzs' },
        { text: '🧭 کازرون‌یار', callback_data: 'usr:kz' },
      ]);

      await this.sendMessage(chatId, lines.join('\n'), {
        inline_keyboard: rows,
      });
    } catch (error: any) {
      await this.sendMessage(
        chatId,
        'این مورد دیگر در بانک عمومی کازرون‌یار در دسترس نیست.',
        this.getKazerunYarBackKeyboard(),
      );
    }
  }

  private async notifyEditorialOfKazerunYarFeedback(
    feedback: any,
  ): Promise<void> {
    const editorialChatId = this.getEditorialChatId();
    if (editorialChatId === null) return;

    const serviceTitle = feedback?.cityService?.title
      ? String(feedback.cityService.title)
      : 'مورد جدید / خارج از بانک';

    await this.sendMessage(
      editorialChatId,
      [
        '🧭 پیشنهاد جدید برای کازرون‌یار',
        '',
        `📌 نوع: ${String(feedback.feedbackType) === 'MISSING' ? 'پیشنهاد افزودن خدمت' : 'اصلاح اطلاعات'}`,
        `🏷 مورد: ${serviceTitle}`,
        '',
        '📝 توضیح شهروند:',
        String(feedback.text ?? '').trim(),
        '',
        '🔐 شناسه شهروند فقط برای جلوگیری از سوءاستفاده در سیستم نگهداری می‌شود و عمومی نیست.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: '✅ بررسی/پذیرش',
              callback_data: 'kza:fbok:' + String(feedback.id),
            },
            {
              text: '❌ بایگانی',
              callback_data: 'kza:fbno:' + String(feedback.id),
            },
          ],
          [{ text: '🧭 مدیریت کازرون‌یار', callback_data: 'kza:home' }],
        ],
      },
    );
  }

  private async sendKazerunYarAdminMenu(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '🧭 مدیریت کازرون‌یار | تحریریه',
        '',
        'بانک اطلاعات شهری از همین بخش قابل توسعه و کنترل است.',
        '',
        'اصل مهم: شماره، آدرس و ساعت فعالیت فقط وقتی ✅ می‌شوند که منبع قابل اتکا بررسی شده باشد.',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: '➕ افزودن خدمت/مکان', callback_data: 'kza:add' }],
          [
            { text: '📚 آخرین موارد', callback_data: 'kza:list' },
            { text: '📨 اصلاحات مردم', callback_data: 'kza:feedback' },
          ],
        ],
      },
    );
  }

  private async handleKazerunYarAdminCallback(
    query: BaleCallbackQuery,
  ): Promise<void> {
    const message = query.message;
    if (!message || !this.isEditorialChat(message.chat.id)) {
      await this.answerCallbackQuery(query.id, 'این بخش فقط برای تحریریه است.');
      return;
    }

    if (!this.isEditorialOperatorAllowed(query.from)) {
      await this.answerCallbackQuery(
        query.id,
        'شما مجوز این عملیات را ندارید.',
        true,
      );
      return;
    }

    const data = String(query.data ?? '').trim();
    const parts = data.split(':');
    const action = parts[1] ?? '';
    const id = parts.slice(2).join(':').trim();
    const chatId = String(message.chat.id);
    const key = this.getEditorialSessionKey(message.chat.id, query.from.id);
    const actor =
      this.getEditorialOperatorName(query.from) +
      ' (' +
      String(query.from.id) +
      ')';

    try {
      if (action === 'home') {
        this.kazerunYarEditorialSessions.delete(key);
        await this.answerCallbackQuery(query.id);
        await this.sendKazerunYarAdminMenu(chatId);
        return;
      }

      if (action === 'add') {
        this.kazerunYarEditorialSessions.set(key, { action: 'add_service' });
        await this.answerCallbackQuery(query.id, 'منتظر اطلاعات خدمت هستم.');
        await this.sendMessage(
          chatId,
          [
            '➕ افزودن مورد جدید به کازرون‌یار',
            '',
            'اطلاعات را در یک پیام با همین قالب بفرستید:',
            '',
            'عنوان: ...',
            'دسته: سلامت / ضروری / خدمات / ادارات / حمل‌ونقل / آموزش / گردشگری / شهری / سایر',
            'آدرس: ...',
            'تلفن: ...',
            'ساعت: ...',
            'توضیح: ...',
            'نام‌های دیگر: ... , ...',
            'وب‌سایت: https://...',
            'نقشه: https://...',
            'منبع: ...',
            'لینک منبع: https://...',
            '',
            'فقط «عنوان» الزامی است؛ بقیه موارد را اگر مطمئن هستید وارد کنید.',
          ].join('\n'),
          { inline_keyboard: [[{ text: 'لغو', callback_data: 'kza:home' }]] },
        );
        return;
      }

      if (action === 'list') {
        const items = await this.kazerunYarService.listRecentServices(15);
        await this.answerCallbackQuery(query.id);
        if (!items.length) {
          await this.sendMessage(
            chatId,
            'هنوز موردی در بانک کازرون‌یار ثبت نشده.',
            {
              inline_keyboard: [
                [{ text: '➕ افزودن اولین مورد', callback_data: 'kza:add' }],
              ],
            },
          );
          return;
        }

        const keyboard: any[][] = items.map((item: any) => [
          {
            text: `${item.isActive ? (item.isVerified ? '✅' : '🟡') : '⛔'} ${String(item.title).slice(0, 45)}`,
            callback_data: 'kza:view:' + String(item.id),
          },
        ]);
        keyboard.push([{ text: '🧭 مدیریت', callback_data: 'kza:home' }]);
        await this.sendMessage(chatId, '📚 آخرین موارد بانک کازرون‌یار', {
          inline_keyboard: keyboard,
        });
        return;
      }

      if (action === 'feedback') {
        const items = await this.kazerunYarService.listPendingFeedback(10);
        await this.answerCallbackQuery(query.id);
        if (!items.length) {
          await this.sendMessage(
            chatId,
            '✅ پیشنهاد اصلاح بررسی‌نشده‌ای وجود ندارد.',
            {
              inline_keyboard: [
                [{ text: '🧭 مدیریت', callback_data: 'kza:home' }],
              ],
            },
          );
          return;
        }

        for (const item of items as any[]) {
          await this.sendMessage(
            chatId,
            [
              '📨 پیشنهاد اصلاح کازرون‌یار',
              '',
              '🏷 ' +
                (item.cityService?.title
                  ? String(item.cityService.title)
                  : 'مورد جدید'),
              '📌 نوع: ' +
                (String(item.feedbackType) === 'MISSING'
                  ? 'افزودن مورد'
                  : 'اصلاح اطلاعات'),
              '',
              String(item.text),
            ].join('\n'),
            {
              inline_keyboard: [
                [
                  {
                    text: '✅ پذیرفته شد',
                    callback_data: 'kza:fbok:' + String(item.id),
                  },
                  {
                    text: '❌ بایگانی',
                    callback_data: 'kza:fbno:' + String(item.id),
                  },
                ],
              ],
            },
          );
        }
        return;
      }

      if (action === 'view' && id) {
        const item: any = await this.kazerunYarService.getServiceForAdmin(id);
        await this.answerCallbackQuery(query.id);
        const rows: any[][] = [
          [{ text: '✏️ ویرایش اطلاعات', callback_data: 'kza:edit:' + id }],
          [
            item.isVerified
              ? {
                  text: '🟡 برداشتن تأیید',
                  callback_data: 'kza:unverify:' + id,
                }
              : { text: '✅ تأیید اطلاعات', callback_data: 'kza:verify:' + id },
          ],
          [
            item.isActive
              ? { text: '⛔ غیرفعال‌کردن', callback_data: 'kza:off:' + id }
              : { text: '♻️ فعال‌کردن', callback_data: 'kza:on:' + id },
          ],
          [{ text: '📚 بازگشت به فهرست', callback_data: 'kza:list' }],
        ];
        await this.sendMessage(
          chatId,
          [
            '🧭 پرونده اطلاعات شهری',
            '',
            `📌 ${String(item.title)}`,
            `🗂 ${this.getKazerunYarCategoryLabel(item.category)}`,
            `🔎 وضعیت: ${item.isActive ? 'فعال' : 'غیرفعال'} | ${item.isVerified ? '✅ تأییدشده' : '🟡 تأییدنشده'}`,
            item.address ? `📍 ${String(item.address)}` : '',
            item.phone ? `☎️ ${String(item.phone)}` : '',
            item.hours ? `🕒 ${String(item.hours)}` : '',
            item.sourceLabel ? `🧾 منبع: ${String(item.sourceLabel)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          { inline_keyboard: rows },
        );
        return;
      }

      if (action === 'edit' && id) {
        const item: any = await this.kazerunYarService.getServiceForAdmin(id);
        this.kazerunYarEditorialSessions.set(key, {
          action: 'edit_service',
          cityServiceId: id,
        });
        await this.answerCallbackQuery(
          query.id,
          'منتظر اطلاعات اصلاح‌شده هستم.',
        );
        await this.sendMessage(
          chatId,
          [
            '✏️ ویرایش کازرون‌یار',
            '',
            `📌 ${String(item.title)}`,
            '',
            'فقط خط‌هایی را که می‌خواهید تغییر کنند بفرستید:',
            'عنوان: ...',
            'دسته: ...',
            'آدرس: ...',
            'تلفن: ...',
            'ساعت: ...',
            'توضیح: ...',
            'نام‌های دیگر: ... , ...',
            'وب‌سایت: https://...',
            'نقشه: https://...',
            'منبع: ...',
            'لینک منبع: https://...',
            '',
            'بعد از هر ویرایش، نشان ✅ برداشته می‌شود تا اطلاعات دوباره بررسی شوند.',
          ].join('\n'),
          { inline_keyboard: [[{ text: 'لغو', callback_data: 'kza:home' }]] },
        );
        return;
      }

      if ((action === 'verify' || action === 'unverify') && id) {
        await this.kazerunYarService.setVerified(
          id,
          action === 'verify',
          actor,
        );
        await this.answerCallbackQuery(
          query.id,
          action === 'verify' ? 'اطلاعات تأیید شد.' : 'تأیید برداشته شد.',
        );
        await this.sendMessage(
          chatId,
          action === 'verify'
            ? '✅ این مورد به‌عنوان اطلاعات تأییدشده علامت خورد.'
            : '🟡 وضعیت این مورد به تأییدنشده تغییر کرد.',
        );
        return;
      }

      if ((action === 'on' || action === 'off') && id) {
        await this.kazerunYarService.setActive(id, action === 'on');
        await this.answerCallbackQuery(
          query.id,
          action === 'on' ? 'فعال شد.' : 'غیرفعال شد.',
        );
        return;
      }

      if ((action === 'fbok' || action === 'fbno') && id) {
        await this.kazerunYarService.moderateFeedback(
          id,
          action === 'fbok',
          actor,
        );
        await this.answerCallbackQuery(
          query.id,
          action === 'fbok' ? 'پیشنهاد پذیرفته شد.' : 'پیشنهاد بایگانی شد.',
        );
        await this.clearInlineKeyboard(chatId, String(message.message_id));
        return;
      }

      await this.answerCallbackQuery(query.id, 'عملیات شناخته نشد.');
    } catch (error: any) {
      this.logger.error(
        'KazerunYar admin callback failed: ' +
          (error?.message ?? 'Unknown error'),
      );
      await this.answerCallbackQuery(
        query.id,
        'انجام عملیات با خطا روبه‌رو شد.',
        true,
      );
    }
  }

  private parseKazerunYarServiceForm(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    const keyMap: Record<string, string> = {
      عنوان: 'title',
      دسته: 'category',
      آدرس: 'address',
      تلفن: 'phone',
      تماس: 'phone',
      ساعت: 'hours',
      توضیح: 'description',
      'نام‌های دیگر': 'aliases',
      'نام های دیگر': 'aliases',
      وبسایت: 'website',
      وب‌سایت: 'website',
      نقشه: 'mapUrl',
      منبع: 'sourceLabel',
      'لینک منبع': 'sourceUrl',
    };

    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      const faIdx = line.indexOf('：');
      const cut = idx >= 0 ? idx : faIdx;
      if (cut < 0) continue;
      const rawKey = line
        .slice(0, cut)
        .trim()
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک');
      const value = line.slice(cut + 1).trim();
      const mapped = keyMap[rawKey];
      if (mapped && value) result[mapped] = value;
    }

    return result;
  }

  private async handleKazerunYarEditorialText(
    message: BaleMessage,
    session: KazerunYarEditorialSession,
    key: string,
  ): Promise<void> {
    const user = message.from;
    const text = String(message.text ?? message.caption ?? '').trim();
    if (!user || !this.isEditorialOperatorAllowed(user)) {
      this.kazerunYarEditorialSessions.delete(key);
      return;
    }

    const parsed = this.parseKazerunYarServiceForm(text);

    if (session.action === 'add_service' && !parsed.title) {
      await this.sendMessage(
        String(message.chat.id),
        '⚠️ خط «عنوان: ...» پیدا نشد. لطفاً اطلاعات را با همان قالب ارسال کنید.',
      );
      return;
    }

    if (session.action === 'edit_service' && !Object.keys(parsed).length) {
      await this.sendMessage(
        String(message.chat.id),
        '⚠️ هیچ فیلد قابل ویرایشی پیدا نشد. حداقل یک خط مثل «تلفن: ...» یا «آدرس: ...» بفرستید.',
      );
      return;
    }

    try {
      const actor =
        this.getEditorialOperatorName(user) + ' (' + String(user.id) + ')';
      const aliases = parsed.aliases
        ? parsed.aliases
            .split(/[،,]/)
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined;

      let item: any;
      if (session.action === 'edit_service' && session.cityServiceId) {
        item = await this.kazerunYarService.updateService(
          session.cityServiceId,
          {
            title: parsed.title,
            category: parsed.category,
            aliases,
            shortDescription: parsed.description,
            address: parsed.address,
            phone: parsed.phone,
            hours: parsed.hours,
            website: parsed.website,
            mapUrl: parsed.mapUrl,
            sourceLabel: parsed.sourceLabel,
            sourceUrl: parsed.sourceUrl,
          },
        );
      } else {
        item = await this.kazerunYarService.createService({
          title: parsed.title,
          category: parsed.category ?? 'OTHER',
          aliases: aliases ?? [],
          shortDescription: parsed.description ?? null,
          address: parsed.address ?? null,
          phone: parsed.phone ?? null,
          hours: parsed.hours ?? null,
          website: parsed.website ?? null,
          mapUrl: parsed.mapUrl ?? null,
          sourceLabel: parsed.sourceLabel ?? null,
          sourceUrl: parsed.sourceUrl ?? null,
          createdBy: actor,
        });
      }

      const wasEdit = session.action === 'edit_service';
      this.kazerunYarEditorialSessions.delete(key);
      await this.sendMessage(
        String(message.chat.id),
        [
          wasEdit
            ? '✅ اطلاعات کازرون‌یار ویرایش شد.'
            : '✅ مورد جدید به بانک کازرون‌یار اضافه شد.',
          '',
          `📌 ${String(item.title)}`,
          `🗂 ${this.getKazerunYarCategoryLabel(item.category)}`,
          '',
          '🟡 این مورد فعلاً «تأییدنشده» است. پس از بررسی منبع، دکمه تأیید را بزنید.',
        ].join('\n'),
        {
          inline_keyboard: [
            [
              {
                text: '✅ تأیید اطلاعات',
                callback_data: 'kza:verify:' + String(item.id),
              },
            ],
            [{ text: '📚 مشاهده فهرست', callback_data: 'kza:list' }],
          ],
        },
      );
    } catch (error: any) {
      this.logger.error(
        'KazerunYar save service failed: ' +
          (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        String(message.chat.id),
        'ذخیره اطلاعات با خطا روبه‌رو شد. اطلاعات را بررسی و دوباره ارسال کنید.',
      );
    }
  }

  private getNewsCategoryLabel(category: unknown): string {
    const map: Record<string, string> = {
      CITY: '🏙 شهری',
      SERVICES: '💧 خدمات و قطعی‌ها',
      HEALTH: '🏥 سلامت',
      TRAFFIC: '🚗 ترافیک و راه',
      CULTURE: '🎭 فرهنگی و رویداد',
      SPORTS: '🏅 ورزشی',
      OTHER: '📰 سایر',
    };
    return map[String(category ?? '').toUpperCase()] ?? '📰 سایر';
  }

  private getNewsAlertLabel(level: unknown): string {
    const value = String(level ?? '').toUpperCase();
    if (value === 'URGENT') return '🚨 فوری';
    if (value === 'IMPORTANT') return '🔴 مهم';
    return '🔵 عادی';
  }

  private async sendNewsMenu(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '📰 خبر و اعلان | کازرون خبر',
        '',
        'آخرین خبرهای شهری و اعلان‌های مهم کازرون را از این بخش ببینید.',
        '',
        '🔔 اعلان‌ها اختیاری هستند؛ فقط دسته‌هایی که خودتان فعال کنید برایتان ارسال می‌شوند.',
        '',
        '✨ کازرون خبر؛ روایت اول کازرون',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: '📰 آخرین خبرها', callback_data: 'usr:nlatest' },
            { text: '🚨 فوری‌ها', callback_data: 'usr:nurgent' },
          ],
          [
            { text: '💧 خدمات و قطعی‌ها', callback_data: 'usr:ncat:SERVICES' },
            { text: '🏙 شهری', callback_data: 'usr:ncat:CITY' },
          ],
          [
            { text: '🚗 ترافیک و راه', callback_data: 'usr:ncat:TRAFFIC' },
            { text: '🏥 سلامت', callback_data: 'usr:ncat:HEALTH' },
          ],
          [
            { text: '🎭 فرهنگی', callback_data: 'usr:ncat:CULTURE' },
            { text: '🏅 ورزشی', callback_data: 'usr:ncat:SPORTS' },
          ],
          [{ text: '🔔 تنظیم اعلان‌های من', callback_data: 'usr:nsubs' }],
          [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
        ],
      },
    );
  }

  private async sendNewsList(
    chatId: ChatId,
    category?: string,
    urgent = false,
  ): Promise<void> {
    try {
      const items: any[] = urgent
        ? await this.newsService.listUrgent(12)
        : await this.newsService.listPublished(category, 12);

      if (!items.length) {
        await this.sendMessage(
          chatId,
          urgent
            ? '🚨 در حال حاضر اعلان فوری فعالی ثبت نشده است.'
            : '📰 هنوز خبری در این بخش منتشر نشده است.',
          {
            inline_keyboard: [
              [{ text: '📰 مرکز خبر و اعلان', callback_data: 'usr:news' }],
              [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
            ],
          },
        );
        return;
      }

      const title = urgent
        ? '🚨 آخرین اعلان‌های فوری'
        : category
          ? this.getNewsCategoryLabel(category)
          : '📰 آخرین خبرهای کازرون';

      const keyboard: any[][] = items.map((item: any) => [
        {
          text:
            `${item.alertLevel === 'URGENT' ? '🚨 ' : item.alertLevel === 'IMPORTANT' ? '🔴 ' : ''}` +
            String(item.title).slice(0, 48),
          callback_data: 'usr:nview:' + String(item.id),
        },
      ]);
      keyboard.push([
        { text: '🔔 تنظیم اعلان‌ها', callback_data: 'usr:nsubs' },
        { text: '📰 بازگشت', callback_data: 'usr:news' },
      ]);

      await this.sendMessage(
        chatId,
        [title, '', 'برای مشاهده متن کامل، یکی از خبرها را انتخاب کنید.'].join(
          '\n',
        ),
        { inline_keyboard: keyboard },
      );
    } catch (error: any) {
      this.logger.warn(
        'News list failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'دریافت خبرها با خطا روبه‌رو شد. لطفاً کمی بعد دوباره تلاش کنید.',
        {
          inline_keyboard: [
            [{ text: '📰 مرکز خبر', callback_data: 'usr:news' }],
          ],
        },
      );
    }
  }

  private async sendNewsDetails(chatId: ChatId, id: string): Promise<void> {
    try {
      const item: any = await this.newsService.getPublicById(id);
      const body = String(item.body ?? '')
        .trim()
        .slice(0, 3000);

      await this.sendMessage(
        chatId,
        [
          `${this.getNewsAlertLabel(item.alertLevel)} | ${this.getNewsCategoryLabel(item.category)}`,
          '',
          '📌 ' + String(item.title),
          '',
          body,
          '',
          item.sourceLabel ? '🧾 منبع: ' + String(item.sourceLabel) : '',
          item.sourceUrl ? '🔗 ' + String(item.sourceUrl) : '',
          item.publishedAt
            ? '🕒 انتشار: ' + this.formatDateTime(item.publishedAt)
            : '',
          '',
          '✨ کازرون خبر؛ روایت اول کازرون',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          inline_keyboard: [
            [
              { text: '🔔 تنظیم اعلان‌ها', callback_data: 'usr:nsubs' },
              { text: '📰 خبرهای بیشتر', callback_data: 'usr:nlatest' },
            ],
            [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
          ],
        },
      );
    } catch {
      await this.sendMessage(
        chatId,
        'این خبر دیگر در بخش عمومی در دسترس نیست.',
        {
          inline_keyboard: [
            [{ text: '📰 مرکز خبر', callback_data: 'usr:news' }],
          ],
        },
      );
    }
  }

  private async sendNewsSubscriptionMenu(
    chatId: ChatId,
    platformUserId: string,
  ): Promise<void> {
    const active = await this.newsService.getUserSubscriptions(
      this.platform,
      platformUserId,
    );
    const mark = (key: string) => (active.has(key) ? '✅' : '▫️');

    await this.sendMessage(
      chatId,
      [
        '🔔 تنظیم اعلان‌های کازرون خبر',
        '',
        'دسته‌هایی را که می‌خواهید فعال یا غیرفعال کنید.',
        'با زدن دوباره هر گزینه، همان اشتراک خاموش می‌شود.',
        '',
        'اعلان‌ها فقط برای دسته‌های انتخابی شما ارسال می‌شوند.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: `${mark('ALL')} همه خبرها`, callback_data: 'usr:nsub:ALL' },
            {
              text: `${mark('URGENT')} فقط فوری‌ها`,
              callback_data: 'usr:nsub:URGENT',
            },
          ],
          [
            {
              text: `${mark('SERVICES')} خدمات/قطعی`,
              callback_data: 'usr:nsub:SERVICES',
            },
            { text: `${mark('CITY')} شهری`, callback_data: 'usr:nsub:CITY' },
          ],
          [
            {
              text: `${mark('TRAFFIC')} ترافیک/راه`,
              callback_data: 'usr:nsub:TRAFFIC',
            },
            {
              text: `${mark('HEALTH')} سلامت`,
              callback_data: 'usr:nsub:HEALTH',
            },
          ],
          [
            {
              text: `${mark('CULTURE')} فرهنگی`,
              callback_data: 'usr:nsub:CULTURE',
            },
            {
              text: `${mark('SPORTS')} ورزشی`,
              callback_data: 'usr:nsub:SPORTS',
            },
          ],
          [
            {
              text: '🔕 خاموش‌کردن همه اعلان‌ها',
              callback_data: 'usr:nsuboff',
            },
          ],
          [{ text: '📰 بازگشت به خبر و اعلان', callback_data: 'usr:news' }],
        ],
      },
    );
  }

  private async sendNewsAdminMenu(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '📰 مدیریت خبر و اعلان | تحریریه',
        '',
        'خبر را ابتدا به‌صورت پیش‌نویس ثبت کنید؛ پس از بازبینی با دکمه انتشار، خبر عمومی می‌شود و برای مشترکان همان دسته اعلان ارسال می‌شود.',
        '',
        '🚨 اعلان فوری فقط برای موارد واقعاً فوری استفاده شود.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: '➕ خبر جدید', callback_data: 'nwa:add' },
            { text: '🚨 اعلان فوری', callback_data: 'nwa:urgent' },
          ],
          [
            { text: '📝 پیش‌نویس‌ها', callback_data: 'nwa:drafts' },
            { text: '✅ منتشرشده‌ها', callback_data: 'nwa:published' },
          ],
        ],
      },
    );
  }

  private async handleNewsAdminCallback(
    query: BaleCallbackQuery,
  ): Promise<void> {
    const message = query.message;
    if (!message) {
      await this.answerCallbackQuery(query.id);
      return;
    }

    const user = query.from;
    if (!this.isEditorialOperatorAllowed(user)) {
      await this.answerCallbackQuery(query.id, 'دسترسی مجاز نیست.', true);
      return;
    }

    const chatId = String(message.chat.id);
    const data = String(query.data ?? '');
    const parts = data.split(':');
    const action = parts[1] ?? '';
    const id = parts.slice(2).join(':').trim();
    const key = this.getEditorialSessionKey(message.chat.id, user.id);
    const actor =
      this.getEditorialOperatorName(user) + ' (' + String(user.id) + ')';

    try {
      if (action === 'home') {
        this.newsEditorialSessions.delete(key);
        await this.answerCallbackQuery(query.id);
        await this.sendNewsAdminMenu(chatId);
        return;
      }

      if (action === 'add' || action === 'urgent') {
        this.newsEditorialSessions.set(key, {
          action: action === 'urgent' ? 'add_urgent' : 'add_news',
        });
        await this.answerCallbackQuery(query.id, 'منتظر متن خبر هستم.');
        await this.sendMessage(
          chatId,
          [
            action === 'urgent' ? '🚨 ثبت اعلان فوری' : '➕ ثبت خبر جدید',
            '',
            'اطلاعات را در یک پیام با این قالب بفرستید:',
            '',
            'عنوان: ...',
            'دسته: شهری / خدمات / سلامت / ترافیک / فرهنگی / ورزشی / سایر',
            action === 'urgent' ? 'سطح: فوری' : 'سطح: عادی / مهم / فوری',
            'متن: ...',
            'منبع: ...',
            'لینک منبع: https://...',
            '',
            'عنوان و متن الزامی هستند.',
            'خبر ابتدا پیش‌نویس می‌شود و بدون تأیید شما منتشر نخواهد شد.',
          ].join('\n'),
          { inline_keyboard: [[{ text: 'لغو', callback_data: 'nwa:home' }]] },
        );
        return;
      }

      if (action === 'drafts' || action === 'published') {
        const items: any[] =
          action === 'drafts'
            ? await this.newsService.listDrafts(20)
            : await this.newsService.listPublishedForAdmin(20);

        await this.answerCallbackQuery(query.id);
        if (!items.length) {
          await this.sendMessage(
            chatId,
            action === 'drafts'
              ? '📝 پیش‌نویسی وجود ندارد.'
              : '📰 خبر منتشرشده‌ای وجود ندارد.',
            {
              inline_keyboard: [
                [{ text: '📰 مدیریت خبر', callback_data: 'nwa:home' }],
              ],
            },
          );
          return;
        }

        const keyboard: any[][] = items.map((item: any) => [
          {
            text:
              `${item.alertLevel === 'URGENT' ? '🚨 ' : item.isPublished ? '✅ ' : '📝 '}` +
              String(item.title).slice(0, 48),
            callback_data: 'nwa:view:' + String(item.id),
          },
        ]);
        keyboard.push([{ text: '📰 مدیریت خبر', callback_data: 'nwa:home' }]);

        await this.sendMessage(
          chatId,
          action === 'drafts' ? '📝 پیش‌نویس‌های خبر' : '✅ خبرهای منتشرشده',
          { inline_keyboard: keyboard },
        );
        return;
      }

      if (action === 'view' && id) {
        await this.answerCallbackQuery(query.id);
        await this.sendNewsAdminCard(chatId, id);
        return;
      }

      if (action === 'edit' && id) {
        const item: any = await this.newsService.getById(id);
        this.newsEditorialSessions.set(key, {
          action: 'edit_news',
          newsId: id,
        });
        await this.answerCallbackQuery(
          query.id,
          'منتظر اطلاعات اصلاح‌شده هستم.',
        );
        await this.sendMessage(
          chatId,
          [
            '✏️ ویرایش خبر',
            '',
            '📌 ' + String(item.title),
            '',
            'فقط فیلدهایی را که می‌خواهید تغییر کنند بفرستید:',
            'عنوان: ...',
            'دسته: ...',
            'سطح: ...',
            'متن: ...',
            'منبع: ...',
            'لینک منبع: https://...',
          ].join('\n'),
          {
            inline_keyboard: [
              [{ text: 'لغو', callback_data: 'nwa:view:' + id }],
            ],
          },
        );
        return;
      }

      if (action === 'publish' && id) {
        const item: any = await this.newsService.publish(id, actor);
        await this.answerCallbackQuery(
          query.id,
          'منتشر شد؛ ارسال اعلان آغاز شد.',
        );
        const result = await this.sendNewsNotifications(item);
        await this.sendMessage(
          chatId,
          [
            '✅ خبر منتشر شد.',
            `🔔 اعلان موفق: ${this.toPersianNumber(result.sent)}`,
            result.failed
              ? `⚠️ ناموفق: ${this.toPersianNumber(result.failed)}`
              : '',
            result.skipped ? 'ℹ️ مشترک جدیدی برای ارسال وجود نداشت.' : '',
          ]
            .filter(Boolean)
            .join('\n'),
          {
            inline_keyboard: [
              [{ text: '📋 مشاهده خبر', callback_data: 'nwa:view:' + id }],
            ],
          },
        );
        return;
      }

      if (action === 'notify' && id) {
        const item: any = await this.newsService.getById(id);
        await this.answerCallbackQuery(query.id, 'ارسال اعلان آغاز شد.');
        const result = await this.sendNewsNotifications(item);
        await this.sendMessage(
          chatId,
          [
            '🔔 ارسال اعلان پایان یافت.',
            `✅ موفق: ${this.toPersianNumber(result.sent)}`,
            result.failed
              ? `⚠️ ناموفق: ${this.toPersianNumber(result.failed)}`
              : '',
            result.skipped
              ? 'ℹ️ همه مشترکان قبلاً این خبر را دریافت کرده‌اند یا اشتراک فعالی وجود ندارد.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      if (action === 'archive' && id) {
        await this.newsService.archive(id, actor);
        await this.answerCallbackQuery(query.id, 'بایگانی شد.');
        await this.sendMessage(
          chatId,
          '🗄 خبر از نمایش عمومی خارج و بایگانی شد.',
          {
            inline_keyboard: [
              [{ text: '📰 مدیریت خبر', callback_data: 'nwa:home' }],
            ],
          },
        );
        return;
      }

      await this.answerCallbackQuery(query.id, 'عملیات شناخته نشد.');
    } catch (error: any) {
      this.logger.error(
        'News admin callback failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.answerCallbackQuery(
        query.id,
        'انجام عملیات با خطا روبه‌رو شد.',
        true,
      );
    }
  }

  private async sendNewsAdminCard(chatId: ChatId, id: string): Promise<void> {
    const item: any = await this.newsService.getById(id);
    const rows: any[][] = [];

    if (!item.isPublished && !item.isArchived) {
      rows.push([
        {
          text: '📢 انتشار + اعلان به مشترکان',
          callback_data: 'nwa:publish:' + id,
        },
      ]);
    }
    if (!item.isArchived) {
      rows.push([{ text: '✏️ ویرایش', callback_data: 'nwa:edit:' + id }]);
    }
    if (item.isPublished && !item.isArchived) {
      rows.push([
        {
          text: '🔔 ارسال اعلان به مشترکان جدید',
          callback_data: 'nwa:notify:' + id,
        },
      ]);
    }
    if (!item.isArchived) {
      rows.push([
        { text: '🗄 بایگانی/توقف نمایش', callback_data: 'nwa:archive:' + id },
      ]);
    }
    rows.push([{ text: '📰 مدیریت خبر', callback_data: 'nwa:home' }]);

    await this.sendMessage(
      chatId,
      [
        '📰 پرونده خبر',
        '',
        `${this.getNewsAlertLabel(item.alertLevel)} | ${this.getNewsCategoryLabel(item.category)}`,
        `📌 ${String(item.title)}`,
        '',
        String(item.body ?? '').slice(0, 1700),
        '',
        `📍 وضعیت: ${item.isArchived ? '🗄 بایگانی' : item.isPublished ? '✅ منتشرشده' : '📝 پیش‌نویس'}`,
        item.sourceLabel ? '🧾 منبع: ' + String(item.sourceLabel) : '',
        item.sourceUrl ? '🔗 ' + String(item.sourceUrl) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      { inline_keyboard: rows },
    );
  }

  private parseNewsForm(text: string): Record<string, string> {
    const result: Record<string, string> = {};
    const keyMap: Record<string, string> = {
      عنوان: 'title',
      دسته: 'category',
      سطح: 'alertLevel',
      متن: 'body',
      توضیح: 'body',
      منبع: 'sourceLabel',
      'لینک منبع': 'sourceUrl',
    };

    let currentKey = '';
    for (const rawLine of String(text ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        if (currentKey === 'body' && result.body) result.body += '\n';
        continue;
      }

      const idx = line.indexOf(':');
      const faIdx = line.indexOf('：');
      const cut = idx >= 0 ? idx : faIdx;
      let matched = false;

      if (cut >= 0) {
        const rawKey = line
          .slice(0, cut)
          .trim()
          .replace(/ي/g, 'ی')
          .replace(/ك/g, 'ک');
        const mapped = keyMap[rawKey];
        if (mapped) {
          result[mapped] = line.slice(cut + 1).trim();
          currentKey = mapped;
          matched = true;
        }
      }

      if (!matched && currentKey === 'body') {
        result.body = [result.body, line].filter(Boolean).join('\n');
      }
    }

    return result;
  }

  private async handleNewsEditorialText(
    message: BaleMessage,
    session: NewsEditorialSession,
    key: string,
  ): Promise<void> {
    const user = message.from;
    const text = String(message.text ?? message.caption ?? '').trim();

    if (!user || !this.isEditorialOperatorAllowed(user)) {
      this.newsEditorialSessions.delete(key);
      return;
    }

    const parsed = this.parseNewsForm(text);
    if (
      (session.action === 'add_news' || session.action === 'add_urgent') &&
      (!parsed.title || !parsed.body)
    ) {
      await this.sendMessage(
        String(message.chat.id),
        '⚠️ برای ثبت خبر، هر دو خط «عنوان: ...» و «متن: ...» الزامی هستند.',
      );
      return;
    }

    if (session.action === 'edit_news' && !Object.keys(parsed).length) {
      await this.sendMessage(
        String(message.chat.id),
        '⚠️ هیچ فیلد قابل ویرایشی پیدا نشد.',
      );
      return;
    }

    const actor =
      this.getEditorialOperatorName(user) + ' (' + String(user.id) + ')';

    try {
      let item: any;
      if (session.action === 'edit_news' && session.newsId) {
        item = await this.newsService.updateNews(session.newsId, {
          title: parsed.title,
          category: parsed.category,
          body: parsed.body,
          alertLevel: parsed.alertLevel,
          sourceLabel: parsed.sourceLabel,
          sourceUrl: parsed.sourceUrl,
          updatedBy: actor,
        });
      } else {
        item = await this.newsService.createNews({
          title: parsed.title,
          category: parsed.category ?? 'CITY',
          body: parsed.body,
          alertLevel:
            session.action === 'add_urgent'
              ? 'URGENT'
              : (parsed.alertLevel ?? 'NORMAL'),
          sourceLabel: parsed.sourceLabel,
          sourceUrl: parsed.sourceUrl,
          createdBy: actor,
        });
      }

      this.newsEditorialSessions.delete(key);

      await this.sendMessage(
        String(message.chat.id),
        session.action === 'edit_news'
          ? '✅ خبر ویرایش شد.'
          : '✅ خبر به‌صورت پیش‌نویس ثبت شد؛ هنوز برای مردم منتشر نشده است.',
      );

      await this.sendNewsAdminCard(String(message.chat.id), String(item.id));
    } catch (error: any) {
      this.logger.warn(
        'News editorial input failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        String(message.chat.id),
        'ثبت خبر با خطا روبه‌رو شد. اطلاعات را بررسی و دوباره تلاش کنید.',
      );
    }
  }

  private async sendNewsNotifications(news: any): Promise<{
    sent: number;
    failed: number;
    skipped: boolean;
  }> {
    const recipients = await this.newsService.getNotificationRecipients(
      String(news.id),
    );
    let sent = 0;
    let failed = 0;

    for (const target of recipients) {
      const chatId = Number(target);
      if (!chatId) continue;

      try {
        await this.sendMessage(
          chatId,
          [
            `${this.getNewsAlertLabel(news.alertLevel)} | کازرون خبر`,
            '',
            '📌 ' + String(news.title),
            '',
            String(news.body ?? '')
              .trim()
              .slice(0, 1200),
            '',
            'برای متن کامل و منبع، دکمه زیر را بزنید.',
          ].join('\n'),
          {
            inline_keyboard: [
              [
                {
                  text: '📰 مشاهده خبر کامل',
                  callback_data: 'usr:nview:' + String(news.id),
                },
              ],
              [{ text: '🔔 تنظیم اعلان‌ها', callback_data: 'usr:nsubs' }],
            ],
          },
        );
        sent += 1;
        await this.newsService.recordDelivery(
          String(news.id),
          String(target),
          'SENT',
        );
      } catch {
        failed += 1;
        try {
          await this.newsService.recordDelivery(
            String(news.id),
            String(target),
            'FAILED',
          );
        } catch {}
      }

      await this.delay(60);
    }

    return { sent, failed, skipped: recipients.length === 0 };
  }

  private async sendAdsMenu(
    chatId: ChatId,
    platformUserId: string,
  ): Promise<void> {
    const orders = await this.adsService
      .listUserOrders(this.platform, platformUserId, 3)
      .catch(() => [] as any[]);
    const activeCount = orders.filter(
      (item: any) =>
        !['COMPLETED', 'REJECTED', 'CANCELED'].includes(String(item.status)),
    ).length;

    await this.sendMessage(
      chatId,
      [
        '📣 سامانه تبلیغات کازرون خبر',
        '',
        'خرید بسته تبلیغاتی، پرداخت آنلاین و تحویل محتوای تبلیغ؛ همه از همین‌جا انجام می‌شود.',
        '',
        '✅ انتشار نهایی بعد از بررسی، توسط هیئت تحریریه و به‌صورت دستی در رسانه‌های انتخابی انجام می‌شود.',
        activeCount > 0
          ? '📂 سفارش فعال شما: ' + this.toPersianNumber(activeCount)
          : '',
        '',
        'کانال‌های قابل تعریف در بسته‌ها: بله، ایتا، روبیکا و سروش.',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        inline_keyboard: [
          [{ text: '🛒 مشاهده بسته‌ها و خرید', callback_data: 'usr:adpkgs' }],
          [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
          [{ text: '📋 قوانین و روند انتشار', callback_data: 'usr:adrules' }],
          [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
        ],
      },
    );
  }

  private async sendAdPackages(chatId: ChatId): Promise<void> {
    const packages = await this.adsService.listActivePackages();
    if (!packages.length) {
      await this.sendMessage(
        chatId,
        [
          '📦 بسته‌های تبلیغاتی',
          '',
          'در حال حاضر بسته فعالی برای خرید ثبت نشده است.',
          'واحد تبلیغات می‌تواند از پنل تحریریه بسته‌ها و قیمت‌ها را بدون تغییر کد مدیریت کند.',
        ].join('\n'),
        this.getAdsHomeKeyboard(),
      );
      return;
    }

    for (const pkg of packages) {
      const placements = this.adsService.normalizePlacements(pkg.placements);
      const placementText = placements
        .map(
          (item) =>
            this.getAdChannelLabel(item.channel) +
            ' × ' +
            this.toPersianNumber(item.count),
        )
        .join(' | ');

      await this.sendMessage(
        chatId,
        [
          '📦 ' + String(pkg.title),
          '',
          pkg.description ? String(pkg.description) : '',
          '',
          '📡 انتشار: ' + placementText,
          Number(pkg.pinHours) > 0
            ? '📌 پین: ' + this.toPersianNumber(Number(pkg.pinHours)) + ' ساعت'
            : '',
          '💳 قیمت: ' + this.formatToman(Number(pkg.priceToman)),
          '',
          'کد بسته: ' + String(pkg.code),
        ]
          .filter(Boolean)
          .join('\n'),
        {
          inline_keyboard: [
            [
              {
                text: '🛒 خرید این بسته',
                callback_data: 'usr:adbuy:' + String(pkg.id),
              },
            ],
            [{ text: '📣 بازگشت', callback_data: 'usr:ads' }],
          ],
        },
      );
    }
  }

  private async handleAdPackagePurchase(
    query: BaleCallbackQuery,
    packageId: string,
  ): Promise<void> {
    const message = query.message;
    const chatId = String(message?.chat?.id ?? query.from.id);
    try {
      const pkg = await this.adsService.getPackage(packageId);
      if (!pkg.isActive) {
        await this.sendMessage(
          chatId,
          'این بسته در حال حاضر غیرفعال است.',
          this.getAdsHomeKeyboard(),
        );
        return;
      }

      const order = await this.adsService.createOrder({
        packageId,
        platform: this.platform,
        platformUserId: String(query.from.id),
        displayName:
          [query.from.first_name, query.from.last_name]
            .filter(Boolean)
            .join(' ') || null,
        username: query.from.username ?? null,
      });

      await this.sendMessage(
        chatId,
        [
          '🧾 سفارش تبلیغ ساخته شد',
          '',
          'کد سفارش: ' + String(order.orderCode),
          'بسته: ' + String(pkg.title),
          'مبلغ: ' + this.formatToman(Number(order.amountToman)),
          '',
          'در مرحله بعد به درگاه امن پرداخت منتقل می‌شوید. بعد از پرداخت موفق، ربات دریافت متن و فایل تبلیغ را شروع می‌کند.',
        ].join('\n'),
      );

      await this.sendAdPaymentLink(
        chatId,
        String(query.from.id),
        String(order.id),
      );
    } catch (error: any) {
      this.logger.warn(
        'Ad purchase failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'ایجاد سفارش با خطا روبه‌رو شد: ' +
          String(error?.message ?? 'خطای نامشخص'),
        this.getAdsHomeKeyboard(),
      );
    }
  }

  private async sendAdPaymentLink(
    chatId: ChatId,
    platformUserId: string,
    orderId: string,
  ): Promise<void> {
    try {
      const order = await this.adsService.getUserOrder(
        orderId,
        this.platform,
        platformUserId,
      );
      if (await this.adsService.isOrderPaid(order.id)) {
        await this.sendMessage(
          chatId,
          '✅ پرداخت این سفارش قبلاً تأیید شده است.',
          {
            inline_keyboard: [
              [
                {
                  text: '📝 تکمیل سفارش',
                  callback_data: 'usr:adcontinue:' + String(order.id),
                },
              ],
              [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
            ],
          },
        );
        return;
      }

      const payment: any = await this.adsService.createPayment(order.id);
      if (payment.alreadyPaid) {
        await this.startAdContentFlow(chatId, platformUserId, order.id);
        return;
      }

      await this.sendMessage(
        chatId,
        [
          '💳 پرداخت سفارش تبلیغ',
          '',
          '🧾 ' + String(order.orderCode),
          '💰 مبلغ: ' + this.formatToman(Number(order.amountToman)),
          '',
          'روی دکمه «پرداخت آنلاین» بزنید. پس از بازگشت از درگاه، پرداخت در Backend دوباره اعتبارسنجی می‌شود.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '💳 پرداخت آنلاین', url: String(payment.paymentUrl) }],
            [
              {
                text: '🔄 بررسی وضعیت پرداخت',
                callback_data: 'usr:adcheck:' + String(order.id),
              },
            ],
            [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
          ],
        },
      );
    } catch (error: any) {
      this.logger.warn(
        'Ad payment link failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        [
          '⚠️ لینک پرداخت در این لحظه ساخته نشد.',
          '',
          String(error?.message ?? 'تنظیمات درگاه را بررسی کنید.'),
          '',
          'سفارش حذف نشده و بعداً از «سفارش‌های من» می‌توانید دوباره پرداخت را انجام دهید.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '🔄 تلاش دوباره', callback_data: 'usr:adpay:' + orderId }],
            [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
          ],
        },
      );
    }
  }

  private async handleAdPaymentCheck(
    chatId: ChatId,
    platformUserId: string,
    orderId: string,
  ): Promise<void> {
    try {
      const order = await this.adsService.getUserOrder(
        orderId,
        this.platform,
        platformUserId,
      );
      if (await this.adsService.isOrderPaid(order.id)) {
        await this.sendMessage(
          chatId,
          [
            '✅ پرداخت تأیید شده است.',
            '',
            '🧾 کد سفارش: ' + String(order.orderCode),
            'حالا اطلاعات تبلیغ را تکمیل کنید.',
          ].join('\n'),
          {
            inline_keyboard: [
              [
                {
                  text: '📝 تکمیل سفارش',
                  callback_data: 'usr:adcontinue:' + String(order.id),
                },
              ],
              [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
            ],
          },
        );
      } else {
        await this.sendMessage(
          chatId,
          '⏳ هنوز پرداخت تأییدشده‌ای برای این سفارش ثبت نشده است. اگر پرداخت را انجام داده‌اید، چند ثانیه بعد دوباره بررسی کنید.',
          {
            inline_keyboard: [
              [
                {
                  text: '🔄 بررسی دوباره',
                  callback_data: 'usr:adcheck:' + String(order.id),
                },
              ],
              [
                {
                  text: '💳 ساخت لینک پرداخت جدید',
                  callback_data: 'usr:adpay:' + String(order.id),
                },
              ],
            ],
          },
        );
      }
    } catch {
      await this.sendMessage(
        chatId,
        'سفارش پیدا نشد.',
        this.getAdsHomeKeyboard(),
      );
    }
  }

  private async startAdContentFlow(
    chatId: ChatId,
    platformUserId: string,
    orderId: string,
  ): Promise<void> {
    try {
      const order = await this.adsService.getUserOrder(
        orderId,
        this.platform,
        platformUserId,
      );
      if (!(await this.adsService.isOrderPaid(order.id))) {
        await this.sendMessage(
          chatId,
          'ابتدا پرداخت این سفارش باید تأیید شود.',
        );
        return;
      }

      if (
        [
          'READY_REVIEW',
          'APPROVED',
          'PUBLISHING',
          'COMPLETED',
          'REJECTED',
        ].includes(String(order.status))
      ) {
        await this.sendUserAdOrderDetails(chatId, platformUserId, order.id);
        return;
      }

      const steps: Array<AwaitingAdContentSession['step']> = [
        'businessName',
        'subject',
        'rawAdText',
        'phone',
        'address',
        'links',
        'cta',
        'preferredSchedule',
        'media',
      ];
      const values: Record<string, unknown> = {
        businessName: order.businessName,
        subject: order.subject,
        rawAdText: order.rawAdText,
        phone: order.phone,
        address: order.address,
        links: order.links,
        cta: order.cta,
        preferredSchedule: order.preferredSchedule,
      };
      const step =
        steps.find(
          (name) => name === 'media' || !String(values[name] ?? '').trim(),
        ) ?? 'media';

      const session: AwaitingAdContentSession = {
        mode: 'awaiting_ad_content',
        orderId: order.id,
        step,
        mediaCount: Array.isArray(order.assets) ? order.assets.length : 0,
      };
      this.sessions.set(chatId, session);
      this.saveState();
      await this.askAdContentStep(chatId, session, order);
    } catch (error: any) {
      await this.sendMessage(
        chatId,
        'شروع تکمیل سفارش با خطا روبه‌رو شد: ' +
          String(error?.message ?? 'خطا'),
      );
    }
  }

  private async askAdContentStep(
    chatId: ChatId,
    session: AwaitingAdContentSession,
    order?: any,
  ): Promise<void> {
    const labels: Record<AwaitingAdContentSession['step'], string[]> = {
      businessName: [
        '🏪 نام کسب‌وکار / برند',
        '',
        'نام دقیق کسب‌وکار، مجموعه، فروشگاه یا برندی که تبلیغ برای آن است را بفرستید.',
      ],
      subject: [
        '🎯 موضوع تبلیغ',
        '',
        'خیلی کوتاه بگویید چه چیزی قرار است تبلیغ شود؛ مثلاً افتتاحیه، محصول، تخفیف، استخدام یا معرفی خدمات.',
      ],
      rawAdText: [
        '📝 متن اولیه تبلیغ',
        '',
        'متن، توضیحات یا نکاتی که دوست دارید در تبلیغ باشد را یک‌جا ارسال کنید.',
        'لازم نیست حرفه‌ای نوشته شده باشد؛ سامانه برای تحریریه نسخه‌های پیشنهادی هوشمند هم می‌سازد.',
      ],
      phone: [
        '☎️ شماره تماس تبلیغ',
        '',
        'شماره‌ای که اجازه دارید در آگهی منتشر شود را ارسال کنید.',
        'اگر لازم نیست، فقط «-» بفرستید.',
      ],
      address: [
        '📍 آدرس',
        '',
        'آدرس قابل انتشار کسب‌وکار را بنویسید.',
        'اگر تبلیغ آدرس ندارد، «-» بفرستید.',
      ],
      links: [
        '🔗 لینک‌ها',
        '',
        'لینک سایت، اینستاگرام، کانال یا صفحه سفارش را بفرستید.',
        'چند لینک را می‌توانید در یک پیام بنویسید. اگر ندارید «-» بفرستید.',
      ],
      cta: [
        '📣 دعوت به اقدام',
        '',
        'دوست دارید مخاطب بعد از دیدن تبلیغ چه کاری انجام دهد؟ مثل «تماس بگیرید»، «پیام بدهید» یا «حضوری مراجعه کنید».',
        'اگر انتخاب خاصی ندارید «-» بفرستید.',
      ],
      preferredSchedule: [
        '🗓 زمان ترجیحی انتشار',
        '',
        'اگر روز یا ساعت خاصی مدنظر دارید بنویسید. زمان قطعی بعد از هماهنگی تحریریه تعیین می‌شود.',
        'اگر فرقی ندارد «-» بفرستید.',
      ],
      media: [
        '📎 فایل‌های تبلیغ',
        '',
        'عکس، پوستر، ویدئو، فایل یا صوت تبلیغ را همین‌جا بفرستید. می‌توانید چند فایل پشت سر هم ارسال کنید.',
        '',
        'پس از پایان ارسال، دکمه «✅ پایان و ارسال برای تحریریه» را بزنید.',
        session.mediaCount > 0
          ? 'تعداد فایل‌های ثبت‌شده: ' +
            this.toPersianNumber(session.mediaCount)
          : 'اگر تبلیغ فقط متنی است، بدون فایل هم می‌توانید ادامه دهید.',
      ],
    };

    const keyboard =
      session.step === 'media'
        ? {
            inline_keyboard: [
              [
                {
                  text: '✅ پایان و ارسال برای تحریریه',
                  callback_data: 'usr:adfinishmedia:' + session.orderId,
                },
              ],
              [
                {
                  text: '📂 وضعیت سفارش',
                  callback_data: 'usr:adorder:' + session.orderId,
                },
              ],
            ],
          }
        : this.getAdsHomeKeyboard();

    await this.sendMessage(
      chatId,
      [
        '📣 تکمیل سفارش تبلیغ',
        order?.orderCode ? '🧾 ' + String(order.orderCode) : '',
        '',
        ...labels[session.step],
      ]
        .filter(Boolean)
        .join('\n'),
      keyboard,
    );
  }

  private async handleAdContentInput(
    message: BaleMessage,
    session: AwaitingAdContentSession,
    text: string,
    hasMedia: boolean,
  ): Promise<void> {
    const chatId = String(message.chat.id);
    const platformUserId = this.getPlatformUserId(message);

    if (session.step === 'media') {
      if (hasMedia) {
        const media = this.getMediaPersistenceData(message);
        try {
          await this.adsService.addAsset(
            session.orderId,
            this.platform,
            platformUserId,
            {
              sourceChatId: String(message.chat.id),
              sourceMessageId: String(message.message_id),
              ...media,
            },
          );
          session.mediaCount += 1;
          this.sessions.set(chatId, session);
          this.saveState();
          await this.sendMessage(
            chatId,
            '✅ ' +
              this.getMediaLabel(message) +
              ' ثبت شد. تعداد فایل‌ها: ' +
              this.toPersianNumber(session.mediaCount),
            {
              inline_keyboard: [
                [
                  {
                    text: '✅ پایان و ارسال برای تحریریه',
                    callback_data: 'usr:adfinishmedia:' + session.orderId,
                  },
                ],
              ],
            },
          );
        } catch (error: any) {
          await this.sendMessage(
            chatId,
            'ثبت فایل با خطا روبه‌رو شد: ' + String(error?.message ?? 'خطا'),
          );
        }
        return;
      }

      const normalized = text.replace(/[.!؟?]/g, '').trim();
      if (['تمام', 'پایان', 'ندارم', '-', 'ثبت نهایی'].includes(normalized)) {
        this.sessions.delete(chatId);
        await this.finalizeAdOrder(chatId, session.orderId, false);
        return;
      }

      await this.askAdContentStep(chatId, session);
      return;
    }

    if (!text) {
      await this.sendMessage(
        chatId,
        'لطفاً پاسخ این مرحله را به‌صورت متن ارسال کنید.',
      );
      return;
    }

    if (session.step === 'businessName' && text.length < 2) {
      await this.sendMessage(chatId, 'نام کسب‌وکار خیلی کوتاه است.');
      return;
    }
    if (session.step === 'subject' && text.length < 3) {
      await this.sendMessage(chatId, 'موضوع تبلیغ را کمی روشن‌تر بنویسید.');
      return;
    }
    if (session.step === 'rawAdText' && text.length < 10) {
      await this.sendMessage(
        chatId,
        'برای آماده‌سازی تبلیغ، توضیح کمی بیشتری لازم است.',
      );
      return;
    }

    const field = session.step;
    try {
      await this.adsService.updateOrderContent(
        session.orderId,
        this.platform,
        platformUserId,
        {
          [field]: text === '-' ? '—' : text,
        },
      );

      const order = await this.adsService.getUserOrder(
        session.orderId,
        this.platform,
        platformUserId,
      );
      const steps: Array<AwaitingAdContentSession['step']> = [
        'businessName',
        'subject',
        'rawAdText',
        'phone',
        'address',
        'links',
        'cta',
        'preferredSchedule',
        'media',
      ];
      const index = steps.indexOf(field);
      session.step = steps[Math.min(steps.length - 1, index + 1)];
      this.sessions.set(chatId, session);
      this.saveState();
      await this.askAdContentStep(chatId, session, order);
    } catch (error: any) {
      await this.sendMessage(
        chatId,
        'ثبت این مرحله با خطا روبه‌رو شد: ' + String(error?.message ?? 'خطا'),
      );
    }
  }

  private async finalizeAdOrder(
    chatId: ChatId,
    orderId: string,
    skipQuestions: boolean,
  ): Promise<void> {
    await this.sendChatAction(chatId, 'typing');
    try {
      const review = await this.adsService.analyzeOrderWithAi(orderId);
      if (!skipQuestions && review?.missingQuestions?.length) {
        this.sessions.set(chatId, {
          mode: 'awaiting_ad_ai_followup',
          orderId,
          questions: review.missingQuestions,
        });
        await this.sendMessage(
          chatId,
          [
            '🤖 یک بررسی نهایی برای تکمیل تبلیغ انجام شد.',
            '',
            'برای اینکه پرونده کامل‌تر به تحریریه برسد، لطفاً به این موارد در یک پیام پاسخ بدهید:',
            '',
            ...review.missingQuestions.map(
              (q, i) => this.toPersianNumber(i + 1) + ') ' + q,
            ),
          ].join('\n'),
          this.getAdsHomeKeyboard(),
        );
        return;
      }

      const order = await this.adsService.markReadyForReview(orderId);
      this.sessions.delete(chatId);
      await this.sendMessage(
        chatId,
        [
          '✅ سفارش تبلیغ برای بررسی تحریریه ارسال شد',
          '',
          '🧾 کد سفارش: ' + String(order.orderCode),
          '📌 وضعیت: آماده بررسی تحریریه',
          '',
          'بعد از بررسی، اگر اصلاحی لازم باشد از همین ربات اطلاع داده می‌شود. انتشار نهایی پس از تأیید تحریریه انجام خواهد شد.',
        ].join('\n'),
        {
          inline_keyboard: [
            [
              {
                text: '📂 مشاهده سفارش',
                callback_data: 'usr:adorder:' + String(order.id),
              },
            ],
            [{ text: '📣 مرکز تبلیغات', callback_data: 'usr:ads' }],
          ],
        },
      );

      await this.sendAdEditorialCard(String(order.id), true);
      await this.copyAdAssetsToEditorial(String(order.id));
    } catch (error: any) {
      this.logger.warn(
        'Finalize ad order failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'ارسال سفارش برای تحریریه با خطا روبه‌رو شد: ' +
          String(error?.message ?? 'خطا'),
        this.getAdsHomeKeyboard(),
      );
    }
  }

  private async copyAdAssetsToEditorial(orderId: string): Promise<void> {
    const editorialChatId = this.getEditorialChatId();
    if (editorialChatId === null) return;

    try {
      const order = await this.adsService.getOrder(orderId);
      const pending = order.assets.filter(
        (asset: any) => !asset.editorialCopiedAt,
      );
      if (!pending.length) return;

      await this.sendEditorialMessage(
        '📎 فایل‌های سفارش تبلیغ ' +
          String(order.orderCode) +
          ' | ' +
          this.toPersianNumber(pending.length) +
          ' مورد',
      );

      for (const asset of pending) {
        try {
          await this.apiPost('copyMessage', {
            chat_id: editorialChatId,
            from_chat_id: String(asset.sourceChatId),
            message_id: String(asset.sourceMessageId),
          });
          await this.adsService.markAssetCopied(String(asset.id));
        } catch (error: any) {
          this.logger.warn(
            'Copy ad asset failed: ' + (error?.message ?? 'Unknown error'),
          );
        }
        await this.delay(80);
      }
    } catch (error: any) {
      this.logger.warn(
        'Copy ad assets failed: ' + (error?.message ?? 'Unknown error'),
      );
    }
  }

  private async sendUserAdOrders(
    chatId: ChatId,
    platformUserId: string,
  ): Promise<void> {
    const orders = await this.adsService.listUserOrders(
      this.platform,
      platformUserId,
      10,
    );
    if (!orders.length) {
      await this.sendMessage(chatId, '📂 هنوز سفارش تبلیغاتی ثبت نکرده‌اید.', {
        inline_keyboard: [
          [{ text: '🛒 مشاهده بسته‌ها', callback_data: 'usr:adpkgs' }],
          [{ text: '📣 مرکز تبلیغات', callback_data: 'usr:ads' }],
        ],
      });
      return;
    }

    const rows = orders.map((order: any) => [
      {
        text:
          String(order.orderCode) +
          ' | ' +
          this.getAdStatusLabel(String(order.status)),
        callback_data: 'usr:adorder:' + String(order.id),
      },
    ]);
    rows.push([{ text: '🛒 خرید بسته جدید', callback_data: 'usr:adpkgs' }]);
    rows.push([{ text: '📣 بازگشت', callback_data: 'usr:ads' }]);

    await this.sendMessage(
      chatId,
      '📂 سفارش‌های تبلیغاتی شما\n\nیک سفارش را انتخاب کنید:',
      { inline_keyboard: rows },
    );
  }

  private async sendUserAdOrderDetails(
    chatId: ChatId,
    platformUserId: string,
    orderId: string,
  ): Promise<void> {
    try {
      const order = await this.adsService.getUserOrder(
        orderId,
        this.platform,
        platformUserId,
      );
      const progress = this.adsService.getPublicationProgress(order);
      const snapshot: any = order.packageSnapshot ?? {};
      const lines = [
        '📣 سفارش تبلیغ',
        '',
        '🧾 کد: ' + String(order.orderCode),
        '📦 بسته: ' + String(snapshot.title ?? order.package?.title ?? '—'),
        '💳 مبلغ: ' + this.formatToman(Number(order.amountToman)),
        '📌 وضعیت: ' + this.getAdStatusLabel(String(order.status)),
        order.businessName
          ? '🏪 کسب‌وکار: ' + this.displayAdValue(order.businessName)
          : '',
        order.subject ? '🎯 موضوع: ' + this.displayAdValue(order.subject) : '',
        Array.isArray(order.assets)
          ? '📎 فایل‌ها: ' + this.toPersianNumber(order.assets.length)
          : '',
        progress.expectedTotal > 0
          ? '📤 انتشار انجام‌شده: ' +
            this.toPersianNumber(progress.doneTotal) +
            ' از ' +
            this.toPersianNumber(progress.expectedTotal)
          : '',
        order.assignedToDisplayName
          ? '👤 مسئول تحریریه: ' + String(order.assignedToDisplayName)
          : '',
        order.reviewNote
          ? '\n📝 پیام تحریریه:\n' + String(order.reviewNote)
          : '',
      ].filter(Boolean);

      const keyboard: any[] = [];
      if (
        ['AWAITING_PAYMENT', 'PAYMENT_PENDING'].includes(String(order.status))
      ) {
        keyboard.push([
          {
            text: '💳 پرداخت / تلاش مجدد',
            callback_data: 'usr:adpay:' + String(order.id),
          },
        ]);
        keyboard.push([
          {
            text: '🔄 بررسی پرداخت',
            callback_data: 'usr:adcheck:' + String(order.id),
          },
        ]);
      }
      if (['PAID', 'COLLECTING_CONTENT'].includes(String(order.status))) {
        keyboard.push([
          {
            text: '📝 ادامه تکمیل سفارش',
            callback_data: 'usr:adcontinue:' + String(order.id),
          },
        ]);
      }
      if (String(order.status) === 'NEEDS_REVISION') {
        keyboard.push([
          {
            text: '✏️ ارسال اصلاحات',
            callback_data: 'usr:adrev:' + String(order.id),
          },
        ]);
      }
      keyboard.push([
        { text: '📂 سفارش‌های من', callback_data: 'usr:adorders' },
      ]);
      keyboard.push([{ text: '📣 مرکز تبلیغات', callback_data: 'usr:ads' }]);

      await this.sendMessage(chatId, lines.join('\n'), {
        inline_keyboard: keyboard,
      });
    } catch {
      await this.sendMessage(
        chatId,
        'سفارش پیدا نشد.',
        this.getAdsHomeKeyboard(),
      );
    }
  }

  private async sendAdRules(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '📋 قوانین و روند تبلیغات کازرون خبر',
        '',
        '• پرداخت هزینه به‌معنای انتشار بدون بررسی نیست؛ محتوا ابتدا توسط تحریریه بررسی می‌شود.',
        '• ادعاهای گمراه‌کننده، غیرقانونی، بدون مجوز لازم یا ناقض حقوق دیگران قابل انتشار نیستند.',
        '• مسئولیت صحت قیمت، شماره تماس، آدرس، مجوزها و ادعاهای تجاری ارائه‌شده بر عهده سفارش‌دهنده است.',
        '• اطلاعات خصوصی گزارش‌های مردمی برای هدف‌گیری تبلیغات استفاده نمی‌شود.',
        '• زمان ترجیحی انتشار قطعی نیست و زمان نهایی با برنامه تحریریه هماهنگ می‌شود.',
        '• پس از انتشار هر نوبت، تحریریه آن را در پرونده سفارش ثبت می‌کند تا تعداد تعهدات باقی‌مانده مشخص باشد.',
        '',
        'در صورت رد تبلیغ، وضعیت و توضیح تحریریه در پرونده سفارش ثبت می‌شود.',
      ].join('\n'),
      this.getAdsHomeKeyboard(),
    );
  }

  private getAdsHomeKeyboard(): object {
    return {
      inline_keyboard: [
        [{ text: '📂 سفارش‌های من', callback_data: 'usr:adorders' }],
        [{ text: '📣 مرکز تبلیغات', callback_data: 'usr:ads' }],
        [{ text: '🏠 منوی اصلی', callback_data: 'usr:home' }],
      ],
    };
  }

  private async sendAdsAdminMenu(chatId: ChatId): Promise<void> {
    const stats = await this.adsService.getStats().catch(() => null);
    await this.sendMessage(
      chatId,
      [
        '📣 مدیریت تبلیغات | تحریریه',
        '',
        'فروش بسته، پرداخت، دریافت محتوا و کنترل انتشار دستی کانال‌ها از این پنل مدیریت می‌شود.',
        stats
          ? '💰 فروش تأییدشده: ' + this.formatToman(Number(stats.revenueToman))
          : '',
        stats
          ? '🧾 کل سفارش‌ها: ' + this.toPersianNumber(Number(stats.orders))
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        inline_keyboard: [
          [
            { text: '➕ ساخت بسته تبلیغاتی', callback_data: 'ada:pkgadd' },
            { text: '📦 مدیریت بسته‌ها', callback_data: 'ada:pkgs' },
          ],
          [
            { text: '🟢 آماده بررسی', callback_data: 'ada:list:READY' },
            { text: '📤 در حال انتشار', callback_data: 'ada:list:PUBLISHING' },
          ],
          [
            { text: '💳 پرداخت‌شده / ناقص', callback_data: 'ada:list:PAID' },
            { text: '🗂 آخرین سفارش‌ها', callback_data: 'ada:list:ALL' },
          ],
          [{ text: '📊 آمار تبلیغات', callback_data: 'ada:stats' }],
        ],
      },
    );
  }

  private async sendAdPackageAdminList(chatId: ChatId): Promise<void> {
    const packages = await this.adsService.listPackagesAdmin();
    if (!packages.length) {
      await this.sendMessage(chatId, 'هنوز بسته تبلیغاتی ساخته نشده است.', {
        inline_keyboard: [
          [{ text: '➕ ساخت اولین بسته', callback_data: 'ada:pkgadd' }],
        ],
      });
      return;
    }

    const rows = packages.map((pkg: any) => [
      {
        text:
          (pkg.isActive ? '🟢 ' : '⚪️ ') +
          String(pkg.title) +
          ' | ' +
          this.formatToman(Number(pkg.priceToman)),
        callback_data: 'ada:pkg:' + String(pkg.id),
      },
    ]);
    rows.push([{ text: '➕ بسته جدید', callback_data: 'ada:pkgadd' }]);
    await this.sendMessage(chatId, '📦 مدیریت بسته‌های تبلیغاتی', {
      inline_keyboard: rows,
    });
  }

  private async sendAdPackageAdminCard(
    chatId: ChatId,
    packageId: string,
  ): Promise<void> {
    const pkg = await this.adsService.getPackage(packageId);
    const placements = this.adsService.normalizePlacements(pkg.placements);
    await this.sendMessage(
      chatId,
      [
        '📦 بسته تبلیغاتی',
        '',
        'عنوان: ' + String(pkg.title),
        'کد: ' + String(pkg.code),
        'قیمت: ' + this.formatToman(Number(pkg.priceToman)),
        'انتشار: ' +
          placements
            .map(
              (p) =>
                this.getAdChannelLabel(p.channel) +
                '=' +
                this.toPersianNumber(p.count),
            )
            .join(' | '),
        Number(pkg.pinHours) > 0
          ? 'پین: ' + this.toPersianNumber(Number(pkg.pinHours)) + ' ساعت'
          : 'پین: ندارد',
        'وضعیت: ' + (pkg.isActive ? '🟢 فعال' : '⚪️ غیرفعال'),
        pkg.description ? '\n' + String(pkg.description) : '',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        inline_keyboard: [
          [
            {
              text: '✏️ ویرایش بسته',
              callback_data: 'ada:pkgedit:' + String(pkg.id),
            },
          ],
          [
            {
              text: pkg.isActive ? '⏸ غیرفعال کردن' : '▶️ فعال کردن',
              callback_data: 'ada:pkgtoggle:' + String(pkg.id),
            },
          ],
          [{ text: '📦 فهرست بسته‌ها', callback_data: 'ada:pkgs' }],
        ],
      },
    );
  }

  private async sendAdOrdersAdminList(
    chatId: ChatId,
    filter: string,
  ): Promise<void> {
    const orders = await this.adsService.listOrdersAdmin(filter, 20);
    if (!orders.length) {
      await this.sendMessage(chatId, 'در این بخش سفارشی وجود ندارد.');
      return;
    }

    const rows = orders.map((order: any) => [
      {
        text:
          String(order.orderCode) +
          ' | ' +
          this.getAdStatusLabel(String(order.status)),
        callback_data: 'ada:order:' + String(order.id),
      },
    ]);
    await this.sendMessage(chatId, '🧾 سفارش‌های تبلیغاتی', {
      inline_keyboard: rows,
    });
  }

  private async sendAdEditorialCard(
    orderId: string,
    sendNew = false,
  ): Promise<void> {
    const order = await this.adsService.getOrder(orderId);
    const review = this.adsService.readAiReview(order.aiReview);
    const progress = this.adsService.getPublicationProgress(order);
    const snapshot: any = order.packageSnapshot ?? {};
    const payment = order.payments.find(
      (item: any) => item.status === 'VERIFIED',
    );

    const lines = [
      '📣 پرونده تبلیغاتی | ' + String(order.orderCode),
      '',
      '📌 وضعیت: ' + this.getAdStatusLabel(String(order.status)),
      '📦 بسته: ' + String(snapshot.title ?? order.package?.title ?? '—'),
      '💰 مبلغ: ' + this.formatToman(Number(order.amountToman)),
      payment
        ? '✅ پرداخت تأییدشده | پیگیری: ' + String(payment.refId ?? '—')
        : '⚠️ پرداخت تأییدشده ثبت نشده',
      '',
      '👤 مشتری: ' + String(order.displayName ?? order.platformUserId),
      order.username ? '🆔 @' + String(order.username).replace(/^@/, '') : '',
      '🏪 کسب‌وکار: ' + this.displayAdValue(order.businessName),
      '🎯 موضوع: ' + this.displayAdValue(order.subject),
      '☎️ تماس: ' + this.displayAdValue(order.phone),
      '📍 آدرس: ' + this.displayAdValue(order.address),
      '🔗 لینک: ' + this.displayAdValue(order.links),
      '📣 CTA: ' + this.displayAdValue(order.cta),
      '🗓 زمان ترجیحی: ' + this.displayAdValue(order.preferredSchedule),
      '',
      '📝 متن اولیه:\n' + String(order.rawAdText ?? '—'),
      order.extraInfo ? '\n➕ اطلاعات تکمیلی:\n' + String(order.extraInfo) : '',
      '',
      '📎 فایل‌ها: ' +
        this.toPersianNumber(
          Array.isArray(order.assets) ? order.assets.length : 0,
        ),
      progress.expectedTotal > 0
        ? '📤 پیشرفت انتشار: ' +
          this.toPersianNumber(progress.doneTotal) +
          '/' +
          this.toPersianNumber(progress.expectedTotal)
        : '',
      order.assignedToDisplayName
        ? '👤 مسئول: ' + String(order.assignedToDisplayName)
        : '',
      review
        ? '\n🤖 بررسی هوشمند: ' + String(review.summary || 'انجام شد')
        : '\n🤖 بررسی هوشمند: در دسترس نبود / انجام نشده',
      review?.riskFlags?.length
        ? '⚠️ نکات بررسی: ' + review.riskFlags.join(' | ')
        : '',
      review ? 'AI suitability: ' + review.suitability : '',
      order.finalAdText
        ? '\n✅ متن نهایی انتخاب‌شده:\n' + String(order.finalAdText)
        : '',
    ].filter(Boolean);

    const keyboard: any[] = [];
    if (review?.variants?.length) {
      const aiButtons = review.variants.slice(0, 3).map((variant, index) => ({
        text: '🤖 ' + String(index + 1) + ' ' + variant.label,
        callback_data: 'ada:ai' + String(index) + ':' + String(order.id),
      }));
      keyboard.push(aiButtons);
    }
    keyboard.push([
      {
        text: '📝 متن نهایی دستی',
        callback_data: 'ada:finaltext:' + String(order.id),
      },
    ]);
    if (
      String(order.status) === 'READY_REVIEW' ||
      String(order.status) === 'NEEDS_REVISION'
    ) {
      keyboard.push([
        {
          text: '✅ تأیید برای انتشار',
          callback_data: 'ada:approve:' + String(order.id),
        },
        {
          text: '✏️ نیاز به اصلاح',
          callback_data: 'ada:rev:' + String(order.id),
        },
      ]);
      keyboard.push([
        {
          text: '❌ رد تبلیغ',
          callback_data: 'ada:reject:' + String(order.id),
        },
        {
          text: '👤 مسئولیت با من',
          callback_data: 'ada:assign:' + String(order.id),
        },
      ]);
    }
    if (Array.isArray(order.assets) && order.assets.length) {
      keyboard.push([
        {
          text: '📎 ارسال فایل‌ها به گروه',
          callback_data: 'ada:media:' + String(order.id),
        },
      ]);
    }
    if (['APPROVED', 'PUBLISHING'].includes(String(order.status))) {
      for (const row of progress.rows) {
        if (row.done < row.expected) {
          keyboard.push([
            {
              text:
                '✅ ثبت انتشار ' +
                this.getAdChannelLabel(row.channel) +
                ' (' +
                this.toPersianNumber(row.done) +
                '/' +
                this.toPersianNumber(row.expected) +
                ')',
              callback_data: 'ada:pub:' + row.channel + ':' + String(order.id),
            },
          ]);
        }
      }
    }
    keyboard.push([
      { text: '🔄 تازه‌سازی', callback_data: 'ada:order:' + String(order.id) },
    ]);

    if (sendNew) {
      await this.sendEditorialMessage(lines.join('\n'), {
        inline_keyboard: keyboard,
      });
    } else {
      const editorialChatId = this.getEditorialChatId();
      if (editorialChatId !== null) {
        await this.sendMessage(editorialChatId, lines.join('\n'), {
          inline_keyboard: keyboard,
        });
      }
    }
  }

  private async handleAdsAdminCallback(
    query: BaleCallbackQuery,
  ): Promise<void> {
    const message = query.message;
    const data = String(query.data ?? '').trim();
    if (!message || !this.isEditorialChat(message.chat.id)) {
      await this.answerCallbackQuery(
        query.id,
        'این دکمه فقط در گروه تحریریه فعال است.',
      );
      return;
    }
    if (!this.isEditorialOperatorAllowed(query.from)) {
      await this.answerCallbackQuery(
        query.id,
        'شما مجوز این عملیات را ندارید.',
        true,
      );
      return;
    }
    await this.answerCallbackQuery(query.id);

    const chatId = String(message.chat.id);
    const key = this.getEditorialSessionKey(message.chat.id, query.from.id);
    const actorName = this.getEditorialOperatorName(query.from);
    const actor = actorName + ' (' + String(query.from.id) + ')';

    try {
      if (data === 'ada:pkgadd') {
        this.adEditorialSessions.set(key, { action: 'add_package' });
        await this.sendMessage(
          chatId,
          [
            '➕ ساخت بسته تبلیغاتی',
            '',
            'اطلاعات را در یک پیام با این قالب بفرستید:',
            '',
            'عنوان: بسته ویژه چهار کاناله',
            'کد: VIP4',
            'قیمت: 1500000',
            'انتشار: بله=1, ایتا=1, روبیکا=1, سروش=1',
            'پین: 0',
            'توضیح: یک نوبت انتشار در چهار رسانه',
            '',
            'قیمت به تومان است. «عنوان»، «قیمت» و «انتشار» الزامی هستند.',
          ].join('\n'),
        );
        return;
      }
      if (data === 'ada:pkgs') {
        await this.sendAdPackageAdminList(chatId);
        return;
      }
      if (data.startsWith('ada:pkg:')) {
        await this.sendAdPackageAdminCard(
          chatId,
          data.slice('ada:pkg:'.length),
        );
        return;
      }
      if (data.startsWith('ada:pkgedit:')) {
        const packageId = data.slice('ada:pkgedit:'.length);
        this.adEditorialSessions.set(key, {
          action: 'edit_package',
          packageId,
        });
        await this.sendMessage(
          chatId,
          [
            '✏️ ویرایش بسته تبلیغاتی',
            '',
            'فقط فیلدهایی که می‌خواهید تغییر کنند بفرستید:',
            '',
            'عنوان: ...',
            'کد: ...',
            'قیمت: ...',
            'انتشار: بله=1, ایتا=2, روبیکا=1, سروش=1',
            'پین: ...',
            'توضیح: ...',
          ].join('\n'),
        );
        return;
      }
      if (data.startsWith('ada:pkgtoggle:')) {
        const packageId = data.slice('ada:pkgtoggle:'.length);
        await this.adsService.togglePackage(packageId, actor);
        await this.sendAdPackageAdminCard(chatId, packageId);
        return;
      }
      if (data.startsWith('ada:list:')) {
        await this.sendAdOrdersAdminList(
          chatId,
          data.slice('ada:list:'.length),
        );
        return;
      }
      if (data.startsWith('ada:order:')) {
        await this.sendAdEditorialCard(data.slice('ada:order:'.length), false);
        return;
      }
      if (data.startsWith('ada:media:')) {
        await this.copyAdAssetsToEditorial(data.slice('ada:media:'.length));
        return;
      }
      if (data.startsWith('ada:assign:')) {
        const orderId = data.slice('ada:assign:'.length);
        await this.adsService.assignOrder(
          orderId,
          String(query.from.id),
          actorName,
        );
        await this.sendAdEditorialCard(orderId, false);
        return;
      }
      if (
        data.startsWith('ada:ai0:') ||
        data.startsWith('ada:ai1:') ||
        data.startsWith('ada:ai2:')
      ) {
        const index = Number(data.slice(6, 7));
        const orderId = data.slice(8);
        await this.adsService.selectAiVariant(orderId, index, actor);
        await this.sendAdEditorialCard(orderId, false);
        return;
      }
      if (data.startsWith('ada:finaltext:')) {
        const orderId = data.slice('ada:finaltext:'.length);
        this.adEditorialSessions.set(key, {
          action: 'set_final_text',
          orderId,
        });
        await this.sendMessage(
          chatId,
          '📝 متن نهایی تبلیغ را کامل در یک پیام ارسال کنید.',
        );
        return;
      }
      if (data.startsWith('ada:approve:')) {
        const orderId = data.slice('ada:approve:'.length);
        const order = await this.adsService.approveOrder(orderId, actor);
        await this.notifyAdCustomer(
          order,
          '✅ تبلیغ شما توسط تحریریه تأیید شد و وارد مرحله انتشار شده است.',
        );
        await this.sendAdEditorialCard(orderId, false);
        return;
      }
      if (data.startsWith('ada:rev:')) {
        const orderId = data.slice('ada:rev:'.length);
        this.adEditorialSessions.set(key, {
          action: 'revision_request',
          orderId,
        });
        await this.sendMessage(
          chatId,
          '✏️ دلیل یا موارد اصلاحی را در یک پیام برای مشتری بنویسید.',
        );
        return;
      }
      if (data.startsWith('ada:reject:')) {
        const orderId = data.slice('ada:reject:'.length);
        this.adEditorialSessions.set(key, { action: 'reject_order', orderId });
        await this.sendMessage(
          chatId,
          '❌ دلیل رد تبلیغ را در یک پیام بنویسید.',
        );
        return;
      }
      if (data.startsWith('ada:pub:')) {
        const rest = data.slice('ada:pub:'.length);
        const split = rest.indexOf(':');
        const channel = rest.slice(0, split);
        const orderId = rest.slice(split + 1);
        this.adEditorialSessions.set(key, {
          action: 'publication_link',
          orderId,
          channel,
        });
        await this.sendMessage(
          chatId,
          '🔗 اگر لینک پست منتشرشده را دارید بفرستید. اگر لینک لازم نیست یا در دسترس نیست، فقط «-» بفرستید.',
        );
        return;
      }
      if (data === 'ada:stats') {
        const stats = await this.adsService.getStats();
        await this.sendMessage(
          chatId,
          [
            '📊 آمار تبلیغات',
            '',
            '📦 بسته فعال: ' + this.toPersianNumber(stats.activePackages),
            '🧾 کل سفارش‌ها: ' + this.toPersianNumber(stats.orders),
            '✅ پرداخت‌های تأییدشده: ' +
              this.toPersianNumber(stats.verifiedPayments),
            '💰 فروش تأییدشده: ' + this.formatToman(stats.revenueToman),
            '',
            'آماده بررسی: ' +
              this.toPersianNumber(Number(stats.byStatus.READY_REVIEW ?? 0)),
            'در حال انتشار: ' +
              this.toPersianNumber(Number(stats.byStatus.PUBLISHING ?? 0)),
            'تکمیل‌شده: ' +
              this.toPersianNumber(Number(stats.byStatus.COMPLETED ?? 0)),
          ].join('\n'),
        );
        return;
      }
    } catch (error: any) {
      this.logger.warn(
        'Ads admin callback failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        chatId,
        'عملیات تبلیغات با خطا روبه‌رو شد: ' + String(error?.message ?? 'خطا'),
      );
    }
  }

  private async handleAdEditorialText(
    message: BaleMessage,
    session: AdEditorialSession,
    key: string,
  ): Promise<void> {
    const user = message.from;
    if (!user || !this.isEditorialOperatorAllowed(user)) {
      this.adEditorialSessions.delete(key);
      return;
    }

    const text = String(message.text ?? message.caption ?? '').trim();
    if (!text) {
      await this.sendMessage(
        message.chat.id,
        'لطفاً پاسخ را به‌صورت متن ارسال کنید.',
      );
      return;
    }

    const actorName = this.getEditorialOperatorName(user);
    const actor = actorName + ' (' + String(user.id) + ')';

    try {
      if (
        session.action === 'add_package' ||
        session.action === 'edit_package'
      ) {
        const parsed = this.parseAdPackageForm(text);
        let pkg: any;
        if (session.action === 'add_package') {
          if (
            !parsed.title ||
            parsed.priceToman === undefined ||
            !parsed.placements?.length
          ) {
            await this.sendMessage(
              message.chat.id,
              '⚠️ عنوان، قیمت و انتشار الزامی هستند. قالب را دوباره کامل بفرستید.',
            );
            return;
          }
          pkg = await this.adsService.createPackage({
            ...parsed,
            createdBy: actor,
          } as any);
        } else {
          pkg = await this.adsService.updatePackage(String(session.packageId), {
            ...parsed,
            updatedBy: actor,
          } as any);
        }
        this.adEditorialSessions.delete(key);
        await this.sendMessage(
          message.chat.id,
          session.action === 'add_package'
            ? '✅ بسته تبلیغاتی ساخته شد.'
            : '✅ بسته تبلیغاتی ویرایش شد.',
        );
        await this.sendAdPackageAdminCard(
          String(message.chat.id),
          String(pkg.id),
        );
        return;
      }

      if (session.action === 'revision_request' && session.orderId) {
        const order = await this.adsService.requestRevision(
          session.orderId,
          text,
          actor,
        );
        this.adEditorialSessions.delete(key);
        await this.notifyAdCustomer(
          order,
          '✏️ تحریریه برای سفارش شما اصلاحاتی درخواست کرده است.\n\n' + text,
          true,
        );
        await this.sendMessage(
          message.chat.id,
          '✅ درخواست اصلاح برای مشتری ارسال شد.',
        );
        await this.sendAdEditorialCard(session.orderId, false);
        return;
      }

      if (session.action === 'reject_order' && session.orderId) {
        const order = await this.adsService.rejectOrder(
          session.orderId,
          text,
          actor,
        );
        this.adEditorialSessions.delete(key);
        await this.notifyAdCustomer(
          order,
          '❌ سفارش تبلیغ شما در بررسی تحریریه تأیید نشد.\n\nدلیل: ' + text,
        );
        await this.sendMessage(
          message.chat.id,
          '✅ وضعیت سفارش به ردشده تغییر کرد و مشتری مطلع شد.',
        );
        return;
      }

      if (session.action === 'set_final_text' && session.orderId) {
        await this.adsService.setFinalText(session.orderId, text, actor);
        this.adEditorialSessions.delete(key);
        await this.sendMessage(message.chat.id, '✅ متن نهایی تبلیغ ثبت شد.');
        await this.sendAdEditorialCard(session.orderId, false);
        return;
      }

      if (
        session.action === 'publication_link' &&
        session.orderId &&
        session.channel
      ) {
        const result = await this.adsService.recordPublication(
          session.orderId,
          session.channel,
          actor,
          text === '-' ? null : text,
        );
        this.adEditorialSessions.delete(key);
        await this.sendMessage(
          message.chat.id,
          result.completed
            ? '✅ آخرین انتشار ثبت شد؛ سفارش کامل شد.'
            : '✅ انتشار ثبت شد.',
        );
        if (result.completed) {
          await this.notifyAdCustomer(
            result.order,
            '🎉 تمام انتشارهای بسته تبلیغاتی شما طبق تعهد ثبت شد و سفارش با موفقیت تکمیل شد.',
          );
        } else {
          await this.notifyAdCustomer(
            result.order,
            '📤 یک نوبت انتشار در «' +
              this.getAdChannelLabel(session.channel) +
              '» ثبت شد.\n\nپیشرفت کل: ' +
              this.toPersianNumber(result.progress.doneTotal) +
              ' از ' +
              this.toPersianNumber(result.progress.expectedTotal),
          );
        }
        await this.sendAdEditorialCard(session.orderId, false);
        return;
      }
    } catch (error: any) {
      this.logger.warn(
        'Ad editorial input failed: ' + (error?.message ?? 'Unknown error'),
      );
      await this.sendMessage(
        message.chat.id,
        'عملیات با خطا روبه‌رو شد: ' + String(error?.message ?? 'خطا'),
      );
    }
  }

  private parseAdPackageForm(text: string): {
    title?: string;
    code?: string;
    priceToman?: number;
    placements?: AdPlacement[];
    pinHours?: number;
    description?: string | null;
  } {
    const result: any = {};
    for (const rawLine of String(text).split(/\r?\n/)) {
      const line = rawLine.trim();
      const split = line.indexOf(':');
      if (split < 0) continue;
      const key = line
        .slice(0, split)
        .trim()
        .replace(/ي/g, 'ی')
        .replace(/ك/g, 'ک');
      const value = line.slice(split + 1).trim();
      if (!value) continue;
      if (key === 'عنوان') result.title = value;
      else if (key === 'کد') result.code = value;
      else if (key === 'قیمت')
        result.priceToman = this.parsePersianInteger(value);
      else if (key === 'پین') result.pinHours = this.parsePersianInteger(value);
      else if (key === 'توضیح' || key === 'توضیحات') result.description = value;
      else if (key === 'انتشار' || key === 'کانال‌ها' || key === 'کانالها') {
        const placements: AdPlacement[] = [];
        for (const part of value.split(/[,،|]/)) {
          const item = part.trim();
          const match = item.match(/^(.+?)[=:×xX]\s*([۰-۹0-9]+)$/);
          if (!match) continue;
          const channel = this.adsService.normalizeChannel(match[1]);
          const count = this.parsePersianInteger(match[2]);
          if (channel && count > 0) placements.push({ channel, count });
        }
        if (placements.length) result.placements = placements;
      }
    }
    return result;
  }

  private parsePersianInteger(value: string): number {
    const map: Record<string, string> = {
      '۰': '0',
      '۱': '1',
      '۲': '2',
      '۳': '3',
      '۴': '4',
      '۵': '5',
      '۶': '6',
      '۷': '7',
      '۸': '8',
      '۹': '9',
    };
    const normalized = String(value)
      .split('')
      .map((ch) => map[ch] ?? ch)
      .join('')
      .replace(/[,_،\s]/g, '')
      .replace(/[^0-9-]/g, '');
    const num = Number(normalized);
    return Number.isFinite(num) ? Math.floor(num) : 0;
  }

  private async notifyAdCustomer(
    order: any,
    text: string,
    revisionButton = false,
  ): Promise<void> {
    if (String(order.platform) !== this.platform) return;
    const chatId = String(order.platformUserId);
    if (!chatId) return;

    const rows: any[] = [];
    if (revisionButton) {
      rows.push([
        {
          text: '✏️ ارسال اصلاحات',
          callback_data: 'usr:adrev:' + String(order.id),
        },
      ]);
    }
    rows.push([
      {
        text: '📂 مشاهده سفارش',
        callback_data: 'usr:adorder:' + String(order.id),
      },
    ]);

    try {
      await this.sendMessage(
        chatId,
        [text, '', '🧾 کد سفارش: ' + String(order.orderCode)].join('\n'),
        { inline_keyboard: rows },
      );
    } catch (error: any) {
      this.logger.warn(
        'Ad customer notification failed: ' +
          (error?.message ?? 'Unknown error'),
      );
    }
  }

  private getAdStatusLabel(status: string): string {
    const map: Record<string, string> = {
      AWAITING_PAYMENT: 'در انتظار پرداخت',
      PAYMENT_PENDING: 'در انتظار تأیید پرداخت',
      PAID: 'پرداخت‌شده؛ منتظر محتوا',
      COLLECTING_CONTENT: 'در حال تکمیل محتوا',
      READY_REVIEW: 'آماده بررسی تحریریه',
      NEEDS_REVISION: 'نیازمند اصلاح مشتری',
      APPROVED: 'تأییدشده',
      PUBLISHING: 'در حال انتشار',
      COMPLETED: 'تکمیل‌شده ✅',
      REJECTED: 'ردشده',
      CANCELED: 'لغوشده',
    };
    return map[status] ?? status;
  }

  private getAdChannelLabel(channel: string): string {
    const map: Record<string, string> = {
      BALE: 'بله',
      EITAA: 'ایتا',
      RUBIKA: 'روبیکا',
      SOROUSH: 'سروش',
    };
    return map[String(channel).toUpperCase()] ?? String(channel);
  }

  private formatToman(value: number): string {
    const amount = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    try {
      return new Intl.NumberFormat('fa-IR').format(amount) + ' تومان';
    } catch {
      return amount.toLocaleString() + ' تومان';
    }
  }

  private displayAdValue(value: unknown): string {
    const text = String(value ?? '').trim();
    if (!text || text === '—' || text === '-') return 'ثبت نشده';
    return text;
  }

  private async sendMainMenu(chatId: ChatId): Promise<void> {
    const text = [
      'کازرون خبر | صدای شهروندان',
      '',
      '📍 ثبت گزارش مردمی',
      'مشکل، دغدغه یا پیشنهادتان را همراه با محل و توضیح روشن ثبت کنید و کد رهگیری بگیرید.',
      '',
      '📣 مطالبات مردمی',
      'پرونده‌های عمومی تأییدشده را ببینید، حمایت کنید و تجربه یا مستند مرتبط بفرستید.',
      '',
      '🔎 پیگیری گزارش‌ها از همین حساب امکان‌پذیر است.',
      'هویت شما در صفحه عمومی مطالبات نمایش داده نمی‌شود.',
      '',
      'کازرون خبر؛ روایت اول کازرون',
    ].join('\n');

    await this.sendMessage(chatId, text, this.getMainInlineKeyboard());
  }

  private async sendReportInstructions(chatId: ChatId): Promise<void> {
    await this.sendMessage(
      chatId,
      [
        '📍 ثبت گزارش مردمی',
        'مرحله ۱ از ۳ · شرح موضوع',
        '',
        'در یک پیام بنویسید:',
        '• چه مشکل، دغدغه یا پیشنهادی دارید؟',
        '• محل یا محدوده دقیق کجاست؟',
        '• از چه زمانی وجود دارد؟ اگر قبلاً پیگیری کرده‌اید، چه نتیجه‌ای گرفتید؟',
        '',
        'متن ساده کافی است. در صورت نیاز چند پرسش کوتاه می‌پرسیم؛ سپس می‌توانید مستند اختیاری اضافه کنید و ثبت نهایی را بزنید.',
        'اطلاعات خصوصی نامرتبط افراد را ننویسید.',
        '',
        'شرح گزارش را همین‌جا ارسال کنید.',
      ].join('\n'),
      this.getReportEntryInlineKeyboard(),
    );
  }

  private getMainKeyboard(): object {
    return this.getMainInlineKeyboard();
  }

  private getMediaKeyboard(): object {
    return this.getMediaInlineKeyboard(0);
  }

  private getHomeKeyboard(): object {
    return this.getSimpleHomeInlineKeyboard();
  }

  private getMainInlineKeyboard(): object {
    return {
      inline_keyboard: [
        [{ text: '📍 ثبت گزارش مردمی', callback_data: 'usr:report' }],
        [{ text: '📣 مطالبات مردمی', callback_data: 'usr:demands' }],
        [
          { text: '📂 گزارش‌های من', callback_data: 'usr:myreports' },
          { text: '🔎 پیگیری با کد', callback_data: 'usr:track' },
        ],
        [{ text: 'ℹ️ راهنمای استفاده', callback_data: 'usr:guide' }],
      ],
    };
  }

  private getReportEntryInlineKeyboard(): object {
    return {
      inline_keyboard: [
        [
          {
            text: '💡 نمونه یک گزارش خوب',
            callback_data: 'usr:sample',
          },
        ],
        [
          {
            text: '❌ لغو و بازگشت',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getReportProgressInlineKeyboard(): object {
    return {
      inline_keyboard: [
        [
          {
            text: '🏠 منوی اصلی',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getAiQuestionInlineKeyboard(
    trackingCode: string,
    questionIndex: number,
  ): object {
    return {
      inline_keyboard: [
        [
          {
            text: '🤷 اطلاع ندارم',
            callback_data: 'usr:dontknow:' + trackingCode + ':' + questionIndex,
          },
        ],
      ],
    };
  }

  private getMediaInlineKeyboard(
    mediaCount: number,
    trackingCode = '',
  ): object {
    return {
      inline_keyboard: [
        [
          {
            text:
              mediaCount > 0
                ? '✅ پایان ارسال و ثبت نهایی'
                : '⏭ مستندی ندارم؛ ثبت نهایی',
            callback_data: 'usr:finishmedia:' + trackingCode,
          },
        ],
      ],
    };
  }

  private getFinalReportInlineKeyboard(trackingCode: string): object {
    return {
      inline_keyboard: [
        [
          {
            text: '🔎 وضعیت همین گزارش',
            callback_data: 'usr:status:' + trackingCode,
          },
        ],
        [
          {
            text: '➕ ثبت گزارش جدید',
            callback_data: 'usr:report',
          },
          {
            text: '🏠 منوی اصلی',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getTrackingInlineKeyboard(): object {
    return {
      inline_keyboard: [
        [
          {
            text: '📂 گزارش‌های من',
            callback_data: 'usr:my',
          },
          {
            text: '🏠 منوی اصلی',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getSimpleHomeInlineKeyboard(): object {
    return {
      inline_keyboard: [
        [
          {
            text: '🏠 منوی اصلی',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getStatusResultInlineKeyboard(trackingCode: string): object {
    return {
      inline_keyboard: [
        [
          {
            text: '🔄 بروزرسانی وضعیت',
            callback_data: 'usr:status:' + trackingCode,
          },
        ],
        [
          {
            text: '📂 گزارش‌های من',
            callback_data: 'usr:my',
          },
          {
            text: '➕ گزارش جدید',
            callback_data: 'usr:report',
          },
        ],
        [
          {
            text: '🏠 منوی اصلی',
            callback_data: 'usr:home',
          },
        ],
      ],
    };
  }

  private getMyReportsInlineKeyboard(reports: any[]): object {
    const rows = reports.slice(0, 5).map((report) => [
      {
        text:
          '🔎 ' +
          String(report.trackingCode) +
          ' | ' +
          this.getStatusLabel(report.status),
        callback_data: 'usr:status:' + String(report.trackingCode),
      },
    ]);

    rows.push([
      {
        text: '➕ ثبت گزارش جدید',
        callback_data: 'usr:report',
      },
      {
        text: '🏠 منوی اصلی',
        callback_data: 'usr:home',
      },
    ]);

    return {
      inline_keyboard: rows,
    };
  }

  private toPersianNumber(value: number): string {
    const map: Record<string, string> = {
      '0': '۰',
      '1': '۱',
      '2': '۲',
      '3': '۳',
      '4': '۴',
      '5': '۵',
      '6': '۶',
      '7': '۷',
      '8': '۸',
      '9': '۹',
    };

    return String(value)
      .split('')
      .map((character) => map[character] ?? character)
      .join('');
  }

  async sendMessage(
    chatId: ChatId | string,
    text: string,
    replyMarkup?: object,
  ): Promise<any> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };

    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    // Split long messages at a line boundary; the keyboard belongs to the last part.
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 3900) {
      let end = remaining.lastIndexOf('\n', 3900);
      if (end < 1000) end = 3900;
      if (end > 0 && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end).replace(/^\n/, '');
    }
    chunks.push(remaining);
    let result: any;
    for (let i = 0; i < chunks.length; i++) {
      result = await this.apiPost('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        ...(i === chunks.length - 1 && replyMarkup
          ? { reply_markup: replyMarkup }
          : {}),
      });
    }
    return result;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
