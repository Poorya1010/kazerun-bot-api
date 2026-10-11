import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotPlatform } from './bot-transport';

/** Single process per platform. Mount this directory on a persistent volume. */
export class BotState {
  private readonly path: string;
  constructor(directory: string, platform: BotPlatform) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, platform + '.json');
  }
  read(): any {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error: any) {
      if (error.code === 'ENOENT') return {};
      throw new Error(
        'Bot state cannot be read; restore or repair the state file',
      );
    }
  }
  write(state: any): void {
    const temporary = this.path + '.tmp';
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
