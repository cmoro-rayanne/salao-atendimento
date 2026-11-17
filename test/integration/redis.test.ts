import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisConversationLock } from '../../src/adapters/queue/redis-lock.js';
import { BullConversationQueue, REPLY_QUEUE } from '../../src/adapters/queue/reply-queue.js';

/** Rodam só com TEST_REDIS_URL definida (use um banco Redis descartável). */
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(url!, { maxRetriesPerRequest: null });
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('lock: só um dono por vez, e liberar não apaga o lock de outro', async () => {
    const lock = new RedisConversationLock(redis);
    const release = await lock.acquire(1, 200);
    expect(release).not.toBeNull();
    expect(await lock.acquire(1, 200)).toBeNull();

    await new Promise((r) => setTimeout(r, 250)); // expira
    const second = await lock.acquire(1, 5000);
    expect(second).not.toBeNull();

    await release!(); // dono antigo não pode apagar o lock novo
    expect(await lock.acquire(1, 5000)).toBeNull();
    await second!();
    expect(await lock.acquire(1, 5000)).not.toBeNull();
  });

  it('fila: mensagens seguidas da mesma conversa viram um único job', async () => {
    const replies = new BullConversationQueue(redis);
    for (let i = 0; i < 3; i++) await replies.scheduleReply({ accountId: 1, conversationId: 55 }, 4000);
    await replies.scheduleReply({ accountId: 1, conversationId: 56 }, 4000);

    const inspector = new Queue(REPLY_QUEUE, { connection: redis });
    const delayed = await inspector.getDelayed();
    expect(delayed.map((j) => j.data.conversationId).sort()).toEqual([55, 56]);

    await inspector.close();
    await replies.close();
  });
});
