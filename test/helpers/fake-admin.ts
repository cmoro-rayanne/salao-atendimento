import { ScryptPasswordHasher } from '../../src/adapters/crypto/scrypt-hasher.js';
import { SESSION_COOKIE, type AdminDeps } from '../../src/http/admin-routes.js';
import { buildServer } from '../../src/http/server.js';
import type { AdminSession, AdminUser } from '../../src/modules/auth/ports.js';
import type { EditableKnowledgeItem } from '../../src/modules/knowledge/ports.js';
import type { LeadListItem, LeadStatus } from '../../src/modules/leads/ports.js';
import type { MonthlyRawData, ReportRange } from '../../src/modules/reports/ports.js';
import type { PanelBooking, TrialSlot } from '../../src/modules/trial-classes/ports.js';

const hasher = new ScryptPasswordHasher();

/** Painel com repositórios em memória, separados por academia (tenant). */
export async function fakeAdmin() {
  const users: AdminUser[] = [
    { id: 1, tenantId: 1, email: 'dono@ciadaforma.com.br', passwordHash: await hasher.hash('senha-forte-123'), role: 'dono', mustChangePassword: false },
    { id: 2, tenantId: 2, email: 'dono@outra.com.br', passwordHash: await hasher.hash('outra-senha-123'), role: 'dono', mustChangePassword: false },
    { id: 3, tenantId: 1, email: 'recepcao@ciadaforma.com.br', passwordHash: await hasher.hash('recepcao-123456'), role: 'recepcao', mustChangePassword: false },
  ];
  const sessions = new Map<string, AdminSession>();
  let settings = { name: 'Cia da Forma', timeZone: 'America/Sao_Paulo', receptionHours: null as { open: number; close: number } | null, privacyUrl: null as string | null };
  const attempts = new Map<string, number>();
  const versions: Array<{
    tenantId: number;
    version: number;
    author: string;
    createdAt: Date;
    itemCount: number;
    activeChars: number;
    items: Array<Omit<EditableKnowledgeItem, 'id'>>;
  }> = [];
  const kb = new Map<number, { version: number; items: EditableKnowledgeItem[] }>([
    [1, { version: 1, items: [{ id: 1, category: 'Planos', content: 'Mensal R$ 120', active: true }] }],
    [2, { version: 1, items: [{ id: 2, category: 'Segredo', content: 'da outra academia', active: true }] }],
  ]);
  const slots = new Map<number, TrialSlot & { tenantId: number }>();
  let nextId = 100;
  const NOW = new Date('2026-11-16T15:00:00Z');
  const leads: Array<LeadListItem & { tenantId: number }> = [
    { tenantId: 1, id: 1, name: 'Carla', phone: '+5541999990001', goal: 'emagrecer', modality: 'Funcional', status: 'qualificado', version: 3, chatwootContactId: 5, createdAt: NOW, updatedAt: NOW },
    { tenantId: 2, id: 2, name: 'De outra academia', phone: '+5541999990002', goal: null, modality: null, status: 'novo', version: 1, chatwootContactId: 6, createdAt: NOW, updatedAt: NOW },
  ];
  const bookings: Array<PanelBooking & { tenantId: number }> = [
    { tenantId: 1, id: 7, status: 'agendada', startsAt: new Date('2026-11-16T10:00:00Z'), modality: 'Pilates', leadId: 1, leadName: 'Carla', leadPhone: '+55', leadGoal: null, reminderSentAt: null, reminderScheduled: false, chatwootConversationId: 77 },
    { tenantId: 1, id: 8, status: 'agendada', startsAt: new Date('2026-11-18T10:00:00Z'), modality: 'Pilates', leadId: 1, leadName: 'Carla', leadPhone: '+55', leadGoal: null, reminderSentAt: null, reminderScheduled: true, chatwootConversationId: 77 },
  ];
  const reportCalls: ReportRange[] = [];
  const questions = [
    { tenantId: 1, id: 1, question: 'Tem natação?', conversationId: 77, createdAt: NOW, resolvedAt: null as Date | null },
    { tenantId: 2, id: 2, question: 'Tem crossfit?', conversationId: 88, createdAt: NOW, resolvedAt: null as Date | null },
  ];

  const deps: AdminDeps = {
    hasher,
    secureCookies: false,
    sessionTtlSec: 3600,
    users: {
      findByEmail: async (email) => users.find((u) => u.email === email) ?? null,
      findById: async (tenantId, id) => users.find((u) => u.id === id && u.tenantId === tenantId) ?? null,
      listByTenant: async (tenantId) =>
        users.filter((u) => u.tenantId === tenantId).map((u) => ({ id: u.id, email: u.email, role: u.role, mustChangePassword: u.mustChangePassword, createdAt: NOW })),
      create: async (input) => {
        if (users.some((u) => u.email === input.email)) return null;
        const u = { ...input, id: users.length + 10 };
        users.push(u);
        return u;
      },
      setPassword: async (tenantId, id, hash, must) => {
        const u = users.find((x) => x.id === id && x.tenantId === tenantId);
        if (!u) return false;
        u.passwordHash = hash;
        u.mustChangePassword = must;
        return true;
      },
      remove: async (tenantId, id) => {
        const u = users.find((x) => x.id === id && x.tenantId === tenantId);
        if (!u) return 'not_found';
        if (u.role === 'dono' && users.filter((x) => x.tenantId === tenantId && x.role === 'dono').length <= 1) return 'last_owner';
        users.splice(users.indexOf(u), 1);
        return 'ok';
      },
    },
    llm: null,
    agentMaxSteps: 5,
    testLimiter: { hit: async () => ({ allowed: true, retryAfterSec: 0 }), reset: async () => {} },
    unanswered: {
      list: async (tenantId) => questions.filter((q) => q.tenantId === tenantId).map((q) => ({ id: q.id, question: q.question, conversationId: q.conversationId, createdAt: q.createdAt, resolvedAt: q.resolvedAt })),
      setResolved: async (tenantId, id, resolved, now) => {
        const q = questions.find((x) => x.id === id && x.tenantId === tenantId);
        if (!q) return false;
        q.resolvedAt = resolved ? now : null;
        return true;
      },
    },
    settings: {
      get: async () => settings,
      save: async (_t, s) => {
        settings = s;
      },
    },
    sessions: {
      create: async (s) => {
        const token = `tok-${Math.random().toString(36).slice(2)}`;
        sessions.set(token, s);
        return token;
      },
      destroyAllForUser: async (userId, except) => {
        for (const [t, s] of sessions) if (s.userId === userId && t !== except) sessions.delete(t);
      },
      get: async (t) => sessions.get(t) ?? null,
      destroy: async (t) => {
        sessions.delete(t);
      },
    },
    limiter: {
      hit: async (k) => {
        const n = (attempts.get(k) ?? 0) + 1;
        attempts.set(k, n);
        return { allowed: n <= 5, retryAfterSec: 900 };
      },
      reset: async (k) => {
        attempts.delete(k);
      },
    },
    knowledge: {
      getForEdit: async (tenantId) => kb.get(tenantId)!,
      replaceAll: async (tenantId, expected, items, author = '?') => {
        const cur = kb.get(tenantId)!;
        if (cur.version !== expected) return { ok: false, currentVersion: cur.version };
        const version = cur.version + 1;
        kb.set(tenantId, { version, items: items.map((i) => ({ ...i, id: nextId++ })) });
        versions.push({ tenantId, version, author, createdAt: NOW, itemCount: items.length, activeChars: 0, items });
        return { ok: true, version };
      },
      listVersions: async (tenantId) =>
        versions.filter((v) => v.tenantId === tenantId).map(({ tenantId: t, items: i, ...v }) => (void t, void i, v)).reverse(),
      getVersion: async (tenantId, version) => {
        const v = versions.find((x) => x.tenantId === tenantId && x.version === version);
        if (!v) return null;
        const { tenantId: t, ...rest } = v;
        void t;
        return rest;
      },
    },
    now: () => NOW,
    usdBrl: 5,
    tenantInfo: async () => ({ timeZone: 'America/Sao_Paulo', chatwootAccountId: 3 }),
    chatwootPublicUrl: 'https://chat.exemplo.com.br/',
    leads: {
      list: async (tenantId, q) => {
        const mine = leads.filter((l) => l.tenantId === tenantId);
        const counts = { novo: 0, qualificado: 0, experimental_agendada: 0, matriculado: 0, perdido: 0 } as Record<LeadStatus, number>;
        for (const l of mine) counts[l.status]++;
        return { items: mine.filter((l) => !q.status || l.status === q.status), counts };
      },
      updateStatus: async (tenantId, id, status, expected) => {
        const l = leads.find((x) => x.id === id && x.tenantId === tenantId);
        if (!l) return { kind: 'not_found' };
        if (l.version !== expected) return { kind: 'conflict', currentVersion: l.version };
        l.status = status;
        l.version++;
        return { kind: 'ok', version: l.version };
      },
    },
    bookings: {
      list: async (tenantId) => bookings.filter((b) => b.tenantId === tenantId),
      markAttendance: async (tenantId, id, status, now) => {
        const b = bookings.find((x) => x.id === id && x.tenantId === tenantId);
        if (!b) return 'not_found';
        if (b.startsAt > now) return 'not_started';
        b.status = status;
        return 'ok';
      },
    },
    reports: {
      monthlyRaw: async (range): Promise<MonthlyRawData> => {
        reportCalls.push(range);
        return {
          conversations: 10, conversationsWithoutHandoff: 7,
          handoffReasons: [{ reason: 'quer se matricular', count: 2 }, { reason: 'informação não está na base', count: 1 }],
          interestedLeads: 6, trialClasses: 4, attended: 3, enrollments: 1,
          conversationsByHour: Array.from({ length: 24 }, (_, h) => (h === 22 ? 4 : h === 10 ? 6 : 0)),
          aiCostUsd: 2, medianLatencyMs: 5400, receptionHours: { open: 7, close: 21 },
        };
      },
    },
    slots: {
      list: async (tenantId) => [...slots.values()].filter((s) => s.tenantId === tenantId),
      create: async (tenantId, s) => {
        const slot = { ...s, id: nextId++, booked: 0, tenantId };
        slots.set(slot.id, slot);
        return slot;
      },
      updateCapacity: async (tenantId, id, capacity) => {
        const s = slots.get(id);
        if (!s || s.tenantId !== tenantId) return 'not_found';
        if (s.booked > capacity) return 'below_booked';
        s.capacity = capacity;
        return 'ok';
      },
      delete: async (tenantId, id) => {
        const s = slots.get(id);
        if (!s || s.tenantId !== tenantId) return 'not_found';
        if (s.booked > 0) return 'has_bookings';
        slots.delete(id);
        return 'ok';
      },
    },
  };

  const app = buildServer({
    admin: deps,
    webhookSecret: 'x'.repeat(30),
    logLevel: 'silent',
    debounceMs: 0,
    events: { markIfNew: async () => true },
    queue: { scheduleReply: async () => {} },
  });

  async function loginAs(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { email, password } });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    return { res, cookie: cookie ? `${SESSION_COOKIE}=${cookie.value}` : '' };
  }

  return { app, deps, kb, slots, leads, bookings, reportCalls, loginAs, users, sessions, getSettings: () => settings };
}

/** Atalho: painel falso já logado como dono da academia 1. */
export async function fakeAdminForTests() {
  const admin = await fakeAdmin();
  const { cookie } = await admin.loginAs('dono@ciadaforma.com.br', 'senha-forte-123');
  return { ...admin, cookie, kbVersion: async () => admin.kb.get(1)!.version };
}
