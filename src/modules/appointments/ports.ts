import type { ProfessionalSchedule } from './availability.js';

export interface SalonService {
  id: number;
  name: string;
  description: string | null;
  durationMin: number;
  /** Vazio = "a combinar": a IA não informa valor. */
  priceCents: number | null;
}

export interface Professional {
  id: number;
  name: string;
  serviceIds: number[];
}

export interface AgendaSettings {
  timeZone: string;
  slotStepMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
}

/** Cadastro do salão (lado da IA: só leitura). */
export interface CatalogRepository {
  settings(tenantId: number): Promise<AgendaSettings>;
  listServices(tenantId: number): Promise<SalonService[]>;
  getService(tenantId: number, serviceId: number): Promise<SalonService | null>;
  /** Profissionais ativas; com `serviceId`, só as que fazem esse serviço. */
  listProfessionals(tenantId: number, serviceId?: number): Promise<Professional[]>;
  /** Expediente, folgas e agendamentos ativos que tocam a janela. */
  loadSchedules(tenantId: number, professionalIds: number[], from: Date, to: Date): Promise<ProfessionalSchedule[]>;
  /** Quantos agendamentos ativos cada profissional tem no intervalo (para "qualquer profissional"). */
  dayLoads(tenantId: number, professionalIds: number[], from: Date, to: Date): Promise<Map<number, number>>;
}

export interface Appointment {
  id: number;
  serviceId: number;
  serviceName: string;
  professionalId: number;
  professionalName: string;
  startsAt: Date;
  endsAt: Date;
}

export interface Contact {
  phone: string;
  /** Nulo quando a recepção agenda pelo painel. */
  chatwootContactId: number | null;
  name: string | null;
}

export interface BookRequest {
  tenantId: number;
  serviceId: number;
  professionalId: number;
  startsAt: Date;
  contact: Contact;
  conversation: { accountId: number; conversationId: number } | null;
  source: 'ia' | 'painel';
  now: Date;
}

export type BookResult =
  | { kind: 'booked'; appointment: Appointment }
  /** Mesmo pedido repetido: devolve o que já existe. */
  | { kind: 'already_booked'; appointment: Appointment }
  /** Outra cliente ocupou o horário (ou já existia agendamento na mesma hora). */
  | { kind: 'busy' }
  /** A própria cliente já tem outro agendamento que se sobrepõe a esse horário. */
  | { kind: 'client_busy'; appointment: Appointment }
  /** Serviço/profissional inválidos, fora do expediente, folga, no passado ou sem antecedência. */
  | { kind: 'not_available' };

export interface RescheduleRequest {
  tenantId: number;
  appointmentId: number;
  /** Só mexe em agendamentos do próprio contato. */
  phone: string;
  startsAt: Date;
  /** Troca de profissional é opcional; sem ela, mantém a atual. */
  professionalId?: number;
  now: Date;
}

export type RescheduleResult =
  | { kind: 'rescheduled'; appointment: Appointment; reminderJobId: string | null }
  | { kind: 'unchanged'; appointment: Appointment }
  | { kind: 'busy' }
  | { kind: 'client_busy'; appointment: Appointment }
  | { kind: 'not_available' }
  | { kind: 'not_found' };

export type CancelResult =
  | { kind: 'cancelled'; appointment: Appointment; reminderJobId: string | null }
  | { kind: 'not_found' };

/** Agendamentos (lado da IA). */
export interface AppointmentRepository {
  /** Transação: trava a cliente, confere expediente/folga/choque e grava. O banco recusa sobreposição como última defesa. */
  book(req: BookRequest): Promise<BookResult>;
  reschedule(req: RescheduleRequest): Promise<RescheduleResult>;
  cancel(tenantId: number, appointmentId: number, phone: string, now: Date): Promise<CancelResult>;
  /** Agendamentos futuros ativos do contato. */
  listUpcoming(tenantId: number, phone: string, now: Date): Promise<Appointment[]>;
  setReminderJob(appointmentId: number, jobId: string | null): Promise<void>;
  /** Dados para o envio do lembrete; null se o agendamento não existe. */
  getForReminder(appointmentId: number): Promise<ReminderInfo | null>;
  /** Marca o envio só se ainda não foi marcado (true = esta chamada marcou). */
  markReminderSent(appointmentId: number): Promise<boolean>;
  clearReminderSent(appointmentId: number): Promise<void>;
}

export interface ReminderInfo {
  appointmentId: number;
  status: 'agendado' | 'cancelado' | 'concluido' | 'faltou';
  startsAt: Date;
  reminderSentAt: Date | null;
  /** A pessoa pediu para não receber mensagens (LGPD). */
  optedOut: boolean;
  accountId: number | null;
  conversationId: number | null;
  leadName: string | null;
  serviceName: string;
  professionalName: string;
  timeZone: string;
}

export interface ReminderSender {
  sendAppointmentReminder(
    accountId: number,
    conversationId: number,
    params: { name: string; service: string; professional: string; when: string },
  ): Promise<void>;
}

export interface ReminderScheduler {
  /** Agenda o lembrete; devolve o id do job para poder cancelar. */
  schedule(appointmentId: number, at: Date): Promise<string>;
  cancel(jobId: string): Promise<void>;
}
