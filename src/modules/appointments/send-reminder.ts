import { formatLocal } from '../../shared/time-zone.js';
import type { AppointmentRepository, ReminderSender } from './ports.js';

export type ReminderOutcome =
  | 'sent'
  | 'skipped_inactive'
  | 'skipped_already_sent'
  | 'skipped_no_conversation'
  | 'skipped_opted_out';

/** Use case do job de lembrete. Idempotente: confere o agendamento e marca o envio. */
export async function sendAppointmentReminder(
  deps: { appointments: Pick<AppointmentRepository, 'getForReminder' | 'markReminderSent' | 'clearReminderSent'>; sender: ReminderSender; now: () => Date },
  appointmentId: number,
): Promise<ReminderOutcome> {
  const info = await deps.appointments.getForReminder(appointmentId);
  if (!info || info.status !== 'agendado' || info.startsAt.getTime() <= deps.now().getTime()) return 'skipped_inactive';
  if (info.reminderSentAt) return 'skipped_already_sent';
  if (info.optedOut) return 'skipped_opted_out';
  if (!info.accountId || !info.conversationId) return 'skipped_no_conversation';

  // Marca antes de enviar (dois jobs simultâneos não mandam em dobro); se o envio falhar,
  // desmarca para a retentativa da fila conseguir mandar.
  if (!(await deps.appointments.markReminderSent(appointmentId))) return 'skipped_already_sent';
  try {
    await deps.sender.sendAppointmentReminder(info.accountId, info.conversationId, {
      name: info.leadName?.trim().split(/\s+/)[0] || 'tudo bem',
      service: info.serviceName,
      professional: info.professionalName,
      when: formatLocal(info.startsAt, info.timeZone),
    });
  } catch (err) {
    await deps.appointments.clearReminderSent(appointmentId);
    throw err;
  }
  return 'sent';
}
