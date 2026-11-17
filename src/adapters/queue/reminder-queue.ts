import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ReminderScheduler } from '../../modules/trial-classes/ports.js';

export const REMINDER_QUEUE = 'trial-reminder';

export interface ReminderJob {
  bookingId: number;
}

/** Lembretes da aula experimental como jobs atrasados no BullMQ. */
export class BullReminderScheduler implements ReminderScheduler {
  private readonly queue: Queue<ReminderJob>;

  constructor(
    connection: Redis,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new Queue<ReminderJob>(REMINDER_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  }

  async schedule(bookingId: number, at: Date): Promise<string> {
    // O id inclui o horário: remarcar a mesma reserva gera outro job, sem colidir com o antigo.
    const jobId = `reminder-${bookingId}-${at.getTime()}`;
    const delay = Math.max(0, at.getTime() - this.now().getTime());
    await this.queue.add('reminder', { bookingId }, { jobId, delay });
    return jobId;
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    await job?.remove();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
