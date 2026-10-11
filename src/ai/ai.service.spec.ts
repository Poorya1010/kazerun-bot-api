import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

describe('AiService', () => {
  it('reports missing AI configuration explicitly', async () => {
    const service = new AiService(new ConfigService({}));
    await expect(
      service.analyzeCitizenReport({ text: 'چراغ‌های خیابان خاموش است.' }),
    ).rejects.toThrow();
  });
});
