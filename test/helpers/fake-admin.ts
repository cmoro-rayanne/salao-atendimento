import type { AgendaAdminRepository } from '../../src/modules/appointments/admin-ports.js';
import { InMemoryAgenda } from '../../src/modules/appointments/in-memory.js';
import { ScryptPasswordHasher } from '../../src/adapters/crypto/scrypt-hasher.js';
import { SESSION_COOKIE, type AdminDeps } from '../../src/http/admin-routes.js';
import { buildServer } from '../../src/http/server.js';
import type { AdminSession, AdminUser } from '../../src/modules/auth/ports.js';
import type { EditableKnowledgeItem } from '../../src/modules/knowledge/ports.js';
import type { ClientListItem } from '../../src/modules/clients/ports.js';
import type { MonthlyRawData, ReportRange } from '../../src/modules/reports/ports.js';

const hasher = new ScryptPasswordHasher();

/** Painel com repositórios em memória, separados por salão (tenant). */
export async function fakeAdmin(overrides: Partial<AdminDeps> = {}) {
  const users: AdminUser[] = [
    { id: 1, tenantId: 1, email: 'dono@aurora.com.br', passwordHash: await hasher.hash('senha-forte-123'), role: 'dono', mustChangePassword: false },
    { id: 2, tenantId: 2, email: 'dono@outra.com.br', passwordHash: await hasher.hash('outra-senha-123'), role: 'dono', mustChangePassword: false },
    { id: 3, tenantId: 1, email: 'recepcao@aurora.com.br', passwordHash: await hasher.hash('recepcao-123456'), role: 'recepcao', mustChangePassword: false },
  ];
  const sessions = new Map<string, AdminSession>();
  let settings = { name: 'Studio Aurora', timeZone: 'America/Sao_Paulo', receptionHours: null as { open: number; close: number } | null, privacyUrl: null as string | null, lateToleranceMin: 15 };
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
    [2, { version: 1, items: [{ id: 2, category: 'Segredo', content: 'do outro salão', active: true }] }],
  ]);
  let nextId = 100;
  const NOW = new Date('2026-11-16T15:00:00Z');
  const clients: Array<ClientListItem & { tenantId: number }> = [
    { tenantId: 1, id: 1, name: 'Carla', phone: '+5541999990001', chatwootContactId: 5, nextAppointment: null, completed: 2, noShows: 1, optedOut: false, updatedAt: NOW },
    { tenantId: 2, id: 2, name: 'De outro salão', phone: '+5541999990002', chatwootContactId: 6, nextAppointment: null, completed: 0, noShows: 0, optedOut: false, updatedAt: NOW },
  ];
  const reportCalls: ReportRange[] = [];
  const questions = [
    { tenantId: 1, id: 1, question: 'Tem natação?', conversationId: 77, createdAt: NOW, resolvedAt: null as Date | null },
    { tenantId: 2, id: 2, question: 'Tem crossfit?', conversationId: 88, createdAt: NOW, resolvedAt: null as Date | null },
  ];

  const agendaMemory = new InMemoryAgenda();
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
    clients: {
      list: async (tenantId, q) =>
        clients
          .filter((c) => c.tenantId === tenantId && (!q.search || (c.name ?? '').toLowerCase().includes(q.search.toLowerCase())))
          .map((c) => ({ id: c.id, name: c.name, phone: c.phone, chatwootContactId: c.chatwootContactId, nextAppointment: c.nextAppointment, completed: c.completed, noShows: c.noShows, optedOut: c.optedOut, updatedAt: c.updatedAt })),
    },
    reports: {
      monthlyRaw: async (range): Promise<MonthlyRawData> => {
        reportCalls.push(range);
        return {
          conversations: 10, conversationsWithoutHandoff: 7,
          handoffReasons: [{ reason: 'quer se matricular', count: 2 }, { reason: 'informação não está na base', count: 1 }],
          appointments: { scheduled: 4, completed: 2, noShow: 1, cancelled: 1 },
          topServices: [{ name: 'Corte', count: 3 }, { name: 'Escova', count: 1 }],
          conversationsByHour: Array.from({ length: 24 }, (_, h) => (h === 22 ? 4 : h === 10 ? 6 : 0)),
          aiCostUsd: 2, medianLatencyMs: 5400, receptionHours: { open: 7, close: 21 },
        };
      },
    },
    catalog: agendaMemory,
    // Rotas de agenda são exercitadas contra o Postgres em test/integration/painel-salao.test.ts.
    agendaAdmin: {} as AgendaAdminRepository,
    agenda: { catalog: agendaMemory, appointments: agendaMemory, reminders: { schedule: async () => 'x', cancel: async () => {} }, now: () => NOW },
    ...overrides,
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

  return { app, deps, kb, clients, reportCalls, loginAs, users, sessions, getSettings: () => settings };
}

/** Atalho: painel falso já logado como dono do salão 1. */
export async function fakeAdminForTests() {
  const admin = await fakeAdmin();
  const { cookie } = await admin.loginAs('dono@aurora.com.br', 'senha-forte-123');
  return { ...admin, cookie, kbVersion: async () => admin.kb.get(1)!.version };
}
