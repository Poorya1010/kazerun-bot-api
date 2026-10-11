export type BotPlatform = 'bale' | 'telegram' | 'rubika';

/** Keep Rubika's opaque IDs as strings; never coerce them to numbers. */
export class BotTransport {
  private baseUrl = '';
  private readonly rubikaChats = new Map<string, any>();
  constructor(
    readonly platform: BotPlatform,
    readonly rubikaInline = false,
  ) {}

  configure(token: string): void {
    const roots = {
      bale: 'https://tapi.bale.ai/bot',
      telegram: 'https://api.telegram.org/bot',
      rubika: 'https://botapi.rubika.ir/v3/',
    };
    this.baseUrl = roots[this.platform] + token.trim();
  }

  async request(method: string, body: Record<string, any> = {}): Promise<any> {
    if (!this.baseUrl) throw new Error('Bot token is not configured');
    const response = await fetch(this.baseUrl + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 35000 : 20000),
    });
    const result: any = await response.json();
    const rubika = this.platform === 'rubika';
    if (
      !response.ok ||
      (rubika ? result.status !== 'OK' : result.ok !== true)
    ) {
      // Do not include request URLs (which contain the bot token) in errors.
      throw new Error(
        `${this.platform} ${method} failed (${result.error_code ?? result.status ?? response.status}): ${result.description ?? result.message ?? 'API error'}`,
      );
    }
    return rubika ? (result.data ?? {}) : result.result;
  }

  keypad(markup: any): any {
    return {
      rows: (markup?.inline_keyboard ?? []).map((row: any[]) => ({
        buttons: row.map((button: any) => ({
          id: button.callback_data,
          type: 'Simple',
          button_text: button.text,
        })),
      })),
      resize_keyboard: true,
    };
  }

  async call(method: string, body: Record<string, any>): Promise<any> {
    if (this.platform !== 'rubika') return this.request(method, body);
    const payload = { ...body };
    for (const key of ['chat_id', 'message_id', 'from_chat_id']) {
      if (payload[key] !== undefined) payload[key] = String(payload[key]);
    }
    if (method === 'answerCallbackQuery' || method === 'sendChatAction')
      return true;
    const markup = payload.reply_markup;
    delete payload.reply_markup;
    if (method === 'sendMessage') {
      if (markup?.remove_keyboard) payload.chat_keypad_type = 'Remove';
      else if (markup) {
        if (this.rubikaInline) payload.inline_keypad = this.keypad(markup);
        else {
          // Inline clicks are delivered through receiveInlineMessage webhooks.
          // Chat keypads work with getUpdates, so polling needs no public URL.
          payload.chat_keypad = this.keypad(markup);
          payload.chat_keypad_type = 'New';
        }
      }
      return this.request(method, payload);
    }
    if (method === 'copyMessage') {
      const result = await this.request('forwardMessage', {
        from_chat_id: payload.from_chat_id,
        message_id: payload.message_id,
        to_chat_id: payload.chat_id,
      });
      return { message_id: result.new_message_id };
    }
    if (method === 'editMessageReplyMarkup') {
      if (!this.rubikaInline)
        throw new Error('Use a new chat keypad in polling mode');
      return this.request('editMessageKeypad', {
        chat_id: payload.chat_id,
        message_id: payload.message_id,
        inline_keypad: this.keypad(markup),
      });
    }
    if (method === 'editMessageText') {
      if (markup && !this.rubikaInline)
        throw new Error('Use a new chat keypad in polling mode');
      const result = await this.request(method, payload);
      if (markup) await this.call('editMessageReplyMarkup', { ...body });
      return result;
    }
    return this.request(method, payload);
  }

  async normalizeRubika(
    raw: any,
    editorialChatId: string | null,
  ): Promise<any | null> {
    const inline = raw.inline_message;
    const update = raw.update ?? raw;
    const message =
      inline ??
      update.new_message ??
      (update.type === 'StartedBot' ? { text: '/start' } : null);
    if (
      !message ||
      (!inline && !['NewMessage', 'StartedBot'].includes(update.type))
    )
      return null;
    if (message.sender_type && message.sender_type !== 'User') return null;
    const chatId = String(inline?.chat_id ?? update.chat_id ?? '');
    if (!chatId) return null;
    let chat = this.rubikaChats.get(chatId);
    if (!chat) {
      const result = await this.request('getChat', { chat_id: chatId });
      chat = result.chat;
      if (!chat?.chat_type)
        throw new Error('Rubika getChat returned no chat type');
      if (this.rubikaChats.size > 10000) this.rubikaChats.clear();
      this.rubikaChats.set(chatId, chat);
    }
    const userId = String(message.sender_id ?? chat.user_id ?? '');
    if (!chatId || !userId) return null;
    const normalized: any = {
      message_id: String(message.message_id ?? ''),
      chat: {
        id: chatId,
        type:
          chatId === editorialChatId
            ? 'group'
            : chat.chat_type === 'User'
              ? 'private'
              : 'group',
      },
      from: {
        id: userId,
        first_name: chat.first_name,
        last_name: chat.last_name,
        username: chat.username,
      },
      text: message.text,
    };
    if (message.file?.file_id) {
      // The official File model does not guarantee a media-type field.
      // Preserve every file, even when its type cannot be determined.
      normalized.document = {
        file_id: String(message.file.file_id),
        file_name: message.file.file_name,
        file_size: Number(message.file.size ?? 0),
      };
      normalized.caption = message.text;
    }
    const buttonId = message.aux_data?.button_id;
    if (buttonId)
      return {
        callback_query: {
          id: String(message.message_id ?? ''),
          from: normalized.from,
          message: normalized,
          data: String(buttonId),
        },
      };
    if (message.aux_data?.start_id && !normalized.text)
      normalized.text = '/start';
    return { message: normalized };
  }
}
