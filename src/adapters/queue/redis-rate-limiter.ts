import type { Redis } from 'ioredis';
import type { ConversationRateLimiter } from '../../modules/conversation/ports.js';

export interface RateLimits {
  perMinute: number;
  perDay: number;
}

/** Duas janelas fixas por conversa (minuto e dia), contadas no Redis. */
export class RedisConversationRateLimiter implements ConversationRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limits: RateLimits = { perMinute: 20, perDay: 150 },
  ) {}

  async hit(conversationId: number): Promise<{ allowed: boolean; firstExceeded: boolean }> {
    const minuteKey = `rl:conv:${conversationId}:m`;
    const dayKey = `rl:conv:${conversationId}:d`;
    const res = (await this.redis
      .multi()
      .incr(minuteKey)
      .expire(minuteKey, 60, 'NX')
      .incr(dayKey)
      .expire(dayKey, 24 * 60 * 60, 'NX')
      .exec()) as Array<[Error | null, number]>;
    const minute = res[0]![1];
    const day = res[2]![1];
    const allowed = minute <= this.limits.perMinute && day <= this.limits.perDay;
    const firstExceeded = minute === this.limits.perMinute + 1 || day === this.limits.perDay + 1;
    return { allowed, firstExceeded: !allowed && firstExceeded };
  }
}
