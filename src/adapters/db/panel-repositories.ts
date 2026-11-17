import { z } from 'zod';
import type {
  LeadAdminRepository,
  LeadListItem,
  LeadQuery,
  LeadStatus,
  UpdateLeadStatusResult,
} from '../../modules/leads/ports.js';
import { LEAD_STATUSES } from '../../modules/leads/ports.js';
import type { UnansweredQuestion, UnansweredQuestionRepository } from '../../modules/handoff/ports.js';
import type { MonthlyRawData, ReportRange, ReportRepository } from '../../modules/reports/ports.js';
import type { Attendance, BookingAdminRepository, PanelBooking } from '../../modules/trial-classes/ports.js';
import type { Sql } from './client.js';

interface LeadRow {
  id: string;
  name: string | null;
  phone: string;
  goal: string | null;
  modality: string | null;
  status: LeadStatus;
  version: number;
  chatwoot_contact_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Escapa curingas do LIKE para a busca tratar o texto literalmente. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PgLeadAdminRepository implements LeadAdminRepository {
  constructor(private readonly sql: Sql) {}

  async list(
    tenantId: number,
    q: LeadQuery,
  ): Promise<{ items: LeadListItem[]; counts: Record<LeadStatus, number> }> {
    const search = q.search?.trim();
    const digits = search?.replace(/\D/g, '') ?? '';
    const searchFilter = search
      ? this.sql`and (l.name ilike ${'%' + likeEscape(search) + '%'} ${
          digits.length >= 3 ? this.sql`or regexp_replace(l.phone, '\\D', '', 'g') like ${'%' + digits + '%'}` : this.sql``
        })`
      : this.sql``;
    const period = this.sql`l.tenant_id = ${tenantId} and l.updated_at >= ${q.from} and l.updated_at < ${q.to}`;

    const rows = await this.sql<LeadRow[]>`
      select l.id, l.name, l.phone, l.goal, l.modality, l.status, l.version, l.chatwoot_contact_id, l.created_at, l.updated_at
      from leads l
      where ${period} ${q.status ? this.sql`and l.status = ${q.status}` : this.sql``} ${searchFilter}
      order by l.updated_at desc
      limit ${q.limit}
    `;
    const countRows = await this.sql<{ status: LeadStatus; n: number }[]>`
      select l.status, count(*)::int as n from leads l where ${period} ${searchFilter} group by l.status
    `;
    const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
    for (const r of countRows) counts[r.status] = r.n;

    return {
      items: rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        phone: r.phone,
        goal: r.goal,
        modality: r.modality,
        status: r.status,
        version: r.version,
        chatwootContactId: r.chatwoot_contact_id === null ? null : Number(r.chatwoot_contact_id),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      counts,
    };
  }

  async updateStatus(
    tenantId: number,
    id: number,
    status: LeadStatus,
    expectedVersion: number,
  ): Promise<UpdateLeadStatusResult> {
    const [row] = await this.sql<{ version: number }[]>`
      update leads set
        status = ${status},
        version = version + 1,
        updated_at = now(),
        enrolled_at = case
          when ${status} = 'matriculado' then coalesce(enrolled_at, now())
          else null
        end
      where id = ${id} and tenant_id = ${tenantId} and version = ${expectedVersion}
      returning version
    `;
    if (row) return { kind: 'ok', version: row.version };
    const [current] = await this.sql<{ version: number }[]>`
      select version from leads where id = ${id} and tenant_id = ${tenantId}
    `;
    return current ? { kind: 'conflict', currentVersion: current.version } : { kind: 'not_found' };
  }
}

export class PgBookingAdminRepository implements BookingAdminRepository {
  constructor(private readonly sql: Sql) {}

  async list(tenantId: number, from: Date, to: Date): Promise<PanelBooking[]> {
    const rows = await this.sql<
      {
        id: string;
        status: PanelBooking['status'];
        starts_at: Date;
        modality: string;
        lead_id: string;
        name: string | null;
        phone: string;
        goal: string | null;
        reminder_sent_at: Date | null;
        reminder_job_id: string | null;
        chatwoot_conversation_id: string | null;
      }[]
    >`
      select b.id, b.status, s.starts_at, s.modality, l.id as lead_id, l.name, l.phone, l.goal,
             b.reminder_sent_at, b.reminder_job_id, b.chatwoot_conversation_id
      from trial_bookings b
      join trial_slots s on s.id = b.slot_id
      join leads l on l.id = b.lead_id
      where s.tenant_id = ${tenantId} and s.starts_at >= ${from} and s.starts_at < ${to}
        and b.status <> 'cancelada'
      order by s.starts_at, l.name
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      status: r.status,
      startsAt: r.starts_at,
      modality: r.modality,
      leadId: Number(r.lead_id),
      leadName: r.name,
      leadPhone: r.phone,
      leadGoal: r.goal,
      reminderSentAt: r.reminder_sent_at,
      reminderScheduled: r.reminder_job_id !== null && r.reminder_sent_at === null,
      chatwootConversationId: r.chatwoot_conversation_id === null ? null : Number(r.chatwoot_conversation_id),
    }));
  }

  async markAttendance(
    tenantId: number,
    id: number,
    status: Attendance,
    now: Date,
  ): Promise<'ok' | 'not_found' | 'not_started'> {
    const updated = await this.sql`
      update trial_bookings b set status = ${status}
      from trial_slots s
      where b.id = ${id} and s.id = b.slot_id and s.tenant_id = ${tenantId}
        and b.status <> 'cancelada' and s.starts_at <= ${now}
      returning b.id
    `;
    if (updated.length) return 'ok';
    const exists = await this.sql`
      select 1 from trial_bookings b join trial_slots s on s.id = b.slot_id
      where b.id = ${id} and s.tenant_id = ${tenantId} and b.status <> 'cancelada'
    `;
    return exists.length ? 'not_started' : 'not_found';
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

    const [leads] = await sql<{ interested: number; enrollments: number }[]>`
      select
        count(*) filter (where created_at >= ${from} and created_at < ${to}
                           and (goal is not null or modality is not null))::int as interested,
        count(*) filter (where enrolled_at >= ${from} and enrolled_at < ${to})::int as enrollments
      from leads where tenant_id = ${tenantId}
    `;

    const [trials] = await sql<{ total: number; attended: number }[]>`
      select count(*)::int as total, count(*) filter (where b.status = 'compareceu')::int as attended
      from trial_bookings b join trial_slots s on s.id = b.slot_id
      where s.tenant_id = ${tenantId} and s.starts_at >= ${from} and s.starts_at < ${to}
        and b.status <> 'cancelada'
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
      interestedLeads: leads?.interested ?? 0,
      trialClasses: trials?.total ?? 0,
      attended: trials?.attended ?? 0,
      enrollments: leads?.enrollments ?? 0,
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
