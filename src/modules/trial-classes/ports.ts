export interface TrialSlot {
  id: number;
  modality: string;
  startsAt: Date;
  capacity: number;
  booked: number;
}

export interface NewTrialSlot {
  modality: string;
  startsAt: Date;
  capacity: number;
}

export interface TrialSlotRepository {
  list(tenantId: number, from: Date, to: Date): Promise<TrialSlot[]>;
  create(tenantId: number, slot: NewTrialSlot): Promise<TrialSlot>;
  /** Atômico: só altera se a nova capacidade não ficar abaixo das reservas. */
  updateCapacity(tenantId: number, id: number, capacity: number): Promise<'ok' | 'not_found' | 'below_booked'>;
  /** Só exclui horários sem nenhuma reserva (nem cancelada, para manter o histórico). */
  delete(tenantId: number, id: number): Promise<'ok' | 'not_found' | 'has_bookings'>;
}

export interface BookingContact {
  phone: string;
  chatwootContactId: number;
  name: string | null;
}

export interface BookedClass {
  bookingId: number;
  slotId: number;
  modality: string;
  startsAt: Date;
}

export type BookResult =
  | { kind: 'booked'; booking: BookedClass }
  | { kind: 'already_booked'; booking: BookedClass }
  | { kind: 'has_other'; booking: BookedClass }
  | { kind: 'full' }
  | { kind: 'not_available' };

export interface BookingRequest {
  tenantId: number;
  slotId: number;
  contact: BookingContact;
  conversation: { accountId: number; conversationId: number };
  /** Horários que começam antes disso não podem ser reservados. */
  notBefore: Date;
}

export interface ReminderInfo {
  bookingId: number;
  status: string;
  reminderSentAt: Date | null;
  startsAt: Date;
  modality: string;
  leadName: string | null;
  /** Contato pediu para não receber mensagens ativas (SAIR). */
  optedOut: boolean;
  accountId: number | null;
  conversationId: number | null;
  timeZone: string;
}

/** Reservas da aula experimental (lado da IA). */
export interface BookingRepository {
  listAvailable(tenantId: number, from: Date, to: Date, modality?: string): Promise<TrialSlot[]>;
  /** Transação: trava o lead, confere reserva existente e ocupa a vaga de forma atômica. */
  book(req: BookingRequest): Promise<BookResult>;
  setReminderJob(bookingId: number, jobId: string | null): Promise<void>;
  /** Cancela a aula futura do contato e devolve a vaga. Devolve o id do job de lembrete, se houver. */
  cancelActive(
    tenantId: number,
    phone: string,
    now: Date,
  ): Promise<{ kind: 'cancelled'; booking: BookedClass; reminderJobId: string | null } | { kind: 'none' }>;
  getForReminder(bookingId: number): Promise<ReminderInfo | null>;
  /** Marca o lembrete como enviado; `false` se outro processo já marcou. */
  markReminderSent(bookingId: number): Promise<boolean>;
  clearReminderSent(bookingId: number): Promise<void>;
}

export interface ReminderScheduler {
  /** Agenda o lembrete; devolve o id do job para poder cancelar. */
  schedule(bookingId: number, at: Date): Promise<string>;
  cancel(jobId: string): Promise<void>;
}

export interface ReminderSender {
  sendTrialReminder(
    accountId: number,
    conversationId: number,
    params: { name: string; modality: string; when: string },
  ): Promise<void>;
}

export interface PanelBooking {
  id: number;
  status: 'agendada' | 'compareceu' | 'faltou';
  startsAt: Date;
  modality: string;
  leadId: number;
  leadName: string | null;
  leadPhone: string;
  leadGoal: string | null;
  reminderSentAt: Date | null;
  reminderScheduled: boolean;
  chatwootConversationId: number | null;
}

export type Attendance = 'compareceu' | 'faltou' | 'agendada';

/** Aulas agendadas vistas pelo painel. */
export interface BookingAdminRepository {
  list(tenantId: number, from: Date, to: Date): Promise<PanelBooking[]>;
  /** Só para aulas que já começaram (`startsAt <= now`). */
  markAttendance(
    tenantId: number,
    id: number,
    status: Attendance,
    now: Date,
  ): Promise<'ok' | 'not_found' | 'not_started'>;
}
