/**
 * Agenda em memória com as mesmas regras do Postgres. Usada em testes e na avaliação da IA
 * (`npm run eval`), onde não há banco. Não entra em produção.
 */
import { computeFreeSlots, type ProfessionalSchedule, type WorkingInterval } from './availability.js';
import type {
  AgendaSettings,
  Appointment,
  AppointmentRepository,
  BookRequest,
  BookResult,
  CancelResult,
  CatalogRepository,
  ClientDelayReport,
  ClientDelayRepository,
  DelayNoticeInfo,
  DelayNoticeRepository,
  DelayNoticeSummary,
  Professional,
  ReminderInfo,
  RescheduleRequest,
  RescheduleResult,
  SalonService,
} from './ports.js';

const MINUTE = 60 * 1000;

interface Stored {
  id: number;
  serviceId: number;
  professionalId: number;
  phone: string;
  startsAt: Date;
  endsAt: Date;
  status: 'agendado' | 'cancelado';
  reminderJobId: string | null;
  reminderSentAt: Date | null;
  leadName: string | null;
  accountId: number | null;
  conversationId: number | null;
}

interface StoredNotice extends DelayNoticeSummary {
  id: number;
  tenantId: number;
}

export class InMemoryAgenda implements CatalogRepository, AppointmentRepository, DelayNoticeRepository, ClientDelayRepository {
  clientReports: Array<ClientDelayReport & { tenantId: number }> = [];
  notices: StoredNotice[] = [];
  private nextNoticeId = 1;
  services: SalonService[] = [];
  professionals: (Professional & { hours: WorkingInterval[]; timeOff: { startsAt: Date; endsAt: Date }[] })[] = [];
  stored: Stored[] = [];
  private nextId = 1;
  /** Telefones que pediram para não receber mensagens. */
  optedOut = new Set<string>();

  constructor(
    public config: AgendaSettings = { timeZone: 'America/Sao_Paulo', slotStepMin: 30, minNoticeMin: 60, maxDaysAhead: 30, lateToleranceMin: 15 },
  ) {}

  addService(s: Omit<SalonService, 'id' | 'description'> & { description?: string | null }): SalonService {
    const service = { description: null, ...s, id: this.services.length + 1 };
    this.services.push(service);
    return service;
  }

  addProfessional(name: string, serviceIds: number[], hours: WorkingInterval[]) {
    const p = { id: this.professionals.length + 1, name, serviceIds, hours, timeOff: [] };
    this.professionals.push(p);
    return p;
  }

  // ---- CatalogRepository ----
  async settings(): Promise<AgendaSettings> {
    return this.config;
  }
  async listServices(): Promise<SalonService[]> {
    return this.services;
  }
  async getService(_tenantId: number, id: number): Promise<SalonService | null> {
    return this.services.find((s) => s.id === id) ?? null;
  }
  async listProfessionals(_tenantId: number, serviceId?: number): Promise<Professional[]> {
    return this.professionals
      .filter((p) => !serviceId || p.serviceIds.includes(serviceId))
      .map((p) => ({ id: p.id, name: p.name, serviceIds: p.serviceIds }));
  }
  async loadSchedules(_tenantId: number, ids: number[]): Promise<ProfessionalSchedule[]> {
    return this.professionals
      .filter((p) => ids.includes(p.id))
      .map((p) => ({
        professionalId: p.id,
        hours: p.hours,
        timeOff: p.timeOff,
        appointments: this.stored.filter((a) => a.professionalId === p.id && a.status === 'agendado'),
      }));
  }
  async dayLoads(_tenantId: number, ids: number[], from: Date, to: Date): Promise<Map<number, number>> {
    const m = new Map<number, number>();
    for (const a of this.stored) {
      if (a.status === 'agendado' && ids.includes(a.professionalId) && a.startsAt >= from && a.startsAt < to) {
        m.set(a.professionalId, (m.get(a.professionalId) ?? 0) + 1);
      }
    }
    return m;
  }

  // ---- AppointmentRepository ----
  private fits(professionalId: number, durationMin: number, startsAt: Date, now: Date): boolean {
    const p = this.professionals.find((x) => x.id === professionalId);
    if (!p) return false;
    return computeFreeSlots({
      schedules: [{ professionalId, hours: p.hours, timeOff: p.timeOff, appointments: [] }],
      durationMin,
      stepMin: this.config.slotStepMin,
      from: startsAt,
      to: new Date(startsAt.getTime() + 1),
      now,
      minNoticeMin: this.config.minNoticeMin,
      maxDaysAhead: this.config.maxDaysAhead,
      timeZone: this.config.timeZone,
    }).some((s) => s.startsAt.getTime() === startsAt.getTime());
  }

  private view(a: Stored): Appointment {
    return {
      id: a.id,
      serviceId: a.serviceId,
      serviceName: this.services.find((s) => s.id === a.serviceId)!.name,
      professionalId: a.professionalId,
      professionalName: this.professionals.find((p) => p.id === a.professionalId)!.name,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
    };
  }

  private overlapping(from: Date, to: Date, pred: (a: Stored) => boolean, exceptId?: number): Stored | undefined {
    return this.stored.find((a) => a.status === 'agendado' && a.id !== exceptId && a.startsAt < to && a.endsAt > from && pred(a));
  }

  async book(req: BookRequest): Promise<BookResult> {
    const service = this.services.find((s) => s.id === req.serviceId);
    const p = this.professionals.find((x) => x.id === req.professionalId);
    if (!service || !p || !p.serviceIds.includes(service.id)) return { kind: 'not_available' };
    const endsAt = new Date(req.startsAt.getTime() + service.durationMin * MINUTE);

    const same = this.stored.find(
      (a) => a.status === 'agendado' && a.phone === req.contact.phone && a.professionalId === p.id && a.serviceId === service.id && a.startsAt.getTime() === req.startsAt.getTime(),
    );
    if (same) return { kind: 'already_booked', appointment: this.view(same) };
    const clash = this.overlapping(req.startsAt, endsAt, (a) => a.phone === req.contact.phone);
    if (clash) return { kind: 'client_busy', appointment: this.view(clash) };
    if (!this.fits(p.id, service.durationMin, req.startsAt, req.now)) return { kind: 'not_available' };
    if (this.overlapping(req.startsAt, endsAt, (a) => a.professionalId === p.id)) return { kind: 'busy' };

    const row: Stored = {
      id: this.nextId++,
      serviceId: service.id,
      professionalId: p.id,
      phone: req.contact.phone,
      startsAt: req.startsAt,
      endsAt,
      status: 'agendado',
      reminderJobId: null,
      reminderSentAt: null,
      leadName: req.contact.name,
      accountId: req.conversation?.accountId ?? null,
      conversationId: req.conversation?.conversationId ?? null,
    };
    this.stored.push(row);
    return { kind: 'booked', appointment: this.view(row) };
  }

  async reschedule(req: RescheduleRequest): Promise<RescheduleResult> {
    const cur = this.stored.find(
      (a) => a.id === req.appointmentId && a.phone === req.phone && a.status === 'agendado' && a.startsAt > req.now,
    );
    if (!cur) return { kind: 'not_found' };
    const professionalId = req.professionalId ?? cur.professionalId;
    if (professionalId === cur.professionalId && req.startsAt.getTime() === cur.startsAt.getTime()) {
      return { kind: 'unchanged', appointment: this.view(cur) };
    }
    const prof = this.professionals.find((p) => p.id === professionalId);
    if (!prof || !prof.serviceIds.includes(cur.serviceId)) return { kind: 'not_available' };
    const service = this.services.find((s) => s.id === cur.serviceId)!;
    const endsAt = new Date(req.startsAt.getTime() + service.durationMin * MINUTE);

    const clash = this.overlapping(req.startsAt, endsAt, (a) => a.phone === cur.phone, cur.id);
    if (clash) return { kind: 'client_busy', appointment: this.view(clash) };
    if (!this.fits(professionalId, service.durationMin, req.startsAt, req.now)) return { kind: 'not_available' };
    if (this.overlapping(req.startsAt, endsAt, (a) => a.professionalId === professionalId, cur.id)) return { kind: 'busy' };

    const reminderJobId = cur.reminderJobId;
    Object.assign(cur, { professionalId, startsAt: req.startsAt, endsAt, reminderJobId: null, reminderSentAt: null });
    return { kind: 'rescheduled', appointment: this.view(cur), reminderJobId };
  }

  async cancel(_tenantId: number, appointmentId: number, phone: string, now: Date): Promise<CancelResult> {
    const cur = this.stored.find((a) => a.id === appointmentId && a.phone === phone && a.status === 'agendado' && a.startsAt > now);
    if (!cur) return { kind: 'not_found' };
    cur.status = 'cancelado';
    return { kind: 'cancelled', appointment: this.view(cur), reminderJobId: cur.reminderJobId };
  }

  async listUpcoming(_tenantId: number, phone: string, now: Date): Promise<Appointment[]> {
    return this.stored
      .filter((a) => a.phone === phone && a.status === 'agendado' && a.startsAt > now)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .map((a) => this.view(a));
  }

  async setReminderJob(appointmentId: number, jobId: string | null): Promise<void> {
    const a = this.stored.find((x) => x.id === appointmentId);
    if (a) a.reminderJobId = jobId;
  }

  async getForReminder(appointmentId: number): Promise<ReminderInfo | null> {
    const a = this.stored.find((x) => x.id === appointmentId);
    if (!a) return null;
    const v = this.view(a);
    return {
      appointmentId: a.id,
      status: a.status,
      startsAt: a.startsAt,
      reminderSentAt: a.reminderSentAt,
      optedOut: this.optedOut.has(a.phone),
      accountId: a.accountId,
      conversationId: a.conversationId,
      leadName: a.leadName,
      serviceName: v.serviceName,
      professionalName: v.professionalName,
      timeZone: this.config.timeZone,
    };
  }

  async markReminderSent(appointmentId: number): Promise<boolean> {
    const a = this.stored.find((x) => x.id === appointmentId);
    if (!a || a.reminderSentAt) return false;
    a.reminderSentAt = new Date();
    return true;
  }

  async clearReminderSent(appointmentId: number): Promise<void> {
    const a = this.stored.find((x) => x.id === appointmentId);
    if (a) a.reminderSentAt = null;
  }

  // ---- DelayNoticeRepository ----
  async create(input: { tenantId: number; appointmentId: number; delayMin: number; originalStartsAt: Date }): Promise<number | null> {
    if (this.notices.some((n) => n.appointmentId === input.appointmentId && n.delayMin === input.delayMin)) return null;
    const id = this.nextNoticeId++;
    this.notices.push({ id, ...input, sentAt: null, response: null });
    return id;
  }

  async remove(id: number): Promise<void> {
    this.notices = this.notices.filter((n) => n.id !== id);
  }

  async getForSend(id: number): Promise<DelayNoticeInfo | null> {
    const n = this.notices.find((x) => x.id === id);
    const a = n && this.stored.find((x) => x.id === n.appointmentId);
    if (!n || !a) return null;
    return {
      ...n,
      appointmentStatus: a.status,
      optedOut: this.optedOut.has(a.phone),
      accountId: a.accountId,
      conversationId: a.conversationId,
      leadName: a.leadName,
      serviceName: this.view(a).serviceName,
      timeZone: this.config.timeZone,
    };
  }

  async markSent(id: number): Promise<boolean> {
    const n = this.notices.find((x) => x.id === id);
    if (!n || n.sentAt) return false;
    n.sentAt = new Date();
    return true;
  }

  async clearSent(id: number): Promise<void> {
    const n = this.notices.find((x) => x.id === id);
    if (n) n.sentAt = null;
  }

  private latestOf(appointmentId: number): StoredNotice | undefined {
    return this.notices.filter((n) => n.appointmentId === appointmentId && n.sentAt).sort((a, b) => b.id - a.id)[0];
  }

  async latestSent(appointmentIds: number[]): Promise<DelayNoticeSummary[]> {
    return appointmentIds.flatMap((id) => {
      const n = this.latestOf(id);
      return n ? [n] : [];
    });
  }

  async confirmLatest(appointmentId: number): Promise<boolean> {
    const n = this.latestOf(appointmentId);
    if (!n || n.response) return false;
    n.response = 'chegara_depois';
    return true;
  }

  // ---- ClientDelayRepository ----
  async record(tenantId: number, appointmentId: number, delayMin: number, now: Date): Promise<boolean> {
    if (this.clientReports.some((r) => r.appointmentId === appointmentId && r.delayMin === delayMin)) return false;
    this.clientReports.push({ tenantId, appointmentId, delayMin, reportedAt: now });
    return true;
  }

  async latest(appointmentIds: number[]): Promise<ClientDelayReport[]> {
    return appointmentIds.flatMap((id) => {
      const last = this.clientReports.filter((r) => r.appointmentId === id).at(-1);
      return last ? [last] : [];
    });
  }
}
