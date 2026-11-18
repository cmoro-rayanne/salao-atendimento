import { localParts } from '../../shared/time-zone.js';
import type { AgendaAdminRepository } from './admin-ports.js';
import type { AppointmentRepository, DelayNoticeRepository, DelayNoticeScheduler, DelayNoticeSender } from './ports.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const MIN_DELAY_MIN = 5;
export const MAX_DELAY_MIN = 120;

/** "14:35" no fuso do salão. */
export function clock(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export interface RequestDelayDeps {
  admin: Pick<AgendaAdminRepository, 'getPhone'>;
  appointments: Pick<AppointmentRepository, 'getForReminder'>;
  notices: Pick<DelayNoticeRepository, 'create' | 'remove'>;
  scheduler: DelayNoticeScheduler;
  now: () => Date;
}

export type RequestDelayResult =
  | { kind: 'queued'; noticeId: number }
  | { kind: 'already_requested' }
  | { kind: 'invalid_delay' | 'not_found' | 'not_active' | 'out_of_window' | 'no_whatsapp' | 'opted_out' };

/** Command do painel: valida e enfileira o aviso. O envio acontece no worker. */
export async function requestDelayNotice(
  deps: RequestDelayDeps,
  input: { tenantId: number; appointmentId: number; delayMin: number },
): Promise<RequestDelayResult> {
  if (!Number.isInteger(input.delayMin) || input.delayMin < MIN_DELAY_MIN || input.delayMin > MAX_DELAY_MIN) {
    return { kind: 'invalid_delay' };
  }
  // O telefone só serve de checagem de salão: some se o agendamento é de outro tenant.
  if (!(await deps.admin.getPhone(input.tenantId, input.appointmentId))) return { kind: 'not_found' };
  const info = await deps.appointments.getForReminder(input.appointmentId);
  if (!info) return { kind: 'not_found' };
  if (info.status !== 'agendado') return { kind: 'not_active' };
  const now = deps.now().getTime();
  const start = info.startsAt.getTime();
  if (start < now - 30 * MINUTE || start > now + 6 * HOUR) return { kind: 'out_of_window' };
  if (info.conversationId === null || info.accountId === null) return { kind: 'no_whatsapp' };
  if (info.optedOut) return { kind: 'opted_out' };

  const noticeId = await deps.notices.create({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    delayMin: input.delayMin,
    originalStartsAt: info.startsAt,
  });
  if (noticeId === null) return { kind: 'already_requested' };
  try {
    await deps.scheduler.enqueue(noticeId);
  } catch (err) {
    await deps.notices.remove(noticeId); // sem job, o registro travaria novas tentativas
    throw err;
  }
  return { kind: 'queued', noticeId };
}

export type SendDelayOutcome =
  | 'sent'
  | 'skipped_missing'
  | 'skipped_inactive'
  | 'skipped_already_sent'
  | 'skipped_no_conversation'
  | 'skipped_opted_out';

export interface SendDelayDeps {
  notices: Pick<DelayNoticeRepository, 'getForSend' | 'markSent' | 'clearSent'>;
  sender: DelayNoticeSender;
}

/** Use case do job: idempotente (marca antes de enviar, desmarca se o envio falhar para a nova tentativa valer). */
export async function sendDelayNotice(deps: SendDelayDeps, noticeId: number): Promise<SendDelayOutcome> {
  const n = await deps.notices.getForSend(noticeId);
  if (!n) return 'skipped_missing';
  if (n.sentAt) return 'skipped_already_sent';
  if (n.appointmentStatus !== 'agendado') return 'skipped_inactive';
  if (n.optedOut) return 'skipped_opted_out';
  if (n.accountId === null || n.conversationId === null) return 'skipped_no_conversation';
  if (!(await deps.notices.markSent(noticeId))) return 'skipped_already_sent';
  try {
    await deps.sender.sendDelayNotice(n.accountId, n.conversationId, {
      name: n.leadName?.trim().split(/\s+/)[0] || 'tudo bem',
      service: n.serviceName,
      delayMin: n.delayMin,
      expected: clock(new Date(n.originalStartsAt.getTime() + n.delayMin * MINUTE), n.timeZone),
    });
  } catch (err) {
    await deps.notices.clearSent(noticeId);
    throw err;
  }
  return 'sent';
}

export type DelayStatus = 'enviado' | 'confirmou' | 'remarcou';

/** Situação do aviso, derivada: a cliente confirmou, remarcou (início mudou) ou só foi avisada. */
export function delayStatus(
  notice: { response: 'chegara_depois' | null; originalStartsAt: Date },
  appointment: { startsAt: Date },
): DelayStatus {
  if (appointment.startsAt.getTime() !== notice.originalStartsAt.getTime()) return 'remarcou';
  return notice.response === 'chegara_depois' ? 'confirmou' : 'enviado';
}
