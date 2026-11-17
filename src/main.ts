import { Redis } from 'ioredis';
import { resolve } from 'node:path';
import { ScryptPasswordHasher } from './adapters/crypto/scrypt-hasher.js';
import {
  PgBookingAdminRepository,
  PgLeadAdminRepository,
  PgReportRepository,
  PgUnansweredQuestionRepository,
} from './adapters/db/panel-repositories.js';
import { PgTenantRepository } from './adapters/db/repositories.js';
import {
  PgTenantSettingsRepository,
  PgAdminUserRepository,
  PgKnowledgeAdminRepository,
  PgTrialSlotRepository,
} from './adapters/db/admin-repositories.js';
import { PgCatalogRepository } from './adapters/db/agenda-repositories.js';
import { createSql } from './adapters/db/client.js';
import { AnthropicLlmClient } from './adapters/llm/anthropic-client.js';
import { PgProcessedEventStore } from './adapters/db/processed-event-store.js';
import { createAlerts } from './adapters/alerts/create-alerts.js';
import { RedisLoginRateLimiter } from './adapters/queue/redis-auth.js';
import { JwtSessionStore } from './adapters/auth/jwt-session.js';
import { RedisConversationRateLimiter } from './adapters/queue/redis-rate-limiter.js';
import pino from 'pino';
import { BullConversationQueue } from './adapters/queue/reply-queue.js';
import { loadEnv } from './config/env.js';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_MAX_AGE_MS } from './http/health.js';
import { buildServer } from './http/server.js';

const env = loadEnv();
const sql = createSql(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new BullConversationQueue(redis);
const tenants = new PgTenantRepository(sql);
const sessionTtlSec = env.ADMIN_SESSION_TTL_HOURS * 60 * 60;
const jwtSecret = new TextEncoder().encode(env.JWT_SECRET);

const alerts = createAlerts(env, redis, pino({ level: env.LOG_LEVEL }));

const app = buildServer({
  events: new PgProcessedEventStore(sql),
  rateLimiter: new RedisConversationRateLimiter(redis, {
    perMinute: env.RATE_LIMIT_PER_MINUTE,
    perDay: env.RATE_LIMIT_PER_DAY,
  }),
  alerts,
  healthChecks: {
    database: async () => (await sql`select 1 as ok`).length === 1,
    redis: async () => (await redis.ping()) === 'PONG',
    worker: async () => Date.now() - Number((await redis.get(WORKER_HEARTBEAT_KEY)) ?? 0) < WORKER_HEARTBEAT_MAX_AGE_MS,
  },
  queue,
  debounceMs: env.MESSAGE_DEBOUNCE_MS,
  webhookSecret: env.WEBHOOK_SECRET,
  logLevel: env.LOG_LEVEL,
  webRoot: resolve(env.WEB_ROOT),
  trustProxy: env.TRUST_PROXY,
  admin: {
    users: new PgAdminUserRepository(sql),
    hasher: new ScryptPasswordHasher(),
    sessions: new JwtSessionStore(redis, jwtSecret, sessionTtlSec),
    limiter: new RedisLoginRateLimiter(redis),
    knowledge: new PgKnowledgeAdminRepository(sql),
    slots: new PgTrialSlotRepository(sql),
    catalog: new PgCatalogRepository(sql),
    leads: new PgLeadAdminRepository(sql),
    settings: new PgTenantSettingsRepository(sql),
    unanswered: new PgUnansweredQuestionRepository(sql),
    llm: env.LLM_API_KEY ? new AnthropicLlmClient(env.LLM_API_KEY, env.LLM_MODEL, env.LLM_BASE_URL) : null,
    agentMaxSteps: env.AGENT_MAX_STEPS,
    testLimiter: new RedisLoginRateLimiter(redis, 30, 60 * 60),
    bookings: new PgBookingAdminRepository(sql),
    reports: new PgReportRepository(sql),
    tenantInfo: (id) => tenants.infoOf(id),
    chatwootPublicUrl: env.CHATWOOT_PUBLIC_URL ?? null,
    usdBrl: env.USD_BRL ?? null,
    secureCookies: env.NODE_ENV === 'staging' || env.NODE_ENV === 'production',
    sessionTtlSec,
  },
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await queue.close();
  await redis.quit();
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: env.PORT });
