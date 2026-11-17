import { formatLocal } from '../../shared/time-zone.js';
import type { BookingRepository, ReminderSender } from './ports.js';

export type ReminderOutcome =
  | 'sent'
  | 'skipped_inactive'
  | 'skipped_already_sent'
  | 'skipped_no_conversation'
  | 'skipped_opted_out';

/** Use case do job de lembrete. Idempotente: confere a reserva e marca o envio. */
export async function sendTrialReminder(
  deps: { bookings: BookingRepository; sender: ReminderSender; now: () => Date },
  bookingId: number,
): Promise<ReminderOutcome> {
  const info = await deps.bookings.getForReminder(bookingId);
  if (!info || info.status !== 'agendada' || info.startsAt.getTime() <= deps.now().getTime()) return 'skipped_inactive';
  if (info.reminderSentAt) return 'skipped_already_sent';
  if (info.optedOut) return 'skipped_opted_out';
  if (!info.accountId || !info.conversationId) return 'skipped_no_conversation';

  // Marca antes de enviar (dois jobs simultâneos não mandam em dobro); se o envio falhar,
  // desmarca para a retentativa da fila conseguir mandar.
  if (!(await deps.bookings.markReminderSent(bookingId))) return 'skipped_already_sent';
  try {
    await deps.sender.sendTrialReminder(info.accountId, info.conversationId, {
      name: info.leadName?.trim().split(/\s+/)[0] || 'tudo bem',
      modality: info.modality,
      when: formatLocal(info.startsAt, info.timeZone),
    });
  } catch (err) {
    await deps.bookings.clearReminderSent(bookingId);
    throw err;
  }
  return 'sent';
}
