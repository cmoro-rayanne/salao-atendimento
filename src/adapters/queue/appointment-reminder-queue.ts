import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ReminderScheduler } from '../../modules/appointments/ports.js';

export const APPOINTMENT_REMINDER_QUEUE = 'appointment-reminder';

export interface AppointmentReminderJob {
  appointmentId: number;
}

/** Lembretes de agendamento como jobs atrasados no BullMQ (fila própria, separada da experimental). */
export class BullAppointmentReminderScheduler implements ReminderScheduler {
  private readonly queue: Queue<AppointmentReminderJob>;

  constructor(
    connection: Redis,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.queue = new Queue<AppointmentReminderJob>(APPOINTMENT_REMINDER_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  }

  async schedule(appointmentId: number, at: Date): Promise<string> {
    // O id inclui o horário: remarcar o mesmo agendamento gera outro job, sem colidir com o antigo.
    const jobId = `appointment-reminder-${appointmentId}-${at.getTime()}`;
    const delay = Math.max(0, at.getTime() - this.now().getTime());
    await this.queue.add('reminder', { appointmentId }, { jobId, delay });
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
