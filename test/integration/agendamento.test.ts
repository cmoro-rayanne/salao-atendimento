import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgBookingRepository } from '../../src/adapters/db/booking-repository.js';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import { BullReminderScheduler, REMINDER_QUEUE } from '../../src/adapters/queue/reminder-queue.js';
import type { BookingRequest } from '../../src/modules/trial-classes/ports.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const HOUR = 3600_000;

describe.skipIf(!dbUrl)('agendamento no Postgres', () => {
  let sql: Sql;
  let repo: PgBookingRepository;
  let tenant: number;
  let other: number;

  const req = (slotId: number, phone: string, over: Partial<BookingRequest> = {}): BookingRequest => ({
    tenantId: tenant,
    slotId,
    contact: { phone, chatwootContactId: 1, name: 'Ana' },
    conversation: { accountId: 1, conversationId: 77 },
    notBefore: new Date(Date.now() + HOUR),
    ...over,
  });

  async function slot(capacity: number, inHours = 48, tenantId = tenant, modality = 'Pilates'): Promise<number> {
    const [r] = await sql<{ id: string }[]>`
      insert into trial_slots (tenant_id, modality, starts_at, capacity)
      values (${tenantId}, ${modality}, ${new Date(Date.now() + inHours * HOUR)}, ${capacity}) returning id
    `;
    return Number(r!.id);
  }

  beforeAll(async () => {
    sql = createSql(dbUrl!);
    repo = new PgBookingRepository(sql);
  });

  beforeEach(async () => {
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs, admin_users restart identity cascade`;
    [tenant, other] = (await sql<{ id: string }[]>`
      insert into tenants (name, chatwoot_account_id) values ('A', 21), ('B', 22) returning id
    `).map((r) => Number(r.id)) as [number, number];
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('lista só horários com vaga, da academia e na janela pedida, com filtro de modalidade', async () => {
    const free = await slot(2);
    const full = await slot(1);
    await sql`update trial_slots set booked = 1 where id = ${full}`;
    await slot(3, 48, other);
    await slot(3, 48, tenant, 'Funcional');
    await slot(3, 24 * 30); // fora da janela

    const from = new Date(Date.now() + HOUR);
    const to = new Date(Date.now() + 7 * 24 * HOUR);
    expect((await repo.listAvailable(tenant, from, to)).map((s) => s.modality).sort()).toEqual(['Funcional', 'Pilates']);
    expect((await repo.listAvailable(tenant, from, to, 'pila')).map((s) => s.id)).toEqual([free]);
  });

  it('agenda, ocupa a vaga, marca o lead e repetir não duplica', async () => {
    const s = await slot(3);
    const first = await repo.book(req(s, '+5541911110000'));
    const again = await repo.book(req(s, '+5541911110000'));

    expect(first.kind).toBe('booked');
    expect(again.kind).toBe('already_booked');
    const [row] = await sql`select booked from trial_slots where id = ${s}`;
    expect(row).toEqual({ booked: 1 });
    const [lead] = await sql`select status from leads where phone = '+5541911110000'`;
    expect(lead).toEqual({ status: 'experimental_agendada' });
  });

  it('última vaga disputada por 8 pessoas ao mesmo tempo: só uma consegue', async () => {
    const s = await slot(1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.book(req(s, `+55419000000${i}`))));
    expect(results.filter((r) => r.kind === 'booked')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'full')).toHaveLength(7);
    const [row] = await sql`select booked from trial_slots where id = ${s}`;
    expect(row).toEqual({ booked: 1 });
  });

  it('mesmo contato pedindo dois horários ao mesmo tempo fica com só um', async () => {
    const a = await slot(5);
    const b = await slot(5, 72);
    const results = await Promise.all([repo.book(req(a, '+5541922220000')), repo.book(req(b, '+5541922220000'))]);
    expect(results.map((r) => r.kind).sort()).toEqual(['booked', 'has_other']);
    const [row] = await sql`select count(*)::int as n from trial_bookings where status = 'agendada'`;
    expect(row).toEqual({ n: 1 });
  });

  it('recusa horário de outra academia, em cima da hora ou inexistente', async () => {
    expect((await repo.book(req(await slot(3, 48, other), '+5541933330000'))).kind).toBe('not_available');
    expect((await repo.book(req(await slot(3, 0.5), '+5541933330000'))).kind).toBe('not_available');
    expect((await repo.book(req(999_999, '+5541933330000'))).kind).toBe('not_available');
  });

  it('cancelar devolve a vaga e permite agendar de novo o mesmo horário', async () => {
    const s = await slot(1);
    const booked = await repo.book(req(s, '+5541944440000'));
    if (booked.kind !== 'booked') throw new Error('esperava booked');
    await repo.setReminderJob(booked.booking.bookingId, 'job-x');

    const cancel = await repo.cancelActive(tenant, '+5541944440000', new Date());
    expect(cancel).toMatchObject({ kind: 'cancelled', reminderJobId: 'job-x' });
    expect(await repo.cancelActive(tenant, '+5541944440000', new Date())).toEqual({ kind: 'none' });
    const [row] = await sql`select booked from trial_slots where id = ${s}`;
    expect(row).toEqual({ booked: 0 });

    expect((await repo.book(req(s, '+5541944440000'))).kind).toBe('booked');
  });

  it('lembrete: dados para o envio e marcação única', async () => {
    const s = await slot(3);
    const booked = await repo.book(req(s, '+5541955550000'));
    if (booked.kind !== 'booked') throw new Error('esperava booked');
    const id = booked.booking.bookingId;

    expect(await repo.getForReminder(id)).toMatchObject({
      status: 'agendada',
      modality: 'Pilates',
      leadName: 'Ana',
      accountId: 1,
      conversationId: 77,
      timeZone: 'America/Sao_Paulo',
      reminderSentAt: null,
    });
    expect(await repo.markReminderSent(id)).toBe(true);
    expect(await repo.markReminderSent(id)).toBe(false);
    expect((await repo.getForReminder(id))?.optedOut).toBe(false);
    await sql`update leads set opted_out_at = now() where phone = '+5541955550000'`;
    expect((await repo.getForReminder(id))?.optedOut).toBe(true);
    await repo.clearReminderSent(id);
    expect(await repo.markReminderSent(id)).toBe(true);
  });
});

describe.skipIf(!redisUrl)('lembretes no BullMQ', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it('agenda com atraso e cancela', async () => {
    const scheduler = new BullReminderScheduler(redis);
    const jobId = await scheduler.schedule(42, new Date(Date.now() + 2 * HOUR));
    const q = new Queue(REMINDER_QUEUE, { connection: redis });

    const job = await q.getJob(jobId);
    expect(job?.data).toEqual({ bookingId: 42 });
    expect(await job?.getState()).toBe('delayed');

    await scheduler.cancel(jobId);
    expect(await q.getJob(jobId)).toBeUndefined();
    await scheduler.cancel('nao-existe'); // não lança

    await q.close();
    await scheduler.close();
  });
});
