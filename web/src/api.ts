/** Cliente das rotas `/admin/api`. Erros viram `ApiError` com a mensagem pronta para mostrar. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  let res: Response;
  try {
    res = await fetch(`/admin/api${path}`, init);
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a internet e tente de novo.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('painel:sessao-expirada'));
    throw new ApiError(data.error ?? `Erro ${res.status}`, res.status);
  }
  return data as T;
}

export type Role = 'dono' | 'recepcao';
export interface Me {
  email: string;
  role: Role;
  mustChangePassword?: boolean;
  timeZone?: string;
  chatwootAccountUrl?: string | null;
}

export interface Client {
  id: number;
  name: string | null;
  phone: string;
  chatwootContactId: number | null;
  nextAppointment: { startsAt: string; serviceName: string; professionalName: string } | null;
  completed: number;
  noShows: number;
  optedOut: boolean;
  updatedAt: string;
}

export interface Report {
  month: string;
  from: string;
  to: string;
  partial: boolean;
  timeZone: string;
  conversations: number;
  resolvedByAiShare: number | null;
  funnel: Array<{ key: string; label: string; count: number }>;
  appointments: { scheduled: number; completed: number; noShow: number; cancelled: number };
  noShowShare: number | null;
  topServices: Array<{ name: string; count: number }>;
  handoffs: { total: number; byCategory: Array<{ label: string; count: number }> };
  conversationsByHour: number[];
  receptionHours: { open: number; close: number } | null;
  outsideReceptionShare: number | null;
  aiCostBrl: number | null;
  aiCostPerConversationBrl: number | null;
  medianLatencyMs: number | null;
}

export interface SalonService {
  id: number;
  name: string;
  description: string | null;
  durationMin: number;
  priceCents: number | null;
  active: boolean;
}
export type ServiceInput = Omit<SalonService, 'id'>;

export interface HoursBlock {
  weekday: number;
  startMin: number;
  endMin: number;
}
export interface TimeOff {
  id: number;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}
export interface Professional {
  id: number;
  name: string;
  active: boolean;
  serviceIds: number[];
  hours: HoursBlock[];
  timeOff: TimeOff[];
}
export type ProfessionalInput = Omit<Professional, 'id' | 'timeOff'>;

export type AppointmentStatus = 'agendado' | 'cancelado' | 'concluido' | 'faltou';
export interface Appointment {
  id: number;
  serviceId: number;
  serviceName: string;
  professionalId: number;
  professionalName: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: 'ia' | 'painel';
  clientName: string | null;
  clientPhone: string;
  reminderSentAt: string | null;
  chatwootConversationId: number | null;
  /** Último aviso de atraso enviado (spec 0014). */
  /** A cliente avisou que vai atrasar (WhatsApp). */
  clientDelay?: { delayMin: number; reportedAt: string; expectedAt: string; withinTolerance: boolean };
  delayNotice?: { delayMin: number; status: 'enviado' | 'confirmou' | 'remarcou' | 'cancelou'; expectedAt: string };
}
export interface FreeSlot {
  startsAt: string;
  professionalId: number;
  professionalName: string;
}

export interface KnowledgeItem {
  id?: number;
  category: string;
  content: string;
  active: boolean;
}
export interface KnowledgeBase {
  version: number;
  items: KnowledgeItem[];
}

export interface KnowledgeVersionSummary {
  version: number;
  author: string;
  createdAt: string;
  itemCount: number;
  activeChars: number;
}
export interface KnowledgeVersion extends KnowledgeVersionSummary {
  items: KnowledgeItem[];
}

export interface ImportPreview {
  items: Array<{ category: string; content: string }>;
  pending: string[];
  warnings: string[];
  receptionHours: { open: number; close: number } | null;
  evalCaseCount: number;
}
export interface AgentTestResult {
  reply: string | null;
  handoff: { reason: string; question: string | null } | null;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface UnansweredQuestion {
  id: number;
  question: string;
  conversationId: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Settings {
  name: string;
  timeZone: string;
  receptionHours: { open: number; close: number } | null;
  privacyUrl: string | null;
}
export interface TeamMember {
  id: number;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  createdAt: string;
  isMe: boolean;
}

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  login: (email: string, password: string) => request<Me>('POST', '/auth/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  changePassword: (current: string, next: string) => request<{ ok: true }>('POST', '/auth/password', { current, next }),

  getSettings: () => request<Settings & { timeZones: string[] }>('GET', '/settings'),
  saveSettings: (s: Settings) => request<{ ok: true }>('PUT', '/settings', s),
  listUsers: () => request<{ users: TeamMember[] }>('GET', '/users'),
  createUser: (email: string, role: Role) =>
    request<{ id: number; email: string; tempPassword: string }>('POST', '/users', { email, role }),
  resetUserPassword: (id: number) =>
    request<{ tempPassword: string }>('POST', `/users/${id}/reset-password`, {}),
  removeUser: (id: number) => request<{ ok: true }>('DELETE', `/users/${id}`),

  getKnowledge: () => request<KnowledgeBase>('GET', '/knowledge'),
  saveKnowledge: (expectedVersion: number, items: KnowledgeItem[]) =>
    request<{ ok: true; version: number }>('PUT', '/knowledge', {
      expectedVersion,
      items: items.map(({ category, content, active }) => ({ category, content, active })),
    }),

  listVersions: () => request<{ versions: KnowledgeVersionSummary[] }>('GET', '/knowledge/versions'),
  getVersion: (v: number) => request<KnowledgeVersion>('GET', `/knowledge/versions/${v}`),

  previewImport: (markdown: string) => request<ImportPreview>('POST', '/knowledge/import/preview', { markdown }),
  testAgent: (question: string, items: KnowledgeItem[]) =>
    request<AgentTestResult>('POST', '/knowledge/test', {
      question,
      items: items.map(({ category, content, active }) => ({ category, content, active })),
    }),

  listClients: (q?: string) => request<{ clients: Client[] }>('GET', `/clients${q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`),

  listUnanswered: (from: string, to: string) =>
    request<{ items: UnansweredQuestion[] }>(
      'GET',
      `/unanswered?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  setUnansweredResolved: (id: number, resolved: boolean) =>
    request<{ ok: true }>('PATCH', `/unanswered/${id}`, { resolved }),

  listServices: () => request<{ services: SalonService[] }>('GET', '/services'),
  createService: (input: ServiceInput) => request<SalonService>('POST', '/services', input),
  updateService: (id: number, input: ServiceInput) => request<{ ok: true }>('PUT', `/services/${id}`, input),

  listProfessionals: () => request<{ professionals: Professional[] }>('GET', '/professionals'),
  createProfessional: (input: ProfessionalInput) => request<{ id: number }>('POST', '/professionals', input),
  updateProfessional: (id: number, input: ProfessionalInput) => request<{ ok: true }>('PUT', `/professionals/${id}`, input),
  addTimeOff: (id: number, startsAt: string, endsAt: string, reason: string | null) =>
    request<{ id: number; affected: number }>('POST', `/professionals/${id}/time-off`, { startsAt, endsAt, reason }),
  removeTimeOff: (id: number, timeOffId: number) => request<{ ok: true }>('DELETE', `/professionals/${id}/time-off/${timeOffId}`),

  listAppointments: (from: Date, to: Date) =>
    request<{ appointments: Appointment[] }>(
      'GET',
      `/appointments?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    ),
  freeSlots: (serviceId: number, day: string, professionalId?: number) =>
    request<{ slots: FreeSlot[] }>('GET', `/free-slots?serviceId=${serviceId}&day=${day}${professionalId ? `&professionalId=${professionalId}` : ''}`),
  createAppointment: (input: { serviceId: number; professionalId: number; startsAt: string; phone: string; name: string | null }) =>
    request<{ id: number }>('POST', '/appointments', input),
  setAppointmentStatus: (id: number, status: 'concluido' | 'faltou' | 'agendado') =>
    request<{ ok: true }>('PATCH', `/appointments/${id}`, { status }),
  rescheduleAppointment: (id: number, startsAt: string, professionalId?: number) =>
    request<{ ok: true }>('POST', `/appointments/${id}/reschedule`, { startsAt, ...(professionalId ? { professionalId } : {}) }),
  sendDelayNotice: (id: number, delayMin: number) => request<{ ok: true; duplicate?: true }>('POST', `/appointments/${id}/delay-notice`, { delayMin }),
  cancelAppointment: (id: number) => request<{ ok: true }>('DELETE', `/appointments/${id}`),

  report: (month?: string) => request<Report>('GET', `/report${month ? `?month=${month}` : ''}`),
};
