import type {
  ClientDelayReport,
  ClientDelayRepository,
  DelayNoticeInfo,
  DelayNoticeRepository,
  DelayNoticeSummary,
} from '../../modules/appointments/ports.js';
import type { Sql } from './client.js';

const UNIQUE_VIOLATION = '23505';

export class PgDelayNoticeRepository implements DelayNoticeRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: { tenantId: number; appointmentId: number; delayMin: number; originalStartsAt: Date }): Promise<number | null> {
    try {
      const [r] = await this.sql<{ id: string }[]>`
        insert into delay_notices (tenant_id, appointment_id, delay_min, original_starts_at)
        values (${input.tenantId}, ${input.appointmentId}, ${input.delayMin}, ${input.originalStartsAt})
        returning id
      `;
      return Number(r!.id);
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === UNIQUE_VIOLATION) return null;
      throw e;
    }
  }

  async remove(id: number): Promise<void> {
    await this.sql`delete from delay_notices where id = ${id}`;
  }

  async getForSend(id: number): Promise<DelayNoticeInfo | null> {
    const [r] = await this.sql<
      {
        id: string; appointment_id: string; delay_min: number; original_starts_at: Date; sent_at: Date | null;
        response: 'chegara_depois' | null; status: DelayNoticeInfo['appointmentStatus']; opted_out_at: Date | null;
        chatwoot_account_id: string | null; chatwoot_conversation_id: string | null; name: string | null;
        service_name: string; time_zone: string;
      }[]
    >`
      select n.id, n.appointment_id, n.delay_min, n.original_starts_at, n.sent_at, n.response, a.status,
             l.opted_out_at, a.chatwoot_account_id, a.chatwoot_conversation_id, l.name,
             sv.name as service_name, t.time_zone
      from delay_notices n
      join appointments a on a.id = n.appointment_id
      join leads l on l.id = a.lead_id
      join salon_services sv on sv.id = a.service_id
      join tenants t on t.id = n.tenant_id
      where n.id = ${id}
    `;
    if (!r) return null;
    return {
      id: Number(r.id),
      appointmentId: Number(r.appointment_id),
      delayMin: r.delay_min,
      originalStartsAt: r.original_starts_at,
      sentAt: r.sent_at,
      response: r.response,
      appointmentStatus: r.status,
      optedOut: r.opted_out_at !== null,
      accountId: r.chatwoot_account_id === null ? null : Number(r.chatwoot_account_id),
      conversationId: r.chatwoot_conversation_id === null ? null : Number(r.chatwoot_conversation_id),
      leadName: r.name,
      serviceName: r.service_name,
      timeZone: r.time_zone,
    };
  }

  async markSent(id: number): Promise<boolean> {
    const rows = await this.sql`update delay_notices set sent_at = now() where id = ${id} and sent_at is null returning id`;
    return rows.length === 1;
  }

  async clearSent(id: number): Promise<void> {
    await this.sql`update delay_notices set sent_at = null where id = ${id} and response is null`;
  }

  async latestSent(appointmentIds: number[]): Promise<DelayNoticeSummary[]> {
    if (!appointmentIds.length) return [];
    const rows = await this.sql<
      { appointment_id: string; delay_min: number; original_starts_at: Date; sent_at: Date; response: 'chegara_depois' | null }[]
    >`
      select distinct on (appointment_id) appointment_id, delay_min, original_starts_at, sent_at, response
      from delay_notices
      where appointment_id in ${this.sql(appointmentIds)} and sent_at is not null
      order by appointment_id, id desc
    `;
    return rows.map((r) => ({
      appointmentId: Number(r.appointment_id),
      delayMin: r.delay_min,
      originalStartsAt: r.original_starts_at,
      sentAt: r.sent_at,
      response: r.response,
    }));
  }

  async confirmLatest(appointmentId: number): Promise<boolean> {
    const rows = await this.sql`
      update delay_notices set response = 'chegara_depois', responded_at = now()
      where id = (select id from delay_notices where appointment_id = ${appointmentId} and sent_at is not null order by id desc limit 1)
        and response is null
      returning id
    `;
    return rows.length === 1;
  }
}

export class PgClientDelayRepository implements ClientDelayRepository {
  constructor(private readonly sql: Sql) {}

  async record(tenantId: number, appointmentId: number, delayMin: number, now: Date): Promise<boolean> {
    const rows = await this.sql`
      insert into client_delay_reports (tenant_id, appointment_id, delay_min, created_at)
      values (${tenantId}, ${appointmentId}, ${delayMin}, ${now})
      on conflict on constraint client_delay_reports_once do nothing
      returning id
    `;
    return rows.length === 1;
  }

  async latest(appointmentIds: number[]): Promise<ClientDelayReport[]> {
    if (!appointmentIds.length) return [];
    const rows = await this.sql<{ appointment_id: string; delay_min: number; created_at: Date }[]>`
      select distinct on (appointment_id) appointment_id, delay_min, created_at
      from client_delay_reports
      where appointment_id in ${this.sql(appointmentIds)}
      order by appointment_id, id desc
    `;
    return rows.map((r) => ({ appointmentId: Number(r.appointment_id), delayMin: r.delay_min, reportedAt: r.created_at }));
  }
}
