import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('Application HTTP and messenger wiring', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        report: { findMany: jest.fn().mockResolvedValue([]) },
        $disconnect: jest.fn(),
      })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          INTERNAL_API_KEY: 'internal-test',
          RUBIKA_WEBHOOK_SECRET: 'x'.repeat(32),
          RUBIKA_WEBHOOK_URL: 'https://example.com',
        }),
      )
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('boots all three messenger providers without tokens', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
    expect(app.get('TELEGRAM_BOT').platform).toBe('telegram');
    expect(app.get('RUBIKA_BOT').platform).toBe('rubika');
  });
  it.each([
    '/reports',
    '/users',
    '/reports/track/KZ-test?platform=telegram&platformUserId=7',
  ])('rejects unauthenticated access to %s', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);
  });
  it('allows an authenticated internal report listing', async () => {
    await request(app.getHttpServer())
      .get('/reports')
      .set('x-api-key', 'internal-test')
      .expect(200)
      .expect([]);
  });
  it('rejects forged Rubika webhook requests', async () => {
    await request(app.getHttpServer())
      .post('/bots/rubika/wrong/update')
      .send({ update: {} })
      .expect(401);
  });
});
