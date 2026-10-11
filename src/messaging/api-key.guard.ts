import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export function secretMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** Development HTTP endpoints expose private reports and costly AI operations. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_API_KEY') ?? '';
    const header = context.switchToHttp().getRequest().headers['x-api-key'];
    if (!secretMatches(expected, typeof header === 'string' ? header : '')) {
      throw new UnauthorizedException('A valid internal API key is required');
    }
    return true;
  }
}
