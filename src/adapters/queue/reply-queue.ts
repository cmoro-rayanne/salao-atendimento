import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ConversationQueue, ReplyJob } from '../../modules/conversation/ports.js';

export const REPLY_QUEUE = 'conversation-reply';

/**
 * Fila de respostas. A deduplicação por conversa faz várias mensagens
 * seguidas virarem um único job (o agente lê o histórico inteiro ao rodar).
 */
export class BullConversationQueue implements ConversationQueue {
  private readonly queue: Queue<ReplyJob>;

  constructor(connection: Redis) {
    this.queue = new Queue<ReplyJob>(REPLY_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        // Jobs que esgotam as tentativas ficam na lista de falhas: é a nossa DLQ.
        removeOnFail: false,
      },
    });
  }

  async scheduleReply(job: ReplyJob, delayMs: number): Promise<void> {
    await this.queue.add('reply', job, {
      delay: delayMs,
      deduplication: { id: `conversation:${job.conversationId}`, ttl: delayMs },
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
