import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import {
  PgBookingAdminRepository,
  PgLeadAdminRepository,
  PgReportRepository,
  PgUnansweredQuestionRepository,
} from '../../src/adapters/db/panel-repositories.js';
import { PgHandoffRepository } from '../../src/adapters/db/repositories.js';
import { buildMonthlyReport } from '../../src/modules/reports/monthly-report.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const TZ = 'America/Sao_Paulo';

describe.skipIf(!dbUrl)('leads, presença e relatório no Postgres', () => {
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

    // Conversas: 101 e 102 em novembro; 103 em 31/10 às 23h (fora); 104 é de outra academia.
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

    // Leads: Carla (interesse, criada em nov, matriculada em nov), Bia (sem interesse), Davi (criado em out).
    await sql`insert into leads (tenant_id, phone, name, goal, status, created_at, updated_at, enrolled_at) values
      (${t1}, '+5541911110001', 'Carla Mendes', 'emagrecer', 'matriculado', ${br('2026-11-02T22:31:00')}, ${br('2026-11-10T10:00:00')}, ${br('2026-11-10T10:00:00')}),
      (${t1}, '+5541911110002', 'Bia', null, 'novo', ${br('2026-11-05T10:00:00')}, ${br('2026-11-05T10:00:00')}, null),
      (${t1}, '+5541911110003', 'Davi', 'massa', 'qualificado', ${br('2026-10-20T10:00:00')}, ${br('2026-10-20T10:00:00')}, null),
      (${t2}, '+5541911110004', 'Outra', 'x', 'novo', ${br('2026-11-03T10:00:00')}, ${br('2026-11-03T10:00:00')}, null)`;

    // Aulas de novembro: uma veio, uma faltou, uma cancelada; uma em dezembro.
    const [s1, s2, s3, s4] = (await sql<{ id: string }[]>`insert into trial_slots (tenant_id, modality, starts_at, capacity, booked) values
      (${t1}, 'Pilates', ${br('2026-11-06T08:00:00')}, 4, 1),
      (${t1}, 'Funcional', ${br('2026-11-07T08:00:00')}, 4, 1),
      (${t1}, 'Funcional', ${br('2026-11-08T08:00:00')}, 4, 0),
      (${t1}, 'Pilates', ${br('2026-12-02T08:00:00')}, 4, 1)
      returning id`).map((r) => Number(r.id));
    const [lead] = await sql<{ id: string }[]>`select id from leads where phone = '+5541911110001'`;
    await sql`insert into trial_bookings (slot_id, lead_id, status) values
      (${s1!}, ${lead!.id}, 'compareceu'), (${s2!}, ${lead!.id}, 'faltou'), (${s3!}, ${lead!.id}, 'cancelada'), (${s4!}, ${lead!.id}, 'agendada')`;
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
    expect(report.funnel.map((f) => f.count)).toEqual([2, 1, 2, 1, 1]);
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

  it('leads: filtro, busca por telefone sem formatação e contagem', async () => {
    const repo = new PgLeadAdminRepository(sql);
    const nov = { from: br('2026-11-01T00:00:00'), to: br('2026-12-01T00:00:00'), limit: 100 };
    const all = await repo.list(t1, nov);
    expect(all.items.map((l) => l.name)).toEqual(['Carla Mendes', 'Bia']);
    expect(all.counts).toMatchObject({ matriculado: 1, novo: 1, qualificado: 0 });
    expect((await repo.list(t1, { ...nov, status: 'novo' })).items.map((l) => l.name)).toEqual(['Bia']);
    expect((await repo.list(t1, { ...nov, search: '(41) 91111-0002' })).items.map((l) => l.name)).toEqual(['Bia']);
    expect((await repo.list(t1, { ...nov, search: 'Bi_' })).items).toHaveLength(0); // curinga tratado como texto
  });

  it('leads: versão antiga não altera; desmatricular limpa a data', async () => {
    const repo = new PgLeadAdminRepository(sql);
    const [carla] = await sql<{ id: string; version: number }[]>`select id, version from leads where name = 'Carla Mendes'`;
    const id = Number(carla!.id);
    expect(await repo.updateStatus(t1, id, 'perdido', carla!.version - 1)).toEqual({ kind: 'conflict', currentVersion: carla!.version });
    expect(await repo.updateStatus(t2, id, 'perdido', carla!.version)).toEqual({ kind: 'not_found' });
    expect(await repo.updateStatus(t1, id, 'perdido', carla!.version)).toEqual({ kind: 'ok', version: carla!.version + 1 });
    const [after] = await sql`select status, enrolled_at from leads where id = ${id}`;
    expect(after).toEqual({ status: 'perdido', enrolled_at: null });
  });

  it('aulas: lista sem canceladas e marca presença só depois de começar', async () => {
    const repo = new PgBookingAdminRepository(sql);
    const list = await repo.list(t1, br('2026-11-01T00:00:00'), br('2027-01-01T00:00:00'));
    expect(list.map((b) => b.status)).toEqual(['compareceu', 'faltou', 'agendada']);
    const december = list[2]!;
    expect(await repo.markAttendance(t1, december.id, 'compareceu', br('2026-11-20T00:00:00'))).toBe('not_started');
    expect(await repo.markAttendance(t2, december.id, 'compareceu', br('2026-12-03T00:00:00'))).toBe('not_found');
    expect(await repo.markAttendance(t1, december.id, 'compareceu', br('2026-12-03T00:00:00'))).toBe('ok');
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
