import { computeFreeSlots, type Busy, type ProfessionalSchedule } from '../../modules/appointments/availability.js';
import type { Appointment } from '../../modules/appointments/ports.js';
import type { Sql } from './client.js';

/** Aceita o cliente normal ou uma transação (`sql.begin`, que também é um `Sql`). */
type Q = Sql;

const DAY = 24 * 60 * 60 * 1000;

export interface AppointmentRow {
  id: string;
  service_id: string;
  service_name: string;
  professional_id: string;
  professional_name: string;
  starts_at: Date;
  ends_at: Date;
}

export const toAppointment = (r: AppointmentRow): Appointment => ({
  id: Number(r.id),
  serviceId: Number(r.service_id),
  serviceName: r.service_name,
  professionalId: Number(r.professional_id),
  professionalName: r.professional_name,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
});

/** Expediente, folgas e agendamentos ativos que tocam [from - 1 dia, to + 1 dia]. `exceptAppointmentId` ignora um agendamento (remarcar). */
export async function loadSchedules(
  q: Q,
  professionalIds: number[],
  from: Date,
  to: Date,
  exceptAppointmentId?: number,
): Promise<ProfessionalSchedule[]> {
  if (!professionalIds.length) return [];
  const lo = new Date(from.getTime() - DAY);
  const hi = new Date(to.getTime() + DAY);

  const hours = await q<{ professional_id: string; weekday: number; start_min: number; end_min: number }[]>`
    select professional_id, weekday, start_min, end_min from working_hours where professional_id in ${q(professionalIds)}
  `;
  const off = await q<{ professional_id: string; starts_at: Date; ends_at: Date }[]>`
    select professional_id, starts_at, ends_at from time_off
    where professional_id in ${q(professionalIds)} and starts_at < ${hi} and ends_at > ${lo}
  `;
  const appts = await q<{ professional_id: string; starts_at: Date; ends_at: Date }[]>`
    select professional_id, starts_at, ends_at from appointments
    where professional_id in ${q(professionalIds)} and status = 'agendado' and starts_at < ${hi} and ends_at > ${lo}
      ${exceptAppointmentId ? q`and id <> ${exceptAppointmentId}` : q``}
  `;

  return professionalIds.map((id) => {
    const busy = (rows: { professional_id: string; starts_at: Date; ends_at: Date }[]): Busy[] =>
      rows.filter((r) => Number(r.professional_id) === id).map((r) => ({ startsAt: r.starts_at, endsAt: r.ends_at }));
    return {
      professionalId: id,
      hours: hours
        .filter((h) => Number(h.professional_id) === id)
        .map((h) => ({ weekday: h.weekday, startMin: h.start_min, endMin: h.end_min })),
      timeOff: busy(off),
      appointments: busy(appts),
    };
  });
}

/**
 * O horário pedido cabe no expediente da profissional (fora folga, antecedência e janela)?
 * Ignora agendamentos de propósito: ocupação é decidida pelo banco (restrição de sobreposição),
 * assim "horário ocupado" e "horário inexistente" nunca se confundem numa corrida.
 */
export async function slotFitsSchedule(
  q: Q,
  tenantId: number,
  professionalId: number,
  durationMin: number,
  startsAt: Date,
  now: Date,
): Promise<boolean> {
  const [t] = await q<{ time_zone: string; slot_step_min: number; min_notice_min: number; max_days_ahead: number }[]>`
    select time_zone, slot_step_min, min_notice_min, max_days_ahead from tenants where id = ${tenantId}
  `;
  if (!t) return false;
  const [schedule] = await loadSchedules(q, [professionalId], startsAt, startsAt);
  if (!schedule) return false;
  return computeFreeSlots({
    schedules: [{ ...schedule, appointments: [] }],
    durationMin,
    stepMin: t.slot_step_min,
    from: startsAt,
    to: new Date(startsAt.getTime() + 1),
    now,
    minNoticeMin: t.min_notice_min,
    maxDaysAhead: t.max_days_ahead,
    timeZone: t.time_zone,
  }).some((x) => x.startsAt.getTime() === startsAt.getTime());
}
