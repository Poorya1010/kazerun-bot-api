import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotState } from './bot-state';

describe('Persistent workflow state', () => {
  it('restores offsets and an unfinished report, isolated by platform', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bot-state-'));
    try {
      const state = {
        offset: 17,
        sessions: [
          [
            'chat-guid',
            { mode: 'awaiting_media', trackingCode: 'KZ-test', mediaCount: 2 },
          ],
        ],
      };
      new BotState(directory, 'rubika').write(state);
      expect(new BotState(directory, 'rubika').read()).toEqual(state);
      expect(new BotState(directory, 'telegram').read()).toEqual({});
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
