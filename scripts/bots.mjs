import 'dotenv/config';

const setup = process.argv.includes('--setup');
const commands = [
  { command: 'start', description: 'منوی اصلی' },
  { command: 'report', description: 'ثبت گزارش مردمی' },
  { command: 'demands', description: 'مطالبات مردمی' },
  { command: 'myreports', description: 'گزارش‌های من' },
  { command: 'track', description: 'پیگیری با کد' },
  { command: 'help', description: 'راهنمای استفاده' },
  { command: 'cancel', description: 'خروج از مرحله جاری' },
];
let failed = false;
for (const platform of ['bale', 'telegram', 'rubika']) {
  const token = process.env[platform.toUpperCase() + '_BOT_TOKEN']?.trim();
  if (!token) {
    console.log(platform + ': token not configured');
    continue;
  }
  const root = {
    bale: 'https://tapi.bale.ai/bot',
    telegram: 'https://api.telegram.org/bot',
    rubika: 'https://botapi.rubika.ir/v3/',
  }[platform];
  const call = async (method, body = {}) => {
    let response;
    try {
      response = await fetch(root + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error(
        'network or timeout error; verify server access to ' +
          new URL(root).hostname,
      );
    }
    const result = await response.json();
    if (
      !response.ok ||
      (platform === 'rubika' ? result.status !== 'OK' : result.ok !== true)
    ) {
      throw new Error(
        `${method}: ${result.error_code ?? result.status ?? response.status}`,
      );
    }
    return platform === 'rubika' ? result.data : result.result;
  };
  try {
    await call('getMe');
    console.log(platform + ': token and API connection OK');
    if (platform === 'telegram') {
      const webhook = await call('getWebhookInfo');
      console.log(
        'telegram: existing webhook ' +
          (webhook.url ? 'YES (conflicts with polling)' : 'NO'),
      );
      if (setup) await call('deleteWebhook', { drop_pending_updates: false });
    }
    if (!setup) continue;
    if (platform === 'rubika') {
      const origin = process.env.RUBIKA_WEBHOOK_URL?.trim().replace(/\/+$/, '');
      if (origin) {
        const secret = process.env.RUBIKA_WEBHOOK_SECRET ?? '';
        if (!/^https:\/\//.test(origin) || !/^[A-Za-z0-9_-]{32,}$/.test(secret))
          throw new Error(
            'Configure HTTPS origin and a random URL-safe secret of at least 32 characters',
          );
        for (const [type, endpoint] of [
          ['ReceiveUpdate', 'update'],
          ['ReceiveInlineMessage', 'inline'],
        ]) {
          await call('updateBotEndpoints', {
            type,
            url: origin + '/bots/rubika/' + secret + '/' + endpoint,
          });
        }
        console.log(
          'rubika: receiveUpdate and receiveInlineMessage endpoints configured',
        );
      } else
        console.log(
          'rubika: polling mode; remove any old webhooks in your existing deployment before switching modes',
        );
      await call('setCommands', { bot_commands: commands });
    } else await call('setMyCommands', { commands });
    console.log(platform + ': setup OK');
  } catch (error) {
    failed = true;
    // Never print token-bearing URLs or raw fetch errors.
    console.error(platform + ': ' + error.message);
  }
}
process.exitCode = failed ? 1 : 0;
