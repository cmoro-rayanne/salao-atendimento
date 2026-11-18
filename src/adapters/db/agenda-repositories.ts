import type {
  AgendaSettings,
  Appointment,
  AppointmentRepository,
  BookRequest,
  BookResult,
  CancelResult,
  CatalogRepository,
  Professional,
  ReminderInfo,
  RescheduleRequest,
  RescheduleResult,
  SalonService,
} from '../../modules/appointments/ports.js';
import type { ProfessionalSchedule } from '../../modules/appointments/availability.js';
import { asSql, type Sql } from './client.js';
import { loadSchedules, slotFitsSchedule, toAppointment, type AppointmentRow } from './agenda-queries.js';

const MINUTE = 60 * 1000;
const EXCLUSION_VIOLATION = '23P01';

const isOverlap = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: string }).code === EXCLUSION_VIOLATION;

interface ServiceRow {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_cents: number | null;
}

const toService = (r: ServiceRow): SalonService => ({
  id: Number(r.id),
  name: r.name,
  description: r.description,
  durationMin: r.duration_min,
  priceCents: r.price_cents,
});

export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly sql: Sql) {}

  async settings(tenantId: number): Promise<AgendaSettings> {
    const [t] = await this.sql<
      { time_zone: string; slot_step_min: number; min_notice_min: number; max_days_ahead: number; late_tolerance_min: number }[]
    >`
      select time_zone, slot_step_min, min_notice_min, max_days_ahead, late_tolerance_min from tenants where id = ${tenantId}
    `;
    if (!t) throw new Error(`tenant ${tenantId} não existe`);
    return { timeZone: t.time_zone, slotStepMin: t.slot_step_min, minNoticeMin: t.min_notice_min, maxDaysAhead: t.max_days_ahead,
      lateToleranceMin: t.late_tolerance_min,
    };
  }

  async listServices(tenantId: number): Promise<SalonService[]> {
    const rows = await this.sql<ServiceRow[]>`
      select id, name, description, duration_min, price_cents from salon_services
      where tenant_id = ${tenantId} and active order by name
    `;
    return rows.map(toService);
  }

  async getService(tenantId: number, serviceId: number): Promise<SalonService | null> {
    const [r] = await this.sql<ServiceRow[]>`
      select id, name, description, duration_min, price_cents from salon_services
      where tenant_id = ${tenantId} and id = ${serviceId} and active
    `;
    return r ? toService(r) : null;
  }

  async listProfessionals(tenantId: number, serviceId?: number): Promise<Professional[]> {
    const rows = await this.sql<{ id: string; name: string; service_ids: string[] | null }[]>`
      select p.id, p.name,
             array(select ps.service_id::text from professional_services ps where ps.professional_id = p.id order by 1) as service_ids
      from professionals p
      where p.tenant_id = ${tenantId} and p.active
        ${serviceId ? this.sql`and exists (select 1 from professional_services ps where ps.professional_id = p.id and ps.service_id = ${serviceId})` : this.sql``}
      order by p.name
    `;
    return rows.map((r) => ({ id: Number(r.id), name: r.name, serviceIds: (r.service_ids ?? []).map(Number) }));
  }

  async loadSchedules(tenantId: number, professionalIds: number[], from: Date, to: Date): Promise<ProfessionalSchedule[]> {
    // Só profissionais do próprio salão (a IA nunca vê agenda de outro tenant).
    const own = await this.sql<{ id: string }[]>`
      select id from professionals where tenant_id = ${tenantId} and active and id in ${this.sql(professionalIds.length ? professionalIds : [0])}
    `;
    return loadSchedules(this.sql, own.map((r) => Number(r.id)), from, to);
  }

  async dayLoads(tenantId: number, professionalIds: number[], from: Date, to: Date): Promise<Map<number, number>> {
    const rows = await this.sql<{ professional_id: string; n: string }[]>`
      select professional_id, count(*) as n from appointments
      where tenant_id = ${tenantId} and status = 'agendado' and starts_at >= ${from} and starts_at < ${to}
        and professional_id in ${this.sql(professionalIds.length ? professionalIds : [0])}
      group by professional_id
    `;
    return new Map(rows.map((r) => [Number(r.professional_id), Number(r.n)]));
  }
}

const APPT_SELECT = (sql: Sql) => sql`
  a.id, a.service_id, sv.name as service_name, a.professional_id, p.name as professional_name, a.starts_at, a.ends_at
`;

export class PgAppointmentRepository implements AppointmentRepository {
  constructor(private readonly sql: Sql) {}

  async book(req: BookRequest): Promise<BookResult> {
    try {
      return await this.sql.begin(async (tx): Promise<BookResult> => {
        // Trava a linha da cliente até o fim da transação: pedidos simultâneos da mesma pessoa entram em fila.
        const [lead] = await tx<{ id: string }[]>`
          insert into leads (tenant_id, phone, chatwoot_contact_id, name)
          values (${req.tenantId}, ${req.contact.phone}, ${req.contact.chatwootContactId}, ${req.contact.name})
          on conflict (tenant_id, phone) do update set
            chatwoot_contact_id = coalesce(excluded.chatwoot_contact_id, leads.chatwoot_contact_id),
            name = coalesce(leads.name, excluded.name),
            updated_at = now()
          returning id
        `;
        const leadId = lead!.id;

        const [service] = await tx<{ duration_min: number }[]>`
          select duration_min from salon_services where id = ${req.serviceId} and tenant_id = ${req.tenantId} and active
        `;
        const [doesIt] = await tx`
          select 1 from professionals p
          join professional_services ps on ps.professional_id = p.id
          where p.id = ${req.professionalId} and p.tenant_id = ${req.tenantId} and p.active and ps.service_id = ${req.serviceId}
        `;
        if (!service || !doesIt) return { kind: 'not_available' };

        const endsAt = new Date(req.startsAt.getTime() + service.duration_min * MINUTE);

        // Mesmo pedido repetido: devolve o agendamento que já existe.
        const [same] = await tx<AppointmentRow[]>`
          select ${APPT_SELECT(asSql(tx))} from appointments a
          join salon_services sv on sv.id = a.service_id join professionals p on p.id = a.professional_id
          where a.lead_id = ${leadId} and a.status = 'agendado' and a.professional_id = ${req.professionalId}
            and a.service_id = ${req.serviceId} and a.starts_at = ${req.startsAt}
        `;
        if (same) return { kind: 'already_booked', appointment: toAppointment(same) };

        // A cliente não pode estar em dois lugares ao mesmo tempo.
        const [clash] = await tx<AppointmentRow[]>`
          select ${APPT_SELECT(asSql(tx))} from appointments a
          join salon_services sv on sv.id = a.service_id join professionals p on p.id = a.professional_id
          where a.lead_id = ${leadId} and a.status = 'agendado' and a.starts_at < ${endsAt} and a.ends_at > ${req.startsAt}
          limit 1
        `;
        if (clash) return { kind: 'client_busy', appointment: toAppointment(clash) };

        // Expediente, folga, antecedência e janela: a mesma regra usada para listar os horários.
        if (!(await slotFitsSchedule(asSql(tx), req.tenantId, req.professionalId, service.duration_min, req.startsAt, req.now))) {
          return { kind: 'not_available' };
        }
        const [busyNow] = await tx`
          select 1 from appointments where professional_id = ${req.professionalId} and status = 'agendado'
            and starts_at < ${endsAt} and ends_at > ${req.startsAt}
        `;
        if (busyNow) return { kind: 'busy' };

        const [row] = await tx<{ id: string }[]>`
          insert into appointments (tenant_id, lead_id, professional_id, service_id, starts_at, ends_at, source,
                                    chatwoot_account_id, chatwoot_conversation_id)
          values (${req.tenantId}, ${leadId}, ${req.professionalId}, ${req.serviceId}, ${req.startsAt}, ${endsAt}, ${req.source},
                  ${req.conversation?.accountId ?? null}, ${req.conversation?.conversationId ?? null})
          returning id
        `;
        const [appt] = await tx<AppointmentRow[]>`
          select ${APPT_SELECT(asSql(tx))} from appointments a
          join salon_services sv on sv.id = a.service_id join professionals p on p.id = a.professional_id
          where a.id = ${row!.id}
        `;
        return { kind: 'booked', appointment: toAppointment(appt!) };
      });
    } catch (e) {
      // Duas clientes disputando o mesmo horário: o banco deixa passar uma só.
      if (isOverlap(e)) return { kind: 'busy' };
      throw e;
    }
  }

  async reschedule(req: RescheduleRequest): Promise<RescheduleResult> {
    try {
      return await this.sql.begin(async (tx): Promise<RescheduleResult> => {
        const [cur] = await tx<
          (AppointmentRow & { lead_id: string; duration_min: number; reminder_job_id: string | null })[]
        >`
          select ${APPT_SELECT(asSql(tx))}, a.lead_id, sv.duration_min, a.reminder_job_id
          from appointments a
          join salon_services sv on sv.id = a.service_id
          join professionals p on p.id = a.professional_id
          join leads l on l.id = a.lead_id
          where a.id = ${req.appointmentId} and a.tenant_id = ${req.tenantId} and l.phone = ${req.phone}
            and a.status = 'agendado' and a.starts_at > ${req.now}
          for update of a
        `;
        if (!cur) return { kind: 'not_found' };

        const professionalId = req.professionalId ?? Number(cur.professional_id);
        if (professionalId === Number(cur.professional_id) && req.startsAt.getTime() === cur.starts_at.getTime()) {
          return { kind: 'unchanged', appointment: toAppointment(cur) };
        }
        if (professionalId !== Number(cur.professional_id)) {
          const [doesIt] = await tx`
            select 1 from professionals p join professional_services ps on ps.professional_id = p.id
            where p.id = ${professionalId} and p.tenant_id = ${req.tenantId} and p.active and ps.service_id = ${cur.service_id}
          `;
          if (!doesIt) return { kind: 'not_available' };
        }

        const endsAt = new Date(req.startsAt.getTime() + cur.duration_min * MINUTE);
        const [clash] = await tx<AppointmentRow[]>`
          select ${APPT_SELECT(asSql(tx))} from appointments a
          join salon_services sv on sv.id = a.service_id join professionals p on p.id = a.professional_id
          where a.lead_id = ${cur.lead_id} and a.status = 'agendado' and a.id <> ${req.appointmentId}
            and a.starts_at < ${endsAt} and a.ends_at > ${req.startsAt}
          limit 1
        `;
        if (clash) return { kind: 'client_busy', appointment: toAppointment(clash) };

        const [taken] = await tx`
          select 1 from appointments where professional_id = ${professionalId} and status = 'agendado'
            and id <> ${req.appointmentId} and starts_at < ${endsAt} and ends_at > ${req.startsAt}
        `;
        if (!(await slotFitsSchedule(asSql(tx), req.tenantId, professionalId, cur.duration_min, req.startsAt, req.now))) {
          return { kind: 'not_available' };
        }
        if (taken) return { kind: 'busy' };

        await tx`
          update appointments set professional_id = ${professionalId}, starts_at = ${req.startsAt}, ends_at = ${endsAt},
            version = version + 1, reminder_sent_at = null, reminder_job_id = null
          where id = ${req.appointmentId}
        `;
        const [after] = await tx<AppointmentRow[]>`
          select ${APPT_SELECT(asSql(tx))} from appointments a
          join salon_services sv on sv.id = a.service_id join professionals p on p.id = a.professional_id
          where a.id = ${req.appointmentId}
        `;
        return { kind: 'rescheduled', appointment: toAppointment(after!), reminderJobId: cur.reminder_job_id };
      });
    } catch (e) {
      // O update falhou por sobreposição: a transação foi desfeita e o horário antigo continua valendo.
      if (isOverlap(e)) return { kind: 'busy' };
      throw e;
    }
  }

  async cancel(tenantId: number, appointmentId: number, phone: string, now: Date): Promise<CancelResult> {
    return this.sql.begin(async (tx): Promise<CancelResult> => {
      const [row] = await tx<(AppointmentRow & { reminder_job_id: string | null })[]>`
        select ${APPT_SELECT(asSql(tx))}, a.reminder_job_id
        from appointments a
        join salon_services sv on sv.id = a.service_id
        join professionals p on p.id = a.professional_id
        join leads l on l.id = a.lead_id
        where a.id = ${appointmentId} and a.tenant_id = ${tenantId} and l.phone = ${phone}
          and a.status = 'agendado' and a.starts_at > ${now}
        for update of a
      `;
      if (!row) return { kind: 'not_found' };
      await tx`update appointments set status = 'cancelado', cancelled_at = now(), version = version + 1 where id = ${appointmentId}`;
      return { kind: 'cancelled', appointment: toAppointment(row), reminderJobId: row.reminder_job_id };
    });
  }

  async listUpcoming(tenantId: number, phone: string, now: Date): Promise<Appointment[]> {
    const rows = await this.sql<AppointmentRow[]>`
      select ${APPT_SELECT(this.sql)} from appointments a
      join salon_services sv on sv.id = a.service_id
      join professionals p on p.id = a.professional_id
      join leads l on l.id = a.lead_id
      where a.tenant_id = ${tenantId} and l.phone = ${phone} and a.status = 'agendado' and a.starts_at > ${now}
      order by a.starts_at
    `;
    return rows.map(toAppointment);
  }

  async setReminderJob(appointmentId: number, jobId: string | null): Promise<void> {
    await this.sql`update appointments set reminder_job_id = ${jobId} where id = ${appointmentId}`;
  }

  async getForReminder(appointmentId: number): Promise<ReminderInfo | null> {
    const [r] = await this.sql<
      {
        id: string;
        status: ReminderInfo['status'];
        starts_at: Date;
        reminder_sent_at: Date | null;
        opted_out_at: Date | null;
        chatwoot_account_id: string | null;
        chatwoot_conversation_id: string | null;
        name: string | null;
        service_name: string;
        professional_name: string;
        time_zone: string;
      }[]
    >`
      select a.id, a.status, a.starts_at, a.reminder_sent_at, l.opted_out_at, a.chatwoot_account_id,
             a.chatwoot_conversation_id, l.name, sv.name as service_name, p.name as professional_name, t.time_zone
      from appointments a
      join leads l on l.id = a.lead_id
      join salon_services sv on sv.id = a.service_id
      join professionals p on p.id = a.professional_id
      join tenants t on t.id = a.tenant_id
      where a.id = ${appointmentId}
    `;
    if (!r) return null;
    return {
      appointmentId: Number(r.id),
      status: r.status,
      startsAt: r.starts_at,
      reminderSentAt: r.reminder_sent_at,
      optedOut: r.opted_out_at !== null,
      accountId: r.chatwoot_account_id === null ? null : Number(r.chatwoot_account_id),
      conversationId: r.chatwoot_conversation_id === null ? null : Number(r.chatwoot_conversation_id),
      leadName: r.name,
      serviceName: r.service_name,
      professionalName: r.professional_name,
      timeZone: r.time_zone,
    };
  }

  async markReminderSent(appointmentId: number): Promise<boolean> {
    const rows = await this.sql`
      update appointments set reminder_sent_at = now()
      where id = ${appointmentId} and reminder_sent_at is null
      returning id
    `;
    return rows.length === 1;
  }

  async clearReminderSent(appointmentId: number): Promise<void> {
    await this.sql`update appointments set reminder_sent_at = null where id = ${appointmentId}`;
  }
}
