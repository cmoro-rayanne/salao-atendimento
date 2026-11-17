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

export const LEAD_STATUSES = ['novo', 'qualificado', 'experimental_agendada', 'matriculado', 'perdido'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface Lead {
  id: number;
  name: string | null;
  phone: string;
  goal: string | null;
  modality: string | null;
  status: LeadStatus;
  version: number;
  chatwootContactId: number | null;
  updatedAt: string;
}

export interface Booking {
  id: number;
  status: 'agendada' | 'compareceu' | 'faltou';
  startsAt: string;
  modality: string;
  leadName: string | null;
  leadPhone: string;
  leadGoal: string | null;
  reminderSentAt: string | null;
  reminderScheduled: boolean;
  chatwootConversationId: number | null;
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
  trialRules: Array<{ modality: string; weekdays: number[]; times: Array<{ hour: number; minute: number }>; capacity: number }>;
  slotCount: number;
  evalCaseCount: number;
}
export interface AgentTestResult {
  reply: string | null;
  handoff: { reason: string; question: string | null } | null;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface Slot {
  id: number;
  modality: string;
  startsAt: string;
  capacity: number;
  booked: number;
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
  importSchedule: (markdown: string) =>
    request<{ created: number; skipped: number }>('POST', '/knowledge/import/schedule', { markdown }),
  testAgent: (question: string, items: KnowledgeItem[]) =>
    request<AgentTestResult>('POST', '/knowledge/test', {
      question,
      items: items.map(({ category, content, active }) => ({ category, content, active })),
    }),

  listSlots: (from: Date, to: Date) =>
    request<{ slots: Slot[] }>(
      'GET',
      `/trial-slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    ),
  createSlot: (modality: string, startsAt: Date, capacity: number) =>
    request<Slot>('POST', '/trial-slots', { modality, startsAt: startsAt.toISOString(), capacity }),
  setCapacity: (id: number, capacity: number) => request<{ ok: true }>('PATCH', `/trial-slots/${id}`, { capacity }),
  deleteSlot: (id: number) => request<{ ok: true }>('DELETE', `/trial-slots/${id}`),

  listLeads: (p: { from: Date; to: Date; status?: LeadStatus | undefined; q?: string | undefined }) => {
    const qs = new URLSearchParams({ from: p.from.toISOString(), to: p.to.toISOString() });
    if (p.status) qs.set('status', p.status);
    if (p.q?.trim()) qs.set('q', p.q.trim());
    return request<{ items: Lead[]; counts: Record<LeadStatus, number> }>('GET', `/leads?${qs}`);
  },
  setLeadStatus: (id: number, status: LeadStatus, expectedVersion: number) =>
    request<{ ok: true; version: number }>('PATCH', `/leads/${id}`, { status, expectedVersion }),

  listBookings: (from: Date, to: Date) =>
    request<{ bookings: Booking[] }>(
      'GET',
      `/bookings?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    ),
  setAttendance: (id: number, attendance: 'compareceu' | 'faltou' | 'agendada') =>
    request<{ ok: true }>('PATCH', `/bookings/${id}`, { attendance }),

  listUnanswered: (from: string, to: string) =>
    request<{ items: UnansweredQuestion[] }>(
      'GET',
      `/unanswered?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  setUnansweredResolved: (id: number, resolved: boolean) =>
    request<{ ok: true }>('PATCH', `/unanswered/${id}`, { resolved }),

  report: (month?: string) => request<Report>('GET', `/report${month ? `?month=${month}` : ''}`),
};
