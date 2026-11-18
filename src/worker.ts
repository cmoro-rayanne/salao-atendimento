import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { ChatwootClient } from './adapters/chatwoot/chatwoot-client.js';
import { ChatwootGateway, DEFAULT_APPOINTMENT_REMINDER_BODY, DEFAULT_DELAY_NOTICE_BODY } from './adapters/chatwoot/chatwoot-gateway.js';
import { PgAppointmentRepository, PgCatalogRepository } from './adapters/db/agenda-repositories.js';
import { createSql } from './adapters/db/client.js';
import { PgClientDelayRepository, PgDelayNoticeRepository } from './adapters/db/delay-notice-repository.js';
import {
  PgAgentRunRepository,
  PgHandoffRepository,
  PgKnowledgeRepository,
  PgLeadRepository,
  PgTenantRepository,
} from './adapters/db/repositories.js';
import { AnthropicLlmClient, LlmError } from './adapters/llm/anthropic-client.js';
import { RedisConversationLock } from './adapters/queue/redis-lock.js';
import {
  APPOINTMENT_REMINDER_QUEUE,
  BullAppointmentReminderScheduler,
  type AppointmentReminderJob,
} from './adapters/queue/appointment-reminder-queue.js';
import { DELAY_NOTICE_QUEUE, type DelayNoticeJob } from './adapters/queue/delay-notice-queue.js';
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
import { sendAppointmentReminder } from './modules/appointments/send-reminder.js';
import { sendDelayNotice } from './modules/appointments/delay-notice.js';

const BUSY_RETRY_MS = 5_000;

const env = loadEnv();
const log = pino({ level: env.LOG_LEVEL });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const alerts = createAlerts(env, redis, log);
const sql = createSql(env.DATABASE_URL);
const queue = new BullConversationQueue(redis);
const chatwoot = new ChatwootGateway(new ChatwootClient(env.CHATWOOT_BASE_URL, env.CHATWOOT_BOT_TOKEN), {
  name: env.APPOINTMENT_REMINDER_TEMPLATE_NAME,
  language: env.REMINDER_TEMPLATE_LANG,
  body: DEFAULT_APPOINTMENT_REMINDER_BODY,
}, {
  name: env.APPOINTMENT_DELAY_TEMPLATE_NAME,
  language: env.REMINDER_TEMPLATE_LANG,
  body: DEFAULT_DELAY_NOTICE_BODY,
});
const delayNotices = new PgDelayNoticeRepository(sql);
const appointmentRepo = new PgAppointmentRepository(sql);
const appointmentReminders = new BullAppointmentReminderScheduler(redis);
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
  agenda: { catalog: new PgCatalogRepository(sql), appointments: appointmentRepo, reminders: appointmentReminders, delayNotices, clientDelays: new PgClientDelayRepository(sql), inbox: chatwoot, now },
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

const appointmentReminderWorker = new Worker<AppointmentReminderJob>(
  APPOINTMENT_REMINDER_QUEUE,
  async (job) => {
    const outcome = await sendAppointmentReminder({ appointments: appointmentRepo, sender: chatwoot, now }, job.data.appointmentId);
    log.info({ jobId: job.id, appointmentId: job.data.appointmentId, outcome }, 'lembrete de agendamento');
  },
  { connection: redis, concurrency: 2 },
);

appointmentReminderWorker.on('failed', (job, err) => {
  const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  log.error({ jobId: job?.id, err, dlq: exhausted }, exhausted ? 'lembrete de agendamento foi para a DLQ' : 'lembrete de agendamento falhou, vai tentar de novo');
  if (exhausted && job) {
    void alerts.notify({
      key: `appointment-reminder-dlq:${job.data.appointmentId}`,
      text: `O lembrete do agendamento ${job.data.appointmentId} não foi enviado: ${err.message}. Confira o template na Meta.`,
    });
  }
});

const delayNoticeWorker = new Worker<DelayNoticeJob>(
  DELAY_NOTICE_QUEUE,
  async (job) => {
    const outcome = await sendDelayNotice({ notices: delayNotices, sender: chatwoot }, job.data.noticeId);
    log.info({ jobId: job.id, noticeId: job.data.noticeId, outcome }, 'aviso de atraso');
  },
  { connection: redis, concurrency: 2 },
);

delayNoticeWorker.on('failed', (job, err) => {
  const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
  log.error({ jobId: job?.id, err, dlq: exhausted }, exhausted ? 'aviso de atraso foi para a DLQ' : 'aviso de atraso falhou, vai tentar de novo');
  if (exhausted && job) {
    void alerts.notify({
      key: `delay-notice-dlq:${job.data.noticeId}`,
      text: `O aviso de atraso ${job.data.noticeId} não foi enviado: ${err.message}. Confira o template aviso_atraso na Meta e avise a cliente por telefone.`,
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
  await appointmentReminderWorker.close();
  await delayNoticeWorker.close();
  await appointmentReminders.close();
  await queue.close();
  await redis.quit();
  await sql.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
log.info({ model: env.LLM_MODEL }, 'worker iniciado');
