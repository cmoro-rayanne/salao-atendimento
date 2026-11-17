import type { ToolContext } from '../agent/ports.js';
import { formatLocal } from '../../shared/time-zone.js';
import type { BookedClass, BookingRepository, ReminderScheduler } from './ports.js';
import { reminderTime } from './reminder-time.js';

const DAY = 24 * 60 * 60 * 1000;
/** Antecedência mínima para agendar: a recepção precisa saber que a pessoa vem. */
export const MIN_LEAD_TIME_MS = 60 * 60 * 1000;
const LIST_WINDOW_DAYS = 7;
const MAX_LISTED = 15;

export interface BookingDeps {
  bookings: BookingRepository;
  reminders: ReminderScheduler;
  now: () => Date;
}

const describe = (b: BookedClass, tz: string) => `${b.modality}, ${formatLocal(b.startsAt, tz)}`;

/** Query: horários livres, em texto para a IA. */
export async function listAvailableSlots(deps: BookingDeps, ctx: ToolContext, modality?: string): Promise<string> {
  const now = deps.now();
  const from = new Date(now.getTime() + MIN_LEAD_TIME_MS);
  const to = new Date(now.getTime() + LIST_WINDOW_DAYS * DAY);
  const slots = (await deps.bookings.listAvailable(ctx.tenantId, from, to, modality?.trim() || undefined)).slice(
    0,
    MAX_LISTED,
  );

  if (!slots.length) {
    return modality
      ? `Não há horários livres de ${modality} nos próximos ${LIST_WINDOW_DAYS} dias. Ofereça outra modalidade ou transfira para a equipe.`
      : `Não há horários livres nos próximos ${LIST_WINDOW_DAYS} dias. Transfira para a equipe combinar um horário.`;
  }

  const lines = slots.map((s) => {
    const free = s.capacity - s.booked;
    return `horario_id ${s.id}: ${s.modality}, ${formatLocal(s.startsAt, ctx.timeZone)} (${free} ${free === 1 ? 'vaga' : 'vagas'})`;
  });
  return ['Horários livres (use o horario_id para agendar):', ...lines].join('\n');
}

/** Command: agenda a aula experimental do contato da conversa. */
export async function bookTrialClass(deps: BookingDeps, ctx: ToolContext, slotId: number): Promise<string> {
  if (!ctx.contact.phone) return 'Não foi possível agendar: o contato não tem telefone. Transfira para a equipe.';

  const now = deps.now();
  const result = await deps.bookings.book({
    tenantId: ctx.tenantId,
    slotId,
    contact: { phone: ctx.contact.phone, chatwootContactId: ctx.contact.chatwootContactId, name: ctx.contact.name },
    conversation: { accountId: ctx.accountId, conversationId: ctx.conversationId },
    notBefore: new Date(now.getTime() + MIN_LEAD_TIME_MS),
  });

  switch (result.kind) {
    case 'booked': {
      const at = reminderTime(result.booking.startsAt, ctx.timeZone, now);
      if (at) {
        const jobId = await deps.reminders.schedule(result.booking.bookingId, at);
        await deps.bookings.setReminderJob(result.booking.bookingId, jobId);
      }
      return `Agendado: ${describe(result.booking, ctx.timeZone)}. Confirme com a pessoa e lembre de chegar 10 minutos antes.`;
    }
    case 'already_booked':
      return `Essa aula já estava agendada para a pessoa: ${describe(result.booking, ctx.timeZone)}.`;
    case 'has_other':
      return `A pessoa já tem aula experimental agendada: ${describe(result.booking, ctx.timeZone)}. Para trocar, use cancelar_experimental e agende de novo, se ela confirmar.`;
    case 'full':
      return 'Esse horário acabou de lotar. Liste os horários de novo e ofereça outro.';
    case 'not_available':
      return 'Esse horário não está disponível (não existe, já passou ou é muito em cima da hora). Liste os horários de novo.';
  }
}

/** Command: cancela a aula futura do contato. */
export async function cancelTrialClass(deps: BookingDeps, ctx: ToolContext): Promise<string> {
  if (!ctx.contact.phone) return 'Não há aula agendada para este contato.';
  const result = await deps.bookings.cancelActive(ctx.tenantId, ctx.contact.phone, deps.now());
  if (result.kind === 'none') return 'Não há aula experimental futura agendada para este contato.';
  if (result.reminderJobId) await deps.reminders.cancel(result.reminderJobId);
  return `Cancelado: ${describe(result.booking, ctx.timeZone)}. A vaga foi liberada.`;
}
