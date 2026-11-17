import type {
  AdminProfessional,
  AdminService,
  AgendaAdminRepository,
  AppointmentStatus,
  HoursBlock,
  PanelAppointment,
  ProfessionalInput,
  ServiceInput,
  TimeOff,
} from '../../modules/appointments/admin-ports.js';
import type { Sql } from './client.js';

const EXCLUSION_VIOLATION = '23P01';

export class PgAgendaAdminRepository implements AgendaAdminRepository {
  constructor(private readonly sql: Sql) {}

  async listServices(tenantId: number): Promise<AdminService[]> {
    const rows = await this.sql<
      { id: string; name: string; description: string | null; duration_min: number; price_cents: number | null; active: boolean }[]
    >`
      select id, name, description, duration_min, price_cents, active from salon_services
      where tenant_id = ${tenantId} order by active desc, name
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      description: r.description,
      durationMin: r.duration_min,
      priceCents: r.price_cents,
      active: r.active,
    }));
  }

  async createService(tenantId: number, i: ServiceInput): Promise<AdminService> {
    const [r] = await this.sql<{ id: string }[]>`
      insert into salon_services (tenant_id, name, description, duration_min, price_cents, active)
      values (${tenantId}, ${i.name}, ${i.description}, ${i.durationMin}, ${i.priceCents}, ${i.active})
      returning id
    `;
    return { id: Number(r!.id), ...i };
  }

  async updateService(tenantId: number, id: number, i: ServiceInput): Promise<'ok' | 'not_found'> {
    const rows = await this.sql`
      update salon_services set name = ${i.name}, description = ${i.description}, duration_min = ${i.durationMin},
        price_cents = ${i.priceCents}, active = ${i.active}
      where id = ${id} and tenant_id = ${tenantId} returning id
    `;
    return rows.length ? 'ok' : 'not_found';
  }

  async listProfessionals(tenantId: number): Promise<AdminProfessional[]> {
    const profs = await this.sql<{ id: string; name: string; active: boolean }[]>`
      select id, name, active from professionals where tenant_id = ${tenantId} order by active desc, name
    `;
    if (!profs.length) return [];
    const ids = profs.map((p) => Number(p.id));
    const links = await this.sql<{ professional_id: string; service_id: string }[]>`
      select professional_id, service_id from professional_services where professional_id in ${this.sql(ids)}
    `;
    const hours = await this.sql<{ professional_id: string; weekday: number; start_min: number; end_min: number }[]>`
      select professional_id, weekday, start_min, end_min from working_hours
      where professional_id in ${this.sql(ids)} order by weekday, start_min
    `;
    const off = await this.sql<{ id: string; professional_id: string; starts_at: Date; ends_at: Date; reason: string | null }[]>`
      select id, professional_id, starts_at, ends_at, reason from time_off
      where professional_id in ${this.sql(ids)} and ends_at > now() order by starts_at
    `;
    return profs.map((p) => {
      const id = Number(p.id);
      return {
        id,
        name: p.name,
        active: p.active,
        serviceIds: links.filter((l) => Number(l.professional_id) === id).map((l) => Number(l.service_id)),
        hours: hours
          .filter((h) => Number(h.professional_id) === id)
          .map((h): HoursBlock => ({ weekday: h.weekday, startMin: h.start_min, endMin: h.end_min })),
        timeOff: off
          .filter((o) => Number(o.professional_id) === id)
          .map((o): TimeOff => ({ id: Number(o.id), startsAt: o.starts_at, endsAt: o.ends_at, reason: o.reason })),
      };
    });
  }

  private async servicesBelong(tx: Sql, tenantId: number, serviceIds: number[]): Promise<boolean> {
    if (!serviceIds.length) return true;
    const [r] = await tx<{ n: number }[]>`
      select count(*)::int as n from salon_services where tenant_id = ${tenantId} and id in ${tx(serviceIds)}
    `;
    return r?.n === new Set(serviceIds).size;
  }

  private async writeLinks(tx: Sql, id: number, i: ProfessionalInput): Promise<void> {
    await tx`delete from professional_services where professional_id = ${id}`;
    for (const serviceId of new Set(i.serviceIds)) {
      await tx`insert into professional_services (professional_id, service_id) values (${id}, ${serviceId})`;
    }
    await tx`delete from working_hours where professional_id = ${id}`;
    for (const h of i.hours) {
      await tx`insert into working_hours (professional_id, weekday, start_min, end_min) values (${id}, ${h.weekday}, ${h.startMin}, ${h.endMin})`;
    }
  }

  async createProfessional(tenantId: number, i: ProfessionalInput): Promise<number | 'invalid_services'> {
    return this.sql.begin(async (tx) => {
      if (!(await this.servicesBelong(tx as unknown as Sql, tenantId, i.serviceIds))) return 'invalid_services' as const;
      const [r] = await tx<{ id: string }[]>`
        insert into professionals (tenant_id, name, active) values (${tenantId}, ${i.name}, ${i.active}) returning id
      `;
      const id = Number(r!.id);
      await this.writeLinks(tx as unknown as Sql, id, i);
      return id;
    });
  }

  async updateProfessional(tenantId: number, id: number, i: ProfessionalInput): Promise<'ok' | 'not_found' | 'invalid_services'> {
    return this.sql.begin(async (tx) => {
      const [own] = await tx`select 1 from professionals where id = ${id} and tenant_id = ${tenantId} for update`;
      if (!own) return 'not_found' as const;
      if (!(await this.servicesBelong(tx as unknown as Sql, tenantId, i.serviceIds))) return 'invalid_services' as const;
      await tx`update professionals set name = ${i.name}, active = ${i.active} where id = ${id}`;
      await this.writeLinks(tx as unknown as Sql, id, i);
      return 'ok' as const;
    });
  }

  async addTimeOff(tenantId: number, professionalId: number, startsAt: Date, endsAt: Date, reason: string | null): Promise<number | 'not_found'> {
    const [own] = await this.sql`select 1 from professionals where id = ${professionalId} and tenant_id = ${tenantId}`;
    if (!own) return 'not_found';
    const [r] = await this.sql<{ id: string }[]>`
      insert into time_off (professional_id, starts_at, ends_at, reason) values (${professionalId}, ${startsAt}, ${endsAt}, ${reason}) returning id
    `;
    return Number(r!.id);
  }

  async removeTimeOff(tenantId: number, professionalId: number, timeOffId: number): Promise<'ok' | 'not_found'> {
    const rows = await this.sql`
      delete from time_off t using professionals p
      where t.id = ${timeOffId} and t.professional_id = ${professionalId} and p.id = t.professional_id and p.tenant_id = ${tenantId}
      returning t.id
    `;
    return rows.length ? 'ok' : 'not_found';
  }

  async countActiveInRange(tenantId: number, professionalId: number, from: Date, to: Date): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from appointments
      where tenant_id = ${tenantId} and professional_id = ${professionalId} and status = 'agendado'
        and starts_at < ${to} and ends_at > ${from}
    `;
    return r?.n ?? 0;
  }

  async listAppointments(tenantId: number, from: Date, to: Date): Promise<PanelAppointment[]> {
    const rows = await this.sql<
      {
        id: string; service_id: string; service_name: string; professional_id: string; professional_name: string;
        starts_at: Date; ends_at: Date; status: AppointmentStatus; source: 'ia' | 'painel';
        client_name: string | null; client_phone: string; reminder_sent_at: Date | null; chatwoot_conversation_id: string | null;
      }[]
    >`
      select a.id, a.service_id, sv.name as service_name, a.professional_id, p.name as professional_name,
             a.starts_at, a.ends_at, a.status, a.source, l.name as client_name, l.phone as client_phone,
             a.reminder_sent_at, a.chatwoot_conversation_id
      from appointments a
      join salon_services sv on sv.id = a.service_id
      join professionals p on p.id = a.professional_id
      join leads l on l.id = a.lead_id
      where a.tenant_id = ${tenantId} and a.starts_at >= ${from} and a.starts_at < ${to}
      order by a.starts_at, p.name
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      serviceId: Number(r.service_id),
      serviceName: r.service_name,
      professionalId: Number(r.professional_id),
      professionalName: r.professional_name,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      source: r.source,
      clientName: r.client_name,
      clientPhone: r.client_phone,
      reminderSentAt: r.reminder_sent_at,
      chatwootConversationId: r.chatwoot_conversation_id === null ? null : Number(r.chatwoot_conversation_id),
    }));
  }

  async markStatus(
    tenantId: number,
    id: number,
    status: 'concluido' | 'faltou' | 'agendado',
    now: Date,
  ): Promise<'ok' | 'not_found' | 'not_started' | 'cancelled' | 'busy'> {
    try {
      return await this.sql.begin(async (tx) => {
        const [cur] = await tx<{ status: AppointmentStatus; starts_at: Date }[]>`
          select status, starts_at from appointments where id = ${id} and tenant_id = ${tenantId} for update
        `;
        if (!cur) return 'not_found' as const;
        if (cur.status === 'cancelado') return 'cancelled' as const;
        if (status !== 'agendado' && cur.starts_at > now) return 'not_started' as const;
        // Reabrir devolve o horário à agenda; o banco recusa se outra pessoa já ocupou.
        await tx`update appointments set status = ${status}, version = version + 1 where id = ${id}`;
        return 'ok' as const;
      });
    } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: string }).code === EXCLUSION_VIOLATION) return 'busy';
      throw e;
    }
  }

  async getPhone(tenantId: number, id: number): Promise<{ phone: string } | null> {
    const [r] = await this.sql<{ phone: string }[]>`
      select l.phone from appointments a join leads l on l.id = a.lead_id where a.id = ${id} and a.tenant_id = ${tenantId}
    `;
    return r ? { phone: r.phone } : null;
  }
}
