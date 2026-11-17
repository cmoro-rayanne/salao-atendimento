import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgAgendaAdminRepository } from '../../src/adapters/db/agenda-admin-repository.js';
import { PgAppointmentRepository, PgCatalogRepository } from '../../src/adapters/db/agenda-repositories.js';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import { fakeAdmin } from '../helpers/fake-admin.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const HOUR = 3_600_000;

/** Próxima terça-feira (fuso de São Paulo) às `hour`, pelo menos 2 dias à frente. */
function nextTuesday(hour: number, minute = 0): Date {
  const d = new Date(Date.now() + 2 * 24 * HOUR);
  for (let i = 0; i < 8; i++) {
    const w = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).format(d);
    if (w === 'Tue') break;
    d.setTime(d.getTime() + 24 * HOUR);
  }
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
  return new Date(`${ymd}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`);
}
const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);

describe.skipIf(!dbUrl)('painel do salão (rotas + Postgres)', () => {
  let sql: Sql;
  let cookie: string;
  let recepcao: string;
  let outro: string;
  let app: Awaited<ReturnType<typeof fakeAdmin>>['app'];
  let cancelled: string[];

  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, c = cookie) => {
    const res = await app.inject({
      method,
      url: `/admin/api${url}`,
      headers: { cookie: c },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { statusCode: res.statusCode, json: () => res.json() };
  };

  beforeAll(() => {
    sql = createSql(dbUrl!);
  });

  beforeEach(async () => {
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs, admin_users restart identity cascade`;
    await sql`insert into tenants (name, chatwoot_account_id) values ('Studio A', 31), ('Studio B', 32)`;
    cancelled = [];
    const catalog = new PgCatalogRepository(sql);
    const admin = await fakeAdmin({
      agendaAdmin: new PgAgendaAdminRepository(sql),
      agenda: {
        catalog,
        appointments: new PgAppointmentRepository(sql),
        reminders: {
          schedule: async (id, at) => `job-${id}-${at.getTime()}`,
          cancel: async (jobId) => void cancelled.push(jobId),
        },
        now: () => new Date(),
      },
    });
    app = admin.app;
    cookie = (await admin.loginAs('dono@ciadaforma.com.br', 'senha-forte-123')).cookie;
    recepcao = (await admin.loginAs('recepcao@ciadaforma.com.br', 'recepcao-123456')).cookie;
    outro = (await admin.loginAs('dono@outra.com.br', 'outra-senha-123')).cookie;
  });

  afterAll(async () => {
    await sql?.end();
  });

  async function setup() {
    const svc = (await call('POST', '/services', { name: 'Corte', description: null, durationMin: 60, priceCents: 8000, active: true })).json();
    const hours = [
      { weekday: 2, startMin: 540, endMin: 720 },
      { weekday: 2, startMin: 780, endMin: 1080 },
    ];
    const prof = (await call('POST', '/professionals', { name: 'Ana', active: true, serviceIds: [svc.id], hours })).json();
    return { serviceId: svc.id as number, professionalId: prof.id as number };
  }

  it('dono cadastra serviço e profissional; recepção só consulta', async () => {
    const { serviceId, professionalId } = await setup();
    const services = (await call('GET', '/services')).json().services;
    expect(services).toEqual([{ id: serviceId, name: 'Corte', description: null, durationMin: 60, priceCents: 8000, active: true }]);
    const profs = (await call('GET', '/professionals', undefined, recepcao)).json().professionals;
    expect(profs[0]).toMatchObject({ id: professionalId, name: 'Ana', serviceIds: [serviceId] });
    expect(profs[0].hours).toHaveLength(2);

    const denied = await call('POST', '/services', { name: 'X', description: null, durationMin: 30, priceCents: null, active: true }, recepcao);
    expect(denied.statusCode).toBe(403);
  });

  it('valida serviço e expediente', async () => {
    const { serviceId } = await setup();
    const bad = (payload: unknown) => call('POST', '/services', payload).then((r) => r.statusCode);
    expect(await bad({ name: '', description: null, durationMin: 30, priceCents: null, active: true })).toBe(400);
    expect(await bad({ name: 'A', description: null, durationMin: 2, priceCents: null, active: true })).toBe(400);
    expect(await bad({ name: 'A', description: null, durationMin: 30, priceCents: -1, active: true })).toBe(400);

    const prof = (payload: unknown) => call('POST', '/professionals', payload).then((r) => r.statusCode);
    expect(await prof({ name: 'B', active: true, serviceIds: [], hours: [{ weekday: 2, startMin: 600, endMin: 600 }] })).toBe(400);
    expect(
      await prof({ name: 'B', active: true, serviceIds: [], hours: [{ weekday: 2, startMin: 540, endMin: 720 }, { weekday: 2, startMin: 700, endMin: 800 }] }),
    ).toBe(400);
    expect(await prof({ name: 'B', active: true, serviceIds: [serviceId + 99], hours: [] })).toBe(400);
  });

  it('um salão não enxerga nem altera o cadastro do outro', async () => {
    const { serviceId, professionalId } = await setup();
    expect((await call('GET', '/services', undefined, outro)).json().services).toEqual([]);
    expect((await call('GET', '/professionals', undefined, outro)).json().professionals).toEqual([]);
    expect((await call('PUT', `/services/${serviceId}`, { name: 'Hack', description: null, durationMin: 30, priceCents: null, active: true }, outro)).statusCode).toBe(404);
    expect((await call('PUT', `/professionals/${professionalId}`, { name: 'Hack', active: true, serviceIds: [], hours: [] }, outro)).statusCode).toBe(404);
    expect((await call('POST', `/professionals/${professionalId}/time-off`, { startsAt: nextTuesday(9).toISOString(), endsAt: nextTuesday(12).toISOString(), reason: null }, outro)).statusCode).toBe(404);
    // serviço de outro salão não vira habilidade de profissional daqui
    const mine = (await call('POST', '/services', { name: 'Escova', description: null, durationMin: 30, priceCents: null, active: true }, outro)).json();
    expect((await call('PUT', `/professionals/${professionalId}`, { name: 'Ana', active: true, serviceIds: [mine.id], hours: [] })).statusCode).toBe(400);
  });

  it('recepção agenda manualmente, o horário some da lista e o telefone é normalizado', async () => {
    const { serviceId, professionalId } = await setup();
    const at = nextTuesday(10);

    const before = (await call('GET', `/free-slots?serviceId=${serviceId}&day=${dayOf(at)}`, undefined, recepcao)).json().slots;
    expect(before.map((s: { startsAt: string }) => s.startsAt)).toContain(at.toISOString());

    const res = await call('POST', '/appointments', { serviceId, professionalId, startsAt: at.toISOString(), phone: '(41) 99999-0001', name: 'Ana Paula' }, recepcao);
    expect(res.statusCode).toBe(201);

    const after = (await call('GET', `/free-slots?serviceId=${serviceId}&day=${dayOf(at)}`)).json().slots;
    expect(after.map((s: { startsAt: string }) => s.startsAt)).not.toContain(at.toISOString());

    const list = (await call('GET', `/appointments?from=${at.toISOString()}&to=${new Date(at.getTime() + HOUR).toISOString()}`)).json().appointments;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ clientPhone: '+5541999990001', clientName: 'Ana Paula', source: 'painel', status: 'agendado', serviceName: 'Corte' });

    // mesmo horário de novo: ocupado
    const again = await call('POST', '/appointments', { serviceId, professionalId, startsAt: at.toISOString(), phone: '41988887777', name: null });
    expect(again.statusCode).toBe(409);
    expect((await call('POST', '/appointments', { serviceId, professionalId, startsAt: nextTuesday(11).toISOString(), phone: '123', name: null })).statusCode).toBe(400);
    expect((await call('POST', '/appointments', { serviceId, professionalId, startsAt: nextTuesday(8).toISOString(), phone: '41988887777', name: null })).statusCode).toBe(409);
  });

  it('remarcar e cancelar pelo painel liberam o horário e removem o lembrete', async () => {
    const { serviceId, professionalId } = await setup();
    const first = nextTuesday(10);
    const id = (await call('POST', '/appointments', { serviceId, professionalId, startsAt: first.toISOString(), phone: '41999990001', name: 'Cliente' })).json().id;

    const moved = await call('POST', `/appointments/${id}/reschedule`, { startsAt: nextTuesday(15).toISOString() });
    expect(moved.statusCode).toBe(200);
    const [row] = await sql<{ starts_at: Date }[]>`select starts_at from appointments where id = ${id}`;
    expect(row!.starts_at.getTime()).toBe(nextTuesday(15).getTime());

    expect((await call('POST', `/appointments/${id}/reschedule`, { startsAt: nextTuesday(20).toISOString() })).statusCode).toBe(409);

    expect((await call('DELETE', `/appointments/${id}`)).statusCode).toBe(200);
    const [after] = await sql<{ status: string }[]>`select status from appointments where id = ${id}`;
    expect(after!.status).toBe('cancelado');
    expect((await call('DELETE', `/appointments/${id}`)).statusCode).toBe(404);
    expect((await call('DELETE', `/appointments/${id}`, undefined, outro)).statusCode).toBe(404);

    // o horário voltou a ficar livre
    const free = (await call('GET', `/free-slots?serviceId=${serviceId}&day=${dayOf(first)}`)).json().slots;
    expect(free.map((s: { startsAt: string }) => s.startsAt)).toContain(first.toISOString());
  });

  it('concluir e faltou só depois do horário; reabrir respeita choque; outro salão não mexe', async () => {
    const { serviceId, professionalId } = await setup();
    const id = (await call('POST', '/appointments', { serviceId, professionalId, startsAt: nextTuesday(10).toISOString(), phone: '41999990001', name: 'C' })).json().id;
    expect((await call('PATCH', `/appointments/${id}`, { status: 'concluido' })).statusCode).toBe(409); // ainda não começou

    // passa o horário para o passado e marca
    await sql`update appointments set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' where id = ${id}`;
    expect((await call('PATCH', `/appointments/${id}`, { status: 'faltou' }, outro)).statusCode).toBe(404);
    expect((await call('PATCH', `/appointments/${id}`, { status: 'faltou' })).statusCode).toBe(200);
    expect((await call('PATCH', `/appointments/${id}`, { status: 'concluido' })).statusCode).toBe(200);
    const [row] = await sql<{ status: string }[]>`select status from appointments where id = ${id}`;
    expect(row!.status).toBe('concluido');

    // reabrir com o horário já ocupado por outro: o banco recusa
    await sql`update appointments set status = 'faltou' where id = ${id}`;
    await sql`insert into appointments (tenant_id, lead_id, professional_id, service_id, starts_at, ends_at)
              select tenant_id, lead_id, professional_id, service_id, starts_at, ends_at from appointments where id = ${id}`;
    expect((await call('PATCH', `/appointments/${id}`, { status: 'agendado' })).statusCode).toBe(409);
  });

  it('folga bloqueia horários, avisa quantos agendamentos já existiam e pode ser removida', async () => {
    const { serviceId, professionalId } = await setup();
    await call('POST', '/appointments', { serviceId, professionalId, startsAt: nextTuesday(14).toISOString(), phone: '41999990001', name: 'C' });

    const off = await call('POST', `/professionals/${professionalId}/time-off`, {
      startsAt: nextTuesday(13).toISOString(),
      endsAt: nextTuesday(18).toISOString(),
      reason: 'consulta',
    }, recepcao);
    expect(off.statusCode).toBe(201);
    expect(off.json().affected).toBe(1);

    const day = dayOf(nextTuesday(10));
    const blocked = (await call('GET', `/free-slots?serviceId=${serviceId}&day=${day}`)).json().slots.map((s: { startsAt: string }) => s.startsAt);
    expect(blocked).not.toContain(nextTuesday(15).toISOString());
    expect(blocked).toContain(nextTuesday(10).toISOString());

    const profs = (await call('GET', '/professionals')).json().professionals;
    expect(profs[0].timeOff).toHaveLength(1);
    expect((await call('DELETE', `/professionals/${professionalId}/time-off/${off.json().id}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/professionals/${professionalId}/time-off/${off.json().id}`)).statusCode).toBe(404);

    expect((await call('POST', `/professionals/${professionalId}/time-off`, { startsAt: nextTuesday(12).toISOString(), endsAt: nextTuesday(9).toISOString(), reason: null })).statusCode).toBe(400);
  });

  it('desativar serviço tira da lista da IA mas mantém o cadastro no painel', async () => {
    const { serviceId } = await setup();
    await call('PUT', `/services/${serviceId}`, { name: 'Corte', description: 'Lavagem inclusa', durationMin: 45, priceCents: null, active: false });
    const services = (await call('GET', '/services')).json().services;
    expect(services[0]).toMatchObject({ active: false, durationMin: 45, priceCents: null, description: 'Lavagem inclusa' });
    expect(await new PgCatalogRepository(sql).listServices(1)).toEqual([]);
  });

  it('exige sessão', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/api/appointments?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z' });
    expect(res.statusCode).toBe(401);
  });
});
