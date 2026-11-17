import type { Appointment } from './ports.js';

export interface AdminService {
  id: number;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number | null;
  active: boolean;
}

export interface ServiceInput {
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number | null;
  active: boolean;
}

/** Faixa de expediente num dia da semana (0 = domingo … 6 = sábado), em minutos desde 00:00 local. */
export interface HoursBlock {
  weekday: number;
  startMin: number;
  endMin: number;
}

export interface TimeOff {
  id: number;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
}

export interface AdminProfessional {
  id: number;
  name: string;
  active: boolean;
  serviceIds: number[];
  hours: HoursBlock[];
  timeOff: TimeOff[];
}

export interface ProfessionalInput {
  name: string;
  active: boolean;
  serviceIds: number[];
  hours: HoursBlock[];
}

export type AppointmentStatus = 'agendado' | 'cancelado' | 'concluido' | 'faltou';

export interface PanelAppointment extends Appointment {
  status: AppointmentStatus;
  source: 'ia' | 'painel';
  clientName: string | null;
  clientPhone: string;
  reminderSentAt: Date | null;
  chatwootConversationId: number | null;
}

/** Cadastro e agenda pelo painel (lado da equipe). Tudo filtrado pelo salão da sessão. */
export interface AgendaAdminRepository {
  listServices(tenantId: number): Promise<AdminService[]>;
  createService(tenantId: number, input: ServiceInput): Promise<AdminService>;
  /** `not_found` se o serviço não é deste salão. */
  updateService(tenantId: number, id: number, input: ServiceInput): Promise<'ok' | 'not_found'>;

  listProfessionals(tenantId: number): Promise<AdminProfessional[]>;
  createProfessional(tenantId: number, input: ProfessionalInput): Promise<number | 'invalid_services'>;
  updateProfessional(tenantId: number, id: number, input: ProfessionalInput): Promise<'ok' | 'not_found' | 'invalid_services'>;
  addTimeOff(tenantId: number, professionalId: number, startsAt: Date, endsAt: Date, reason: string | null): Promise<number | 'not_found'>;
  removeTimeOff(tenantId: number, professionalId: number, timeOffId: number): Promise<'ok' | 'not_found'>;
  /** Agendamentos ativos de uma profissional que cairiam dentro da folga (para avisar a recepção). */
  countActiveInRange(tenantId: number, professionalId: number, from: Date, to: Date): Promise<number>;

  listAppointments(tenantId: number, from: Date, to: Date): Promise<PanelAppointment[]>;
  /** Concluir ou marcar falta só depois do horário começar; reabrir (`agendado`) volta ao estado inicial. */
  markStatus(
    tenantId: number,
    id: number,
    status: 'concluido' | 'faltou' | 'agendado',
    now: Date,
  ): Promise<'ok' | 'not_found' | 'not_started' | 'cancelled' | 'busy'>;
  /** Telefone e job de lembrete do agendamento, para reaproveitar remarcar/cancelar (que exigem o telefone). */
  getPhone(tenantId: number, id: number): Promise<{ phone: string } | null>;
}
