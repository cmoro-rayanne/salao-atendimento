import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { ChatwootClient } from './adapters/chatwoot/chatwoot-client.js';
import { ChatwootGateway, DEFAULT_REMINDER_BODY } from './adapters/chatwoot/chatwoot-gateway.js';
import { PgAppointmentRepository, PgCatalogRepository } from './adapters/db/agenda-repositories.js';
import { PgBookingRepository } from './adapters/db/booking-repository.js';
import { createSql } from './adapters/db/client.js';
import {
  PgAgentRunRepository,
  PgHandoffRepository,
  PgKnowledgeRepository,
  PgLeadRepository,
  PgTenantRepository,
} from './adapters/db/repositories.js';
import { AnthropicLlmClient, LlmError } from './adapters/llm/anthropic-client.js';
import { RedisConversationLock } from './adapters/queue/redis-lock.js';
import { BullReminderScheduler, REMINDER_QUEUE, type ReminderJob } from './adapters/queue/reminder-queue.js';
import { BullConversationQueue, REPLY_QUEUE } from './adapters/queue/reply-queue.js';
import { createAlerts } from './adapters/alerts/create-alerts.js';
import { loadEnv, requireLlmKey } from './config/env.js';
import { WORKER_HEARTBEAT_KEY } from './http/health.js';
import type { ReplyJob } from './modules/conversation/ports.js';
import {
  ConversationBusyError,
  handleExhaustedReply,
  replyToConversation,
  type ReplyDeps,
} from './modules/conversation/reply-to-conversation.js';
import { sendTrialReminder } from './modules/trial-classes/send-reminder.js';

const BUSY_RETRY_MS = 5_000;

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const alerts = createAlerts(env, redis, log);
const sql = createSql(env.DATABASE_URL);
const queue = new BullConversationQueue(redis);
const chatwoot = new ChatwootGateway(new ChatwootClient(env.CHATWOOT_BASE_URL, env.CHATWOOT_BOT_TOKEN), {
  name: env.REMINDER_TEMPLATE_NAME,
  language: env.REMINDER_TEMPLATE_LANG,
  body: DEFAULT_REMINDER_BODY,
});
const bookings = new PgBookingRepository(sql);
const reminders = new BullReminderScheduler(redis);
/** Lembrete do salão entra na entrega 4 (spec 0013): até lá a fila só atende o código antigo da experimental. */
const noReminders = { schedule: async () => 'sem-lembrete', cancel: async () => {} };
const now = () => new Date();

const deps: ReplyDeps = {
  llm: new AnthropicLlmClient(requireLlmKey(env), env.LLM_MODEL, env.LLM_BASE_URL),
  model: env.LLM_MODEL,
  pricing:
    env.LLM_PRICE_INPUT_USD_PER_MTOK && env.LLM_PRICE_OUTPUT_USD_PER_MTOK
      ? { inputUsdPerMTok: env.LLM_PRICE_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.LLM_PRICE_OUTPUT_USD_PER_MTOK }
      : undefined,
  maxSteps: env.AGENT_MAX_STEPS,
  tenants: new PgTenantRepository(sql),
  knowledge: new PgKnowledgeRepository(sql),
  conversations: chatwoot,
  runs: new PgAgentRunRepository(sql),
  lock: new RedisConversationLock(redis),
  leads: new PgLeadRepository(sql),
  handoff: { inbox: chatwoot, handoffs: new PgHandoffRepository(sql) },
  agenda: { catalog: new PgCatalogRepository(sql), appointments: new PgAppointmentRepository(sql), reminders: noReminders, now },
};

const worker = new Worker<ReplyJob>(
  REPLY_QUEUE,
  async (job) => {
    const logger = log.child({ correlationId: `conversation:${job.data.conversationId}`, jobId: job.id });
    try {
      const outcome = await replyToConversation(deps, job.data);
      logger.info({ outcome }, 'conversa processada');
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        // Outra resposta da conversa em andamento: reagenda sem gastar tentativa.
        await queue.scheduleReply(job.data, BUSY_RETRY_MS);
        logger.info('conversa ocupada, reagendada');
        return;
      }
      if (err instanceof LlmError && !err.retryable) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  },
  { connection: redis, concurrency: 5 },
);

worker.on('failed', (job: Job<ReplyJob> | undefined, err: Error) => {
  if (!job) return;
  const exhausted = err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
  log.error({ jobId: job.id, err, dlq: exhausted }, exhausted ? 'job foi para a DLQ' : 'job falhou, vai tentar de novo');
  if (!exhausted) return;

  void alerts.notify({
    key: `reply-dlq:${job.data.conversationId}`,
    text: `A IA não conseguiu responder a conversa ${job.data.conversationId} (${err.message}). Ela foi transferida para a equipe.`,
  });
  handleExhaustedReply(deps, job.data, err.message).catch((handoffErr: unknown) => {
    log.fatal({ jobId: job.id, err: handoffErr }, 'falha ao transferir conversa após erro');
    void alerts.notify({
      key: `handoff-failed:${job.data.conversationId}`,
      text: `URGENTE: a conversa ${job.data.conversationId} ficou sem resposta e não foi transferida. Abra no Chatwoot.`,
    });
  });
});

const reminderWorker = new Worker<ReminderJob>(
  REMINDER_QUEUE,
  async (job) => {
    const outcome = await sendTrialReminder({ bookings, sender: chatwoot, now }, job.data.bookingId);
    log.info({ jobId: job.id, bookingId: job.data.bookingId, outcome }, 'lembrete da experimental');
  },
  { connection: redis, concurrency: 2 },
);

reminderWorker.on('failed', (job, err) => {
  const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  log.error({ jobId: job?.id, err, dlq: exhausted }, exhausted ? 'lembrete foi para a DLQ' : 'lembrete falhou, vai tentar de novo');
  if (exhausted && job) {
    void alerts.notify({
      key: `reminder-dlq:${job.data.bookingId}`,
      text: `O lembrete da aula experimental (reserva ${job.data.bookingId}) não foi enviado: ${err.message}. Confira o template na Meta.`,
    });
  }
});

// Batimento para o /health/ready da API saber que o worker está vivo.
const heartbeat = setInterval(() => {
  redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300).catch((err: unknown) => log.warn({ err }, 'heartbeat falhou'));
}, 30_000);
void redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 300);

async function shutdown(): Promise<void> {
  clearInterval(heartbeat);
  await worker.close();
  await reminderWorker.close();
  await reminders.close();
  await queue.close();
  await redis.quit();
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
log.info({ model: env.LLM_MODEL }, 'worker iniciado');
