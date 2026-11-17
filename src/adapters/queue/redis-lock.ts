import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ConversationLock } from '../../modules/conversation/ports.js';

/** Só apaga a chave se ela ainda for nossa (o TTL pode ter expirado e outro worker pego o lock). */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

export class RedisConversationLock implements ConversationLock {
  constructor(private readonly redis: Redis) {}

  async acquire(conversationId: number, ttlMs: number): Promise<(() => Promise<void>) | null> {
    const key = `lock:conversation:${conversationId}`;
    const token = randomUUID();
    const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    };
  }
}
