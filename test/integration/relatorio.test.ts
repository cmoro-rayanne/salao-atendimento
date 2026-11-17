import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import {
  PgClientAdminRepository,
  PgReportRepository,
  PgUnansweredQuestionRepository,
} from '../../src/adapters/db/panel-repositories.js';
import { PgHandoffRepository } from '../../src/adapters/db/repositories.js';
import { buildMonthlyReport } from '../../src/modules/reports/monthly-report.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const TZ = 'America/Sao_Paulo';

describe.skipIf(!dbUrl)('clientes e relatório no Postgres', () => {
  let sql: Sql;
  let t1: number;
  let t2: number;

  // Instantes em horário de Brasília, para ler fácil.
  const br = (s: string) => new Date(`${s}-03:00`);

  beforeAll(async () => {
    sql = createSql(dbUrl!);
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs, admin_users restart identity cascade`;
    [t1, t2] = (await sql<{ id: string }[]>`
      insert into tenants (name, chatwoot_account_id, reception_hours) values
        ('A', 31, '{"open": 7, "close": 21}'), ('B', 32, '{}')
      returning id
    `).map((r) => Number(r.id)) as [number, number];

    // Conversas: 101 e 102 em novembro; 103 em 31/10 às 23h (fora); 104 é de outro salão.
    const run = (tenant: number, conv: number, at: string, outcome = 'reply', cost = 0.01, latency = 4000) =>
      sql`insert into agent_runs (tenant_id, conversation_id, outcome, cost_usd, latency_ms, created_at, input_tokens, output_tokens, steps)
          values (${tenant}, ${conv}, ${outcome}, ${cost}, ${latency}, ${br(at)}, 0, 0, 1)`;
    await run(t1, 101, '2026-11-02T22:30:00'); // 22h: recepção fechada
    await run(t1, 101, '2026-11-02T22:35:00', 'reply', 0.01, 6000);
    await run(t1, 102, '2026-11-05T10:00:00', 'handoff_tool', 0.02, 8000);
    await run(t1, 102, '2026-11-05T10:01:00', 'skipped', 0, 0);
    await run(t1, 103, '2026-10-31T23:00:00');
    await run(t2, 104, '2026-11-03T10:00:00');
    await sql`insert into handoffs (tenant_id, conversation_id, reason, created_at) values
      (${t1}, 102, 'Quer se matricular', ${br('2026-11-05T10:01:00')}),
      (${t2}, 104, 'Lesão no joelho', ${br('2026-11-03T10:01:00')})`;

    // Clientes: Carla (criada em nov), Bia (nov), Davi (criado em out); Outra é de outro salão.
    await sql`insert into leads (tenant_id, phone, name, created_at, updated_at) values
      (${t1}, '+5541911110001', 'Carla Mendes', ${br('2026-11-02T22:31:00')}, ${br('2026-11-10T10:00:00')}),
      (${t1}, '+5541911110002', 'Bia', ${br('2026-11-05T10:00:00')}, ${br('2026-11-05T10:00:00')}),
      (${t1}, '+5541911110003', 'Davi', ${br('2026-10-20T10:00:00')}, ${br('2026-10-20T10:00:00')}),
      (${t2}, '+5541911110004', 'Outra', ${br('2026-11-03T10:00:00')}, ${br('2026-11-03T10:00:00')})`;
    const [lead] = await sql<{ id: string }[]>`select id from leads where phone = '+5541911110001'`;

    // Salão: serviços, profissionais e agendamentos de novembro (concluído x2 de Corte, falta de Escova,
    // cancelado de Corte, agendado futuro de Corte); um em dezembro e um de outro salão ficam de fora.
    const sv = async (t: number, name: string) =>
      Number((await sql<{ id: string }[]>`insert into salon_services (tenant_id, name, duration_min) values (${t}, ${name}, 30) returning id`)[0]!.id);
    const pr = async (t: number, name: string) =>
      Number((await sql<{ id: string }[]>`insert into professionals (tenant_id, name) values (${t}, ${name}) returning id`)[0]!.id);
    const [corte, escova, outroServico] = [await sv(t1, 'Corte'), await sv(t1, 'Escova'), await sv(t2, 'Corte')];
    const [ana, outraProf] = [await pr(t1, 'Ana'), await pr(t2, 'Zé')];
    const [outra] = await sql<{ id: string }[]>`select id from leads where phone = '+5541911110004'`;
    const ap = (t: number, prof: number, svc: number, at: string, status: string, who = lead!.id) =>
      sql`insert into appointments (tenant_id, lead_id, professional_id, service_id, starts_at, ends_at, status)
          values (${t}, ${who}, ${prof}, ${svc}, ${br(at)}, ${br(at)}::timestamptz + interval '30 minutes', ${status})`;
    await ap(t1, ana, corte, '2026-11-03T09:00:00', 'concluido');
    await ap(t1, ana, corte, '2026-11-04T09:00:00', 'concluido');
    await ap(t1, ana, escova, '2026-11-05T09:00:00', 'faltou');
    await ap(t1, ana, corte, '2026-11-06T09:00:00', 'cancelado');
    await ap(t1, ana, corte, '2026-11-20T09:00:00', 'agendado');
    await ap(t1, ana, corte, '2026-12-02T09:00:00', 'agendado');
    await ap(t2, outraProf, outroServico, '2026-11-03T09:00:00', 'concluido', outra!.id);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('relatório de novembro bate com os dados montados', async () => {
    const report = await buildMonthlyReport(new PgReportRepository(sql), {
      tenantId: t1,
      timeZone: TZ,
      month: '2026-11',
      now: br('2026-12-05T12:00:00'),
      usdBrl: 5,
    });

    expect(report.partial).toBe(false);
    expect(report.conversations).toBe(2);
    expect(report.resolvedByAiShare).toBe(0.5);
    expect(report.funnel.map((f) => f.count)).toEqual([2, 4, 2]);
    expect(report.appointments).toEqual({ scheduled: 4, completed: 2, noShow: 1, cancelled: 1 });
    expect(report.noShowShare).toBeCloseTo(1 / 3);
    expect(report.topServices).toEqual([
      { name: 'Corte', count: 3 },
      { name: 'Escova', count: 1 },
    ]);
    expect(report.handoffs.byCategory).toEqual([{ label: 'Matrícula ou pagamento', count: 1 }]);
    expect(report.conversationsByHour[22]).toBe(1);
    expect(report.conversationsByHour[10]).toBe(1);
    expect(report.outsideReceptionShare).toBe(0.5);
    expect(report.aiCostUsd).toBeCloseTo(0.04);
    expect(report.aiCostBrl).toBeCloseTo(0.2);
    expect(report.medianLatencyMs).toBe(6000);
  });

  it('mês em andamento conta só até agora', async () => {
    const report = await buildMonthlyReport(new PgReportRepository(sql), {
      tenantId: t1,
      timeZone: TZ,
      month: '2026-11',
      now: br('2026-11-04T00:00:00'),
      usdBrl: null,
    });
    expect(report.partial).toBe(true);
    expect(report.conversations).toBe(1);
    expect(report.aiCostBrl).toBeNull();
  });

  it('clientes: lista com próximo horário e contagens; busca por telefone sem formatação', async () => {
    const repo = new PgClientAdminRepository(sql);
    const q = { now: br('2026-11-15T00:00:00'), limit: 100 };
    const all = await repo.list(t1, q);
    expect(all.map((c) => c.name)).toEqual(['Carla Mendes', 'Bia', 'Davi']);
    const carla = all.find((c) => c.name === 'Carla Mendes')!;
    expect(carla).toMatchObject({ completed: 2, noShows: 1, optedOut: false });
    expect(carla.nextAppointment).toMatchObject({ startsAt: br('2026-11-20T09:00:00'), serviceName: 'Corte', professionalName: 'Ana' });
    expect(all.find((c) => c.name === 'Bia')!.nextAppointment).toBeNull();
    expect((await repo.list(t1, { ...q, search: '(41) 91111-0002' })).map((c) => c.name)).toEqual(['Bia']);
    expect(await repo.list(t1, { ...q, search: 'Bi_' })).toHaveLength(0); // curinga tratado como texto
    expect((await repo.list(t2, q)).map((c) => c.name)).toEqual(['Outra']);
  });

  it('perguntas sem resposta: grava, lista por academia e período, marca resolvida', async () => {
    const handoffs = new PgHandoffRepository(sql);
    await handoffs.record(201, 'Dúvida fora da base', t1, 'Vocês têm natação?');
    await handoffs.record(202, 'Quer se matricular', t1);
    await handoffs.record(203, 'Dúvida fora da base', t2, 'Tem crossfit?');
    const repo = new PgUnansweredQuestionRepository(sql);
    const now = new Date();
    const range = [new Date(now.getTime() - 60_000), new Date(now.getTime() + 60_000)] as const;

    const items = await repo.list(t1, ...range, 50);
    expect(items).toEqual([
      { id: expect.any(Number), question: 'Vocês têm natação?', conversationId: 201, createdAt: expect.any(Date), resolvedAt: null },
    ]);
    const id = items[0]!.id;
    expect(await repo.setResolved(t2, id, true, now)).toBe(false);
    expect(await repo.setResolved(t1, id, true, now)).toBe(true);
    expect((await repo.list(t1, ...range, 50))[0]?.resolvedAt).toBeInstanceOf(Date);
    expect(await repo.setResolved(t1, id, false, now)).toBe(true);
    expect((await repo.list(t1, ...range, 50))[0]?.resolvedAt).toBeNull();
    expect(await repo.list(t1, new Date('2020-01-01'), new Date('2020-02-01'), 50)).toEqual([]);
  });
});
