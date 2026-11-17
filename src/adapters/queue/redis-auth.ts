import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { LoginRateLimiter } from '../../modules/auth/ports.js';

/** Janela fixa: no máximo `max` tentativas a cada `windowSec`. */
export class RedisLoginRateLimiter implements LoginRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly max = 5,
    private readonly windowSec = 15 * 60,
  ) {}

  private key(id: string): string {
    return `admin:login:${createHash('sha256').update(id).digest('hex')}`;
  }

  async hit(id: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
    const key = this.key(id);
    const [[, count], [, ttl]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, this.windowSec, 'NX')
      .ttl(key)
      .exec()) as [[null, number], [null, number], [null, number]];
    return { allowed: count <= this.max, retryAfterSec: Math.max(ttl, 1) };
  }

  async reset(id: string): Promise<void> {
    await this.redis.del(this.key(id));
  }
}
