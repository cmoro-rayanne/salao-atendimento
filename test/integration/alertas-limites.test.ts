import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookAlertNotifier } from '../../src/adapters/alerts/webhook-alert.js';
import { RedisConversationRateLimiter } from '../../src/adapters/queue/redis-rate-limiter.js';

const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!redisUrl)('limite por conversa e alertas no Redis', () => {
  let redis: Redis;
  const log = { warn: vi.fn(), error: vi.fn() };

  beforeAll(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await redis?.quit();
  });

  it('libera até o limite por minuto e marca só a primeira mensagem acima', async () => {
    const limiter = new RedisConversationRateLimiter(redis, { perMinute: 3, perDay: 100 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.hit(77));
    expect(results).toEqual([
      { allowed: true, firstExceeded: false },
      { allowed: true, firstExceeded: false },
      { allowed: true, firstExceeded: false },
      { allowed: false, firstExceeded: true },
      { allowed: false, firstExceeded: false },
    ]);
    expect((await limiter.hit(78)).allowed).toBe(true); // outra conversa, outro contador
  });

  it('limite diário também bloqueia', async () => {
    const limiter = new RedisConversationRateLimiter(redis, { perMinute: 100, perDay: 2 });
    await limiter.hit(1);
    await limiter.hit(1);
    expect(await limiter.hit(1)).toEqual({ allowed: false, firstExceeded: true });
  });

  it('alerta em texto puro, sem repetir a mesma chave na janela', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const alerts = new WebhookAlertNotifier('https://ntfy.sh/topico', 'text', redis, log);

    await alerts.notify({ key: 'x', text: 'deu ruim' });
    await alerts.notify({ key: 'x', text: 'deu ruim de novo' });
    await alerts.notify({ key: 'y', text: 'outro' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('[Atendimento IA] deu ruim');
  });

  it('formato JSON para Slack/Discord', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await new WebhookAlertNotifier('https://hooks.example/x', 'json', redis, log).notify({ key: 'j', text: 'oi' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: '[Atendimento IA] oi' });
  });

  it('falha no webhook vira log, não exceção', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rede fora'); }));
    await expect(new WebhookAlertNotifier('https://x.example', 'text', redis, log).notify({ key: 'z', text: 'a' })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});
