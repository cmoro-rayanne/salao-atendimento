import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { DelayNoticeScheduler } from '../../modules/appointments/ports.js';

export const DELAY_NOTICE_QUEUE = 'appointment-delay-notice';

export interface DelayNoticeJob {
  noticeId: number;
}

/** Avisos de atraso: envio imediato, mas pelo worker, com tentativas e DLQ (webhook/painel respondem rápido). */
export class BullDelayNoticeScheduler implements DelayNoticeScheduler {
  private readonly queue: Queue<DelayNoticeJob>;

  constructor(connection: Redis) {
    this.queue = new Queue<DelayNoticeJob>(DELAY_NOTICE_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  }

  async enqueue(noticeId: number): Promise<void> {
    await this.queue.add('delay-notice', { noticeId }, { jobId: `delay-notice-${noticeId}` });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
