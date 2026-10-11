import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard, secretMatches } from './api-key.guard';

describe('Internal API access', () => {
  const context = (header?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-api-key': header } }),
      }),
    }) as any;
  it('denies private HTTP endpoints when no key is configured', () => {
    expect(() =>
      new ApiKeyGuard(new ConfigService({})).canActivate(context()),
    ).toThrow();
  });
  it('requires the configured secret', () => {
    const guard = new ApiKeyGuard(
      new ConfigService({ INTERNAL_API_KEY: 'test-key' }),
    );
    expect(() => guard.canActivate(context('bad-key'))).toThrow();
    expect(guard.canActivate(context('test-key'))).toBe(true);
  });
  it('handles different lengths and empty values without throwing crypto errors', () => {
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('test', 'short')).toBe(false);
    expect(secretMatches('test', 'test')).toBe(true);
  });
});
