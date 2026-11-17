import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPOINTMENT_REMINDER_QUEUE, BullAppointmentReminderScheduler } from '../../src/adapters/queue/appointment-reminder-queue.js';

const redisUrl = process.env.TEST_REDIS_URL;
const HOUR = 3_600_000;

describe.skipIf(!redisUrl)('lembretes de agendamento no BullMQ', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('agenda com atraso, tem id próprio por horário e cancela', async () => {
    const scheduler = new BullAppointmentReminderScheduler(redis);
    const q = new Queue(APPOINTMENT_REMINDER_QUEUE, { connection: redis });
    const at = new Date(Date.now() + 2 * HOUR);

    const jobId = await scheduler.schedule(4242, at);
    const job = await q.getJob(jobId);
    expect(job?.data).toEqual({ appointmentId: 4242 });
    expect(await job?.getState()).toBe('delayed');

    // remarcado: novo horário gera outro job, sem colidir com o antigo
    const other = await scheduler.schedule(4242, new Date(at.getTime() + HOUR));
    expect(other).not.toBe(jobId);

    await scheduler.cancel(jobId);
    await scheduler.cancel(other);
    expect(await q.getJob(jobId)).toBeUndefined();
    await scheduler.cancel('nao-existe'); // não lança

    await q.close();
    await scheduler.close();
  });
});
