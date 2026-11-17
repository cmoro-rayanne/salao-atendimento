import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import { PgAppointmentRepository, PgCatalogRepository } from '../../src/adapters/db/agenda-repositories.js';
import type { BookRequest } from '../../src/modules/appointments/ports.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const HOUR = 3600_000;

/** Próxima terça-feira (a partir de daqui a 2 dias) às `hour` h no fuso de São Paulo, como instante UTC. */
function nextTuesday(hour: number, minute = 0): Date {
  const base = new Date(Date.now() + 2 * 24 * HOUR);
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(base.getTime() + i * 24 * HOUR);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(d);
    if (wd === 'Tue') {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
      return new Date(`${p}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`);
    }
  }
  throw new Error('sem terça');
}

describe.skipIf(!dbUrl)('agenda do salão no Postgres', () => {
  let sql: Sql;
  let repo: PgAppointmentRepository;
  let catalog: PgCatalogRepository;
  let tenant: number;
  let other: number;
  let corte: number; // 60 min
  let escova: number; // 30 min, só a Bia faz
  let ana: number;
  let bia: number;

  const book = (over: Partial<BookRequest> = {}): BookRequest => ({
    tenantId: tenant,
    serviceId: corte,
    professionalId: ana,
    startsAt: nextTuesday(10),
    contact: { phone: '+5541999990001', chatwootContactId: 1, name: 'Cliente 1' },
    conversation: { accountId: 1, conversationId: 10 },
    source: 'ia',
    now: new Date(),
    ...over,
  });

  beforeAll(() => {
    sql = createSql(dbUrl!);
    repo = new PgAppointmentRepository(sql);
    catalog = new PgCatalogRepository(sql);
  });

  beforeEach(async () => {
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs, admin_users restart identity cascade`;
    [tenant, other] = (await sql<{ id: string }[]>`
      insert into tenants (name, chatwoot_account_id) values ('Studio A', 31), ('Studio B', 32) returning id
    `).map((r) => Number(r.id)) as [number, number];

    const svc = async (t: number, name: string, min: number, price: number | null) =>
      Number((await sql<{ id: string }[]>`insert into salon_services (tenant_id, name, duration_min, price_cents) values (${t}, ${name}, ${min}, ${price}) returning id`)[0]!.id);
    corte = await svc(tenant, 'Corte', 60, 8000);
    escova = await svc(tenant, 'Escova', 30, null);

    const prof = async (t: number, name: string, services: number[]) => {
      const id = Number((await sql<{ id: string }[]>`insert into professionals (tenant_id, name) values (${t}, ${name}) returning id`)[0]!.id);
      for (const s of services) await sql`insert into professional_services (professional_id, service_id) values (${id}, ${s})`;
      // terça (2): 9h–12h e 13h–18h
      await sql`insert into working_hours (professional_id, weekday, start_min, end_min) values (${id}, 2, 540, 720), (${id}, 2, 780, 1080)`;
      return id;
    };
    ana = await prof(tenant, 'Ana', [corte]);
    bia = await prof(tenant, 'Bia', [corte, escova]);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('agenda dentro do expediente e repetir o mesmo pedido não duplica', async () => {
    const r = await repo.book(book());
    expect(r.kind).toBe('booked');
    const again = await repo.book(book());
    expect(again.kind).toBe('already_booked');
    const [row] = await sql<{ n: string }[]>`select count(*) as n from appointments`;
    expect(Number(row!.n)).toBe(1);
  });

  it('recusa horário fora do expediente, no almoço, no passado e sem antecedência', async () => {
    expect((await repo.book(book({ startsAt: nextTuesday(8) }))).kind).toBe('not_available');
    expect((await repo.book(book({ startsAt: nextTuesday(12) }))).kind).toBe('not_available'); // almoço
    expect((await repo.book(book({ startsAt: nextTuesday(11, 30) }))).kind).toBe('not_available'); // 1h passaria do meio-dia
    expect((await repo.book(book({ startsAt: new Date(Date.now() - 24 * HOUR) }))).kind).toBe('not_available');
    expect((await repo.book(book({ startsAt: new Date(Date.now() + 10 * 60_000) }))).kind).toBe('not_available');
  });

  it('recusa serviço que a profissional não faz e serviço de outro salão', async () => {
    expect((await repo.book(book({ serviceId: escova, professionalId: ana }))).kind).toBe('not_available');
    const [row] = await sql<{ id: string }[]>`insert into salon_services (tenant_id, name, duration_min) values (${other}, 'Outro', 30) returning id`;
    expect((await repo.book(book({ serviceId: Number(row!.id) }))).kind).toBe('not_available');
  });

  it('duas clientes pedindo o mesmo horário da mesma profissional: só uma agenda', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repo.book(book({ contact: { phone: `+55419999000${i + 10}`, chatwootContactId: i + 10, name: `C${i}` } })),
      ),
    );
    expect(results.filter((r) => r.kind === 'booked')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'busy')).toHaveLength(7);
    const [row] = await sql<{ n: string }[]>`select count(*) as n from appointments where status = 'agendado'`;
    expect(Number(row!.n)).toBe(1);
  });

  it('horários que se sobrepõem parcialmente também são recusados; colados são aceitos', async () => {
    expect((await repo.book(book({ startsAt: nextTuesday(10) }))).kind).toBe('booked'); // 10h–11h
    const other1 = { phone: '+5541999990002', chatwootContactId: 2, name: 'C2' };
    expect((await repo.book(book({ startsAt: nextTuesday(10, 30), contact: other1 }))).kind).toBe('busy');
    expect((await repo.book(book({ startsAt: nextTuesday(11), contact: other1 }))).kind).toBe('booked'); // 11h–12h
  });

  it('o banco recusa sobreposição mesmo sem passar pela regra da aplicação', async () => {
    await repo.book(book());
    const [lead] = await sql<{ id: string }[]>`select id from leads limit 1`;
    await expect(sql`
      insert into appointments (tenant_id, lead_id, professional_id, service_id, starts_at, ends_at)
      values (${tenant}, ${lead!.id}, ${ana}, ${corte}, ${nextTuesday(10, 30)}, ${nextTuesday(11, 30)})
    `).rejects.toMatchObject({ code: '23P01' });
  });

  it('cancelado libera o horário para outra cliente', async () => {
    const first = await repo.book(book());
    if (first.kind !== 'booked') throw new Error('esperava booked');
    const c = await repo.cancel(tenant, first.appointment.id, '+5541999990001', new Date());
    expect(c.kind).toBe('cancelled');
    const second = await repo.book(book({ contact: { phone: '+5541999990002', chatwootContactId: 2, name: 'C2' } }));
    expect(second.kind).toBe('booked');
  });

  it('a mesma cliente não marca dois horários que se sobrepõem em profissionais diferentes', async () => {
    await repo.book(book({ professionalId: ana }));
    const r = await repo.book(book({ professionalId: bia, startsAt: nextTuesday(10, 30) }));
    expect(r.kind).toBe('client_busy');
  });

  it('cancelar é só do próprio contato e só de agendamento futuro ativo', async () => {
    const first = await repo.book(book());
    if (first.kind !== 'booked') throw new Error('esperava booked');
    expect((await repo.cancel(tenant, first.appointment.id, '+5541000000000', new Date())).kind).toBe('not_found');
    expect((await repo.cancel(other, first.appointment.id, '+5541999990001', new Date())).kind).toBe('not_found');
    expect((await repo.cancel(tenant, first.appointment.id, '+5541999990001', new Date())).kind).toBe('cancelled');
    expect((await repo.cancel(tenant, first.appointment.id, '+5541999990001', new Date())).kind).toBe('not_found');
  });

  it('remarcar move o horário e libera o antigo', async () => {
    const first = await repo.book(book());
    if (first.kind !== 'booked') throw new Error('esperava booked');
    const r = await repo.reschedule({ tenantId: tenant, appointmentId: first.appointment.id, phone: '+5541999990001', startsAt: nextTuesday(15), now: new Date() });
    expect(r.kind).toBe('rescheduled');
    // o 10h antigo ficou livre
    expect((await repo.book(book({ contact: { phone: '+5541999990002', chatwootContactId: 2, name: 'C2' } }))).kind).toBe('booked');
    expect((await repo.listUpcoming(tenant, '+5541999990001', new Date()))[0]!.startsAt.getTime()).toBe(nextTuesday(15).getTime());
  });

  it('remarcar para horário ocupado mantém o agendamento original', async () => {
    const mine = await repo.book(book({ startsAt: nextTuesday(10) }));
    await repo.book(book({ startsAt: nextTuesday(15), contact: { phone: '+5541999990002', chatwootContactId: 2, name: 'C2' } }));
    if (mine.kind !== 'booked') throw new Error('esperava booked');
    const r = await repo.reschedule({ tenantId: tenant, appointmentId: mine.appointment.id, phone: '+5541999990001', startsAt: nextTuesday(15, 30), now: new Date() });
    expect(r.kind).toBe('busy');
    expect((await repo.listUpcoming(tenant, '+5541999990001', new Date()))[0]!.startsAt.getTime()).toBe(nextTuesday(10).getTime());
  });

  it('remarcar para o mesmo horário devolve "unchanged"; trocar só de profissional funciona', async () => {
    const mine = await repo.book(book());
    if (mine.kind !== 'booked') throw new Error('esperava booked');
    const same = await repo.reschedule({ tenantId: tenant, appointmentId: mine.appointment.id, phone: '+5541999990001', startsAt: nextTuesday(10), now: new Date() });
    expect(same.kind).toBe('unchanged');
    const swap = await repo.reschedule({ tenantId: tenant, appointmentId: mine.appointment.id, phone: '+5541999990001', startsAt: nextTuesday(10), professionalId: bia, now: new Date() });
    expect(swap.kind).toBe('rescheduled');
    expect(swap.kind === 'rescheduled' && swap.appointment.professionalName).toBe('Bia');
  });

  it('folga bloqueia o horário', async () => {
    await sql`insert into time_off (professional_id, starts_at, ends_at, reason) values (${ana}, ${nextTuesday(13)}, ${nextTuesday(18)}, 'consulta')`;
    expect((await repo.book(book({ startsAt: nextTuesday(14) }))).kind).toBe('not_available');
    expect((await repo.book(book({ startsAt: nextTuesday(10) }))).kind).toBe('booked');
  });

  describe('lembrete', () => {
    it('devolve os dados do envio e marca o envio uma única vez', async () => {
      const r = await repo.book(book());
      if (r.kind !== 'booked') throw new Error('esperava booked');
      const info = await repo.getForReminder(r.appointment.id);
      expect(info).toMatchObject({
        status: 'agendado',
        accountId: 1,
        conversationId: 10,
        leadName: 'Cliente 1',
        serviceName: 'Corte',
        professionalName: 'Ana',
        optedOut: false,
        reminderSentAt: null,
      });
      expect(await repo.markReminderSent(r.appointment.id)).toBe(true);
      expect(await repo.markReminderSent(r.appointment.id)).toBe(false);
      expect((await repo.getForReminder(r.appointment.id))?.reminderSentAt).toBeInstanceOf(Date);
      await repo.clearReminderSent(r.appointment.id);
      expect(await repo.markReminderSent(r.appointment.id)).toBe(true);
    });

    it('reflete cancelamento e opt-out; agendamento inexistente devolve null', async () => {
      const r = await repo.book(book());
      if (r.kind !== 'booked') throw new Error('esperava booked');
      await sql`update leads set opted_out_at = now() where phone = '+5541999990001'`;
      expect((await repo.getForReminder(r.appointment.id))?.optedOut).toBe(true);
      await repo.cancel(tenant, r.appointment.id, '+5541999990001', new Date());
      expect((await repo.getForReminder(r.appointment.id))?.status).toBe('cancelado');
      expect(await repo.getForReminder(999_999)).toBeNull();
    });

    it('remarcar zera a marca de envio', async () => {
      const r = await repo.book(book());
      if (r.kind !== 'booked') throw new Error('esperava booked');
      await repo.markReminderSent(r.appointment.id);
      await repo.reschedule({ tenantId: tenant, appointmentId: r.appointment.id, phone: '+5541999990001', startsAt: nextTuesday(15), now: new Date() });
      expect((await repo.getForReminder(r.appointment.id))?.reminderSentAt).toBeNull();
    });
  });

  describe('cadastro (lado da IA)', () => {
    it('lista só serviços ativos do próprio salão e profissionais que fazem o serviço', async () => {
      await sql`update salon_services set active = false where id = ${escova}`;
      await sql`insert into salon_services (tenant_id, name, duration_min) values (${other}, 'Do outro', 30)`;
      expect((await catalog.listServices(tenant)).map((s) => s.name)).toEqual(['Corte']);
      expect((await catalog.listProfessionals(tenant, corte)).map((p) => p.name)).toEqual(['Ana', 'Bia']);
      expect((await catalog.listProfessionals(tenant, escova)).map((p) => p.name)).toEqual(['Bia']);
      expect(await catalog.getService(tenant, escova)).toBeNull();
    });

    it('carrega agenda só de profissionais do próprio salão', async () => {
      const [row] = await sql<{ id: string }[]>`insert into professionals (tenant_id, name) values (${other}, 'Estranha') returning id`;
      const s = await catalog.loadSchedules(tenant, [ana, Number(row!.id)], nextTuesday(9), nextTuesday(18));
      expect(s.map((x) => x.professionalId)).toEqual([ana]);
      expect(s[0]!.hours).toHaveLength(2);
    });

    it('conta agendamentos do dia por profissional', async () => {
      await repo.book(book());
      const loads = await catalog.dayLoads(tenant, [ana, bia], nextTuesday(0), nextTuesday(23));
      expect(loads.get(ana)).toBe(1);
      expect(loads.get(bia)).toBeUndefined();
    });
  });
});
