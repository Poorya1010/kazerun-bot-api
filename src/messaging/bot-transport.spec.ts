import { BotTransport } from './bot-transport';

const markup = {
  inline_keyboard: [[{ text: 'ثبت گزارش', callback_data: 'usr:report' }]],
};
function reply(result: any, ok = true) {
  return { ok, status: 200, json: async () => result } as Response;
}

describe('Bot transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['bale', 'telegram'] as const)(
    'uses the %s API and validates its response',
    async (platform) => {
      const spy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(reply({ ok: true, result: { message_id: 2 } }));
      const transport = new BotTransport(platform);
      transport.configure('test-token');
      expect(
        await transport.call('sendMessage', {
          chat_id: 7,
          text: 'سلام',
          reply_markup: markup,
        }),
      ).toEqual({ message_id: 2 });
      expect(String(spy.mock.calls[0][0])).toContain(
        platform === 'telegram'
          ? 'api.telegram.org/bottest-token'
          : 'tapi.bale.ai/bottest-token',
      );
      spy.mockResolvedValue(reply({ ok: false, error_code: 401 }));
      await expect(transport.call('sendMessage', {})).rejects.toThrow('401');
    },
  );
  it('Rubika polling keypads do not depend on inline webhooks', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        reply({ status: 'OK', data: { message_id: 'opaque-message' } }),
      );
    const transport = new BotTransport('rubika');
    transport.configure('test-token');
    await transport.call('sendMessage', {
      chat_id: 'chat-guid',
      text: 'سلام',
      reply_markup: markup,
    });
    const payload = JSON.parse(String(spy.mock.calls[0][1]?.body));
    expect(payload.chat_id).toBe('chat-guid');
    expect(payload.chat_keypad.rows[0].buttons[0]).toEqual({
      id: 'usr:report',
      type: 'Simple',
      button_text: 'ثبت گزارش',
    });
    expect(payload.inline_keypad).toBeUndefined();
  });
  it('Rubika webhook mode sends inline keypads and edits text and buttons separately', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(reply({ status: 'OK', data: {} }));
    const transport = new BotTransport('rubika', true);
    transport.configure('test-token');
    await transport.call('editMessageText', {
      chat_id: 'c',
      message_id: 'm',
      text: 'جدید',
      reply_markup: markup,
    });
    expect(String(spy.mock.calls[1][0])).toContain('/editMessageKeypad');
    expect(
      JSON.parse(String(spy.mock.calls[1][1]?.body)).inline_keypad.rows,
    ).toHaveLength(1);
  });
  it('forwards Rubika evidence using its official target field', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        reply({ status: 'OK', data: { new_message_id: 'm2' } }),
      );
    const transport = new BotTransport('rubika');
    transport.configure('test-token');
    expect(
      await transport.call('copyMessage', {
        chat_id: 'editor',
        from_chat_id: 'citizen',
        message_id: 'm1',
      }),
    ).toEqual({ message_id: 'm2' });
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toEqual({
      from_chat_id: 'citizen',
      message_id: 'm1',
      to_chat_id: 'editor',
    });
  });
  it('normalizes messages and both kinds of Rubika button events without numeric conversion', async () => {
    const transport = new BotTransport('rubika');
    jest
      .spyOn(transport, 'request')
      .mockResolvedValue({ chat: { chat_type: 'User', user_id: 'user-guid' } });
    const update = {
      type: 'NewMessage',
      chat_id: 'chat-guid',
      new_message: {
        message_id: 'm-guid',
        sender_id: 'user-guid',
        sender_type: 'User',
        text: 'گزارش',
        file: { file_id: 'file-guid' },
      },
    };
    const message = await transport.normalizeRubika(update, null);
    expect(message.message.chat.id).toBe('chat-guid');
    expect(message.message.from.id).toBe('user-guid');
    expect(message.message.document.file_id).toBe('file-guid');
    const callback = await transport.normalizeRubika(
      {
        ...update,
        new_message: {
          ...update.new_message,
          aux_data: { button_id: 'usr:report' },
        },
      },
      null,
    );
    expect(callback.callback_query.data).toBe('usr:report');
    const inline = await transport.normalizeRubika(
      {
        inline_message: {
          chat_id: 'chat-guid',
          message_id: 'm-guid',
          sender_id: 'user-guid',
          aux_data: { button_id: 'usr:demands' },
        },
      },
      null,
    );
    expect(inline.callback_query.data).toBe('usr:demands');
    expect(
      await transport.normalizeRubika(
        { type: 'UpdatedMessage', chat_id: 'c', updated_message: {} },
        null,
      ),
    ).toBeNull();
  });
  it('ignores self messages and does not label unrelated groups private', async () => {
    const transport = new BotTransport('rubika');
    jest
      .spyOn(transport, 'request')
      .mockResolvedValue({ chat: { chat_type: 'Group' } });
    const update = {
      type: 'NewMessage',
      chat_id: 'group-guid',
      new_message: {
        message_id: 'm',
        sender_id: 'u',
        sender_type: 'User',
        text: 'سلام',
      },
    };
    expect(
      (await transport.normalizeRubika(update, null)).message.chat.type,
    ).toBe('group');
    expect(
      await transport.normalizeRubika(
        {
          ...update,
          new_message: { ...update.new_message, sender_type: 'Bot' },
        },
        null,
      ),
    ).toBeNull();
  });
  it('StartedBot events produce a welcome interaction', async () => {
    const transport = new BotTransport('rubika');
    jest
      .spyOn(transport, 'request')
      .mockResolvedValue({ chat: { chat_type: 'User', user_id: 'u' } });
    expect(
      (
        await transport.normalizeRubika(
          { type: 'StartedBot', chat_id: 'c' },
          null,
        )
      ).message.text,
    ).toBe('/start');
  });
  it('rejects failed Rubika responses instead of silently losing messages', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(reply({ status: 'INVALID_TOKEN' }));
    const transport = new BotTransport('rubika');
    transport.configure('secret');
    await expect(transport.request('getUpdates')).rejects.toThrow(
      'INVALID_TOKEN',
    );
  });
});
