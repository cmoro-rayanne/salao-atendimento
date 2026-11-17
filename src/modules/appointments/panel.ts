import { scheduleReminder, type AgendaDeps } from './agenda.js';
import { computeFreeSlots } from './availability.js';
import { parseLocalDay } from './local-time.js';
import type { AgendaAdminRepository } from './admin-ports.js';
import type { BookResult, RescheduleResult } from './ports.js';

export interface PanelAgendaDeps {
  agenda: AgendaDeps;
  admin: AgendaAdminRepository;
}

/** Só dígitos com DDI; aceita "(41) 99999-0000" e "+55 41 99999-0000". Devolve null se não parecer telefone. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  // Com "+", o DDI foi digitado e precisa ser 55; sem ele, assume Brasil.
  const full = !raw.trim().startsWith('+') && (digits.length === 10 || digits.length === 11) ? `55${digits}` : digits;
  return /^55\d{10,11}$/.test(full) ? `+${full}` : null;
}

/** Command: a recepção marca um horário pelo painel (sem conversa do WhatsApp). */
export async function panelBook(
  deps: PanelAgendaDeps,
  input: { tenantId: number; serviceId: number; professionalId: number; startsAt: Date; phone: string; name: string | null; timeZone: string },
): Promise<BookResult | { kind: 'invalid_phone' }> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { kind: 'invalid_phone' };
  const result = await deps.agenda.appointments.book({
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    professionalId: input.professionalId,
    startsAt: input.startsAt,
    contact: { phone, chatwootContactId: null, name: input.name },
    conversation: null,
    source: 'painel',
    now: deps.agenda.now(),
  });
  // Sem conversa do WhatsApp o lembrete é descartado no envio; o job só existe para manter o fluxo único.
  if (result.kind === 'booked') await scheduleReminder(deps.agenda, result.appointment, input.timeZone);
  return result;
}

/** Command: muda horário e/ou profissional de um agendamento pelo painel. */
export async function panelReschedule(
  deps: PanelAgendaDeps,
  input: { tenantId: number; id: number; startsAt: Date; professionalId?: number | undefined; timeZone: string },
): Promise<RescheduleResult> {
  const owner = await deps.admin.getPhone(input.tenantId, input.id);
  if (!owner) return { kind: 'not_found' };
  const result = await deps.agenda.appointments.reschedule({
    tenantId: input.tenantId,
    appointmentId: input.id,
    phone: owner.phone,
    startsAt: input.startsAt,
    ...(input.professionalId ? { professionalId: input.professionalId } : {}),
    now: deps.agenda.now(),
  });
  if (result.kind === 'rescheduled') {
    if (result.reminderJobId) await deps.agenda.reminders.cancel(result.reminderJobId);
    await scheduleReminder(deps.agenda, result.appointment, input.timeZone);
  }
  return result;
}

/** Command: cancela pelo painel e remove o lembrete. */
export async function panelCancel(deps: PanelAgendaDeps, tenantId: number, id: number): Promise<'ok' | 'not_found'> {
  const owner = await deps.admin.getPhone(tenantId, id);
  if (!owner) return 'not_found';
  const result = await deps.agenda.appointments.cancel(tenantId, id, owner.phone, deps.agenda.now());
  if (result.kind === 'not_found') return 'not_found';
  if (result.reminderJobId) await deps.agenda.reminders.cancel(result.reminderJobId);
  return 'ok';
}

export interface PanelSlot {
  startsAt: string;
  professionalId: number;
  professionalName: string;
}

/** Query: horários livres de um serviço num dia, por profissional (para a recepção escolher ao agendar/remarcar). */
export async function panelFreeSlots(
  deps: AgendaDeps,
  input: { tenantId: number; serviceId: number; day: string; professionalId?: number | undefined},
): Promise<{ slots: PanelSlot[] } | { error: 'service' | 'day' }> {
  const service = await deps.catalog.getService(input.tenantId, input.serviceId);
  if (!service) return { error: 'service' };
  const settings = await deps.catalog.settings(input.tenantId);
  const day = parseLocalDay(input.day, settings.timeZone);
  if (!day) return { error: 'day' };

  const eligible = (await deps.catalog.listProfessionals(input.tenantId, input.serviceId)).filter(
    (p) => !input.professionalId || p.id === input.professionalId,
  );
  if (!eligible.length) return { slots: [] };
  const schedules = await deps.catalog.loadSchedules(input.tenantId, eligible.map((p) => p.id), day.from, day.to);
  const free = computeFreeSlots({
    schedules,
    durationMin: service.durationMin,
    stepMin: settings.slotStepMin,
    from: day.from,
    to: day.to,
    now: deps.now(),
    minNoticeMin: settings.minNoticeMin,
    maxDaysAhead: settings.maxDaysAhead,
    timeZone: settings.timeZone,
  });
  const names = new Map(eligible.map((p) => [p.id, p.name]));
  return {
    slots: free.map((s) => ({ startsAt: s.startsAt.toISOString(), professionalId: s.professionalId, professionalName: names.get(s.professionalId)! })),
  };
}
