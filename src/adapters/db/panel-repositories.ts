import { z } from 'zod';
import type { ClientAdminRepository, ClientListItem, ClientQuery } from '../../modules/clients/ports.js';
import type { UnansweredQuestion, UnansweredQuestionRepository } from '../../modules/handoff/ports.js';
import type { MonthlyRawData, ReportRange, ReportRepository } from '../../modules/reports/ports.js';
import type { Sql } from './client.js';

/** Escapa curingas do LIKE para a busca tratar o texto literalmente. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgClientAdminRepository implements ClientAdminRepository {
  constructor(private readonly sql: Sql) {}

  async list(tenantId: number, q: ClientQuery): Promise<ClientListItem[]> {
    const search = q.search?.trim();
    const digits = search?.replace(/\D/g, '') ?? '';
    const filter = search
      ? this.sql`and (l.name ilike ${'%' + likeEscape(search) + '%'} ${
          digits.length >= 3 ? this.sql`or regexp_replace(l.phone, '\\D', '', 'g') like ${'%' + digits + '%'}` : this.sql``
        })`
      : this.sql``;

    const rows = await this.sql<
      {
        id: string;
        name: string | null;
        phone: string;
        chatwoot_contact_id: string | null;
        opted_out_at: Date | null;
        updated_at: Date;
        completed: number;
        no_shows: number;
        next_starts_at: Date | null;
        next_service: string | null;
        next_professional: string | null;
      }[]
    >`
      select l.id, l.name, l.phone, l.chatwoot_contact_id, l.opted_out_at, l.updated_at,
             (select count(*)::int from appointments a where a.lead_id = l.id and a.status = 'concluido') as completed,
             (select count(*)::int from appointments a where a.lead_id = l.id and a.status = 'faltou') as no_shows,
             nx.starts_at as next_starts_at, nx.service_name as next_service, nx.professional_name as next_professional
      from leads l
      left join lateral (
        select a.starts_at, sv.name as service_name, p.name as professional_name
        from appointments a
        join salon_services sv on sv.id = a.service_id
        join professionals p on p.id = a.professional_id
        where a.lead_id = l.id and a.status = 'agendado' and a.starts_at > ${q.now}
        order by a.starts_at limit 1
      ) nx on true
      where l.tenant_id = ${tenantId} ${filter}
      order by l.updated_at desc
      limit ${q.limit}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      phone: r.phone,
      chatwootContactId: r.chatwoot_contact_id === null ? null : Number(r.chatwoot_contact_id),
      nextAppointment:
        r.next_starts_at && r.next_service && r.next_professional
          ? { startsAt: r.next_starts_at, serviceName: r.next_service, professionalName: r.next_professional }
          : null,
      completed: r.completed,
      noShows: r.no_shows,
      optedOut: r.opted_out_at !== null,
      updatedAt: r.updated_at,
    }));
  }
}

const ReceptionHours = z.object({ open: z.number().int().min(0).max(23), close: z.number().int().min(1).max(24) });

export class PgReportRepository implements ReportRepository {
  constructor(private readonly sql: Sql) {}

  async monthlyRaw({ tenantId, from, to, timeZone }: ReportRange): Promise<MonthlyRawData> {
    const sql = this.sql;
    const runsInRange = sql`r.tenant_id = ${tenantId} and r.created_at >= ${from} and r.created_at < ${to} and r.outcome <> 'skipped'`;

    const [conv] = await sql<{ total: number; without_handoff: number }[]>`
      select count(distinct r.conversation_id)::int as total,
             count(distinct r.conversation_id) filter (
               where not exists (
                 select 1 from handoffs h
                 where h.tenant_id = ${tenantId} and h.conversation_id = r.conversation_id
                   and h.created_at >= ${from} and h.created_at < ${to}
               )
             )::int as without_handoff
      from agent_runs r where ${runsInRange}
    `;

    const reasons = await sql<{ reason: string; count: number }[]>`
      select reason, count(*)::int as count from handoffs
      where tenant_id = ${tenantId} and created_at >= ${from} and created_at < ${to}
      group by reason
    `;

    const [appts] = await sql<{ scheduled: number; completed: number; no_show: number; cancelled: number }[]>`
      select count(*) filter (where status <> 'cancelado')::int as scheduled,
             count(*) filter (where status = 'concluido')::int as completed,
             count(*) filter (where status = 'faltou')::int as no_show,
             count(*) filter (where status = 'cancelado')::int as cancelled
      from appointments
      where tenant_id = ${tenantId} and starts_at >= ${from} and starts_at < ${to}
    `;

    const topServices = await sql<{ name: string; count: number }[]>`
      select sv.name, count(*)::int as count
      from appointments a join salon_services sv on sv.id = a.service_id
      where a.tenant_id = ${tenantId} and a.starts_at >= ${from} and a.starts_at < ${to}
        and a.status <> 'cancelado'
      group by sv.id, sv.name
      order by count desc, sv.name
      limit 5
    `;

    const hours = await sql<{ hour: number; count: number }[]>`
      select extract(hour from first_at at time zone ${timeZone})::int as hour, count(*)::int as count
      from (
        select r.conversation_id, min(r.created_at) as first_at
        from agent_runs r where ${runsInRange}
        group by r.conversation_id
      ) c
      group by 1
    `;
    const conversationsByHour = Array.from({ length: 24 }, () => 0);
    for (const h of hours) conversationsByHour[h.hour] = h.count;

    const [ai] = await sql<{ cost: string | null; median: number | null }[]>`
      select sum(cost_usd)::text as cost,
             percentile_cont(0.5) within group (order by latency_ms)
               filter (where outcome in ('reply', 'handoff_tool')) as median
      from agent_runs r where ${runsInRange}
    `;

    const [tenant] = await sql<{ reception_hours: unknown }[]>`select reception_hours from tenants where id = ${tenantId}`;
    const reception = ReceptionHours.safeParse(tenant?.reception_hours);

    return {
      conversations: conv?.total ?? 0,
      conversationsWithoutHandoff: conv?.without_handoff ?? 0,
      handoffReasons: reasons.map((r) => ({ reason: r.reason, count: r.count })),
      appointments: {
        scheduled: appts?.scheduled ?? 0,
        completed: appts?.completed ?? 0,
        noShow: appts?.no_show ?? 0,
        cancelled: appts?.cancelled ?? 0,
      },
      topServices: topServices.map((t) => ({ name: t.name, count: t.count })),
      conversationsByHour,
      aiCostUsd: ai?.cost === null || ai?.cost === undefined ? null : Number(ai.cost),
      medianLatencyMs: ai?.median === null || ai?.median === undefined ? null : Math.round(Number(ai.median)),
      receptionHours: reception.success && reception.data.open < reception.data.close ? reception.data : null,
    };
  }
}

export class PgUnansweredQuestionRepository implements UnansweredQuestionRepository {
  constructor(private readonly sql: Sql) {}

  async list(tenantId: number, from: Date, to: Date, limit: number): Promise<UnansweredQuestion[]> {
    const rows = await this.sql<
      { id: string; question: string; conversation_id: string; created_at: Date; question_resolved_at: Date | null }[]
    >`
      select id, question, conversation_id, created_at, question_resolved_at from handoffs
      where tenant_id = ${tenantId} and question is not null
        and created_at >= ${from} and created_at < ${to}
      order by created_at desc
      limit ${limit}
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      question: r.question,
      conversationId: Number(r.conversation_id),
      createdAt: r.created_at,
      resolvedAt: r.question_resolved_at,
    }));
  }

  async setResolved(tenantId: number, id: number, resolved: boolean, now: Date): Promise<boolean> {
    const rows = await this.sql`
      update handoffs set question_resolved_at = ${resolved ? now : null}
      where id = ${id} and tenant_id = ${tenantId} and question is not null
      returning id
    `;
    return rows.length > 0;
  }
}
