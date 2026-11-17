import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { login, type LoginDeps } from '../modules/auth/login.js';
import type { AdminSession, LoginRateLimiter } from '../modules/auth/ports.js';
import {
  changeOwnPassword,
  createTeamMember,
  MIN_PASSWORD_LENGTH,
  removeTeamMember,
  resetTeamMemberPassword,
} from '../modules/auth/manage-users.js';
import type { LlmClient } from '../modules/agent/ports.js';
import type { AgendaAdminRepository } from '../modules/appointments/admin-ports.js';
import type { AgendaDeps } from '../modules/appointments/agenda.js';
import type { CatalogRepository } from '../modules/appointments/ports.js';
import { agendaRoutes } from './agenda-routes.js';
import { testAgentAnswer } from '../modules/agent/sandbox.js';
import type { UnansweredQuestionRepository } from '../modules/handoff/ports.js';
import { parseKnowledgeDoc } from '../modules/knowledge/import-doc.js';
import type { KnowledgeAdminRepository } from '../modules/knowledge/ports.js';
import type { TenantSettingsRepository } from '../modules/settings/ports.js';
import { BRAZIL_TIME_ZONES, updateSettings } from '../modules/settings/update-settings.js';
import { KNOWLEDGE_LIMITS, replaceKnowledge } from '../modules/knowledge/replace-knowledge.js';
import type { ClientAdminRepository } from '../modules/clients/ports.js';
import { buildMonthlyReport } from '../modules/reports/monthly-report.js';
import type { ReportRepository } from '../modules/reports/ports.js';
import { localParts } from '../shared/time-zone.js';

export const SESSION_COOKIE = 'painel_sid';

export interface AdminDeps extends LoginDeps {
  knowledge: KnowledgeAdminRepository;
  catalog: CatalogRepository;
  agendaAdmin: AgendaAdminRepository;
  agenda: AgendaDeps;
  clients: ClientAdminRepository;
  settings: TenantSettingsRepository;
  unanswered: UnansweredQuestionRepository;
  /** Sem chave do LLM na API, o teste da IA pelo painel fica indisponível (503). */
  llm: LlmClient | null;
  agentMaxSteps: number;
  /** Limite de testes da IA por pessoa. */
  testLimiter: LoginRateLimiter;
  reports: ReportRepository;
  tenantInfo: (tenantId: number) => Promise<{ timeZone: string; chatwootAccountId: number }>;
  /** URL pública do Chatwoot, para o painel linkar conversas e contatos. */
  chatwootPublicUrl: string | null;
  usdBrl: number | null;
  now?: () => Date;
  /** `true` em produção/staging: cookie só trafega em HTTPS. */
  secureCookies: boolean;
  sessionTtlSec: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    adminSession?: AdminSession;
  }
}

const LoginBody = z.object({ email: z.string().max(200), password: z.string().max(200) });

const KnowledgeItems = z
  .array(
    z.object({
      category: z.string().max(KNOWLEDGE_LIMITS.maxCategoryLength * 2),
      content: z.string().max(KNOWLEDGE_LIMITS.maxItemLength * 2),
      active: z.boolean(),
    }),
  )
  .max(KNOWLEDGE_LIMITS.maxItems * 2);
const KnowledgeBody = z.object({ expectedVersion: z.number().int().min(0), items: KnowledgeItems });
const ImportBody = z.object({ markdown: z.string().min(1).max(200_000) });
const TestBody = z.object({ question: z.string().trim().min(2).max(500), items: KnowledgeItems });

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const RangeQuery = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) });
const ClientsQuery = z.object({ q: z.string().max(100).optional() });
const PasswordBody = z.object({ current: z.string().max(200), next: z.string().max(200) });
const SettingsBody = z.object({
  name: z.string().max(200),
  timeZone: z.string().max(60),
  receptionHours: z.object({ open: z.number(), close: z.number() }).nullable(),
  privacyUrl: z.string().max(500).nullable(),
});
const NewUserBody = z.object({ email: z.string().max(200), role: z.enum(['dono', 'recepcao']) });
const ResolvedBody = z.object({ resolved: z.boolean() });
const ReportQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error });
}

/** Rotas do painel em `/admin/api`. Tudo, exceto o login, exige sessão. */
export async function adminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const cookieOptions = {
    path: '/admin/api',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: deps.secureCookies,
    maxAge: deps.sessionTtlSec,
  };

  app.post('/auth/login', async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, 'Informe e-mail e senha.');

    const result = await login(deps, { ...body.data, ip: req.ip });
    if (result.kind === 'rate_limited') {
      return reply
        .code(429)
        .header('retry-after', String(result.retryAfterSec))
        .send({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' });
    }
    if (result.kind === 'invalid') return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });

    req.log.info({ userId: result.session.userId, tenantId: result.session.tenantId }, 'login no painel');
    return reply.setCookie(SESSION_COOKIE, result.token, cookieOptions).send(publicSession(result.session));
  });

  // Daqui para baixo, só com sessão.
  app.register(async (auth) => {
    auth.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.cookies[SESSION_COOKIE];
      const session = token ? await deps.sessions.get(token) : null;
      if (!session) return reply.code(401).send({ error: 'Sessão expirada. Entre de novo.' });
      req.adminSession = session;
      // Com senha provisória, só dá para ver a sessão, trocar a senha ou sair.
      const allowed = ['/admin/api/auth/me', '/admin/api/auth/password', '/admin/api/auth/logout'];
      if (session.mustChangePassword && !allowed.includes(req.routeOptions.url ?? '')) {
        return reply.code(403).send({ error: 'Troque a senha provisória para continuar.', code: 'must_change_password' });
      }
    });

    const ownerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.adminSession?.role !== 'dono') {
        return reply.code(403).send({ error: 'Só o dono do salão pode fazer isso.' });
      }
    };

    agendaRoutes(
      auth,
      { agenda: deps.agenda, admin: deps.agendaAdmin, tenantTimeZone: async (id) => (await deps.tenantInfo(id)).timeZone },
      ownerOnly,
    );

    auth.post('/auth/password', async (req, reply) => {
      const body = PasswordBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Informe a senha atual e a nova.');
      const session = req.adminSession!;
      const result = await changeOwnPassword(deps, session, body.data);
      if (!result.ok) {
        const messages = {
          wrong_current: 'A senha atual não confere.',
          weak: `A nova senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
          same: 'A nova senha precisa ser diferente da atual.',
        };
        return reply.code(result.error === 'wrong_current' ? 403 : 400).send({ error: messages[result.error] });
      }
      // Gira a sessão: nova sem a marca de senha provisória; todas as antigas da pessoa encerradas.
      const token = await deps.sessions.create(result.session);
      await deps.sessions.destroyAllForUser(session.userId, token);
      req.log.info({ userId: session.userId, tenantId: session.tenantId }, 'senha do painel trocada');
      return reply.setCookie(SESSION_COOKIE, token, cookieOptions).send({ ok: true });
    });

    auth.get('/settings', { preHandler: ownerOnly }, async (req) => ({
      ...(await deps.settings.get(req.adminSession!.tenantId)),
      timeZones: BRAZIL_TIME_ZONES,
    }));

    auth.put('/settings', { preHandler: ownerOnly }, async (req, reply) => {
      const body = SettingsBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Dados inválidos.');
      const result = await updateSettings(deps.settings, req.adminSession!.tenantId, body.data);
      if (!result.ok) return badRequest(reply, result.error);
      req.log.info({ tenantId: req.adminSession!.tenantId, userId: req.adminSession!.userId }, 'configurações salvas');
      return { ok: true };
    });

    auth.get('/users', { preHandler: ownerOnly }, async (req) => ({
      users: (await deps.users.listByTenant(req.adminSession!.tenantId)).map((u) => ({
        ...u,
        isMe: u.id === req.adminSession!.userId,
      })),
    }));

    auth.post('/users', { preHandler: ownerOnly }, async (req, reply) => {
      const body = NewUserBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Informe e-mail e papel.');
      const result = await createTeamMember(deps, req.adminSession!, body.data);
      if (!result.ok) return badRequest(reply, result.error);
      req.log.info({ tenantId: req.adminSession!.tenantId, createdUserId: result.id }, 'acesso ao painel criado');
      return reply.code(201).send(result);
    });

    auth.post('/users/:id/reset-password', { preHandler: ownerOnly }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, 'Usuário inválido.');
      const result = await resetTeamMemberPassword(deps, req.adminSession!, params.data.id);
      if (!result.ok) {
        return result.error === 'self'
          ? badRequest(reply, 'Para a sua própria senha, use "Trocar minha senha".')
          : reply.code(404).send({ error: 'Usuário não encontrado.' });
      }
      return result;
    });

    auth.delete('/users/:id', { preHandler: ownerOnly }, async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, 'Usuário inválido.');
      const result = await removeTeamMember(deps, req.adminSession!, params.data.id);
      if (result === 'self') return badRequest(reply, 'Você não pode remover o próprio acesso.');
      if (result === 'last_owner') return reply.code(409).send({ error: 'O salão precisa de pelo menos um dono.' });
      if (result === 'not_found') return reply.code(404).send({ error: 'Usuário não encontrado.' });
      return { ok: true };
    });

    auth.post('/auth/logout', async (req, reply) => {
      const token = req.cookies[SESSION_COOKIE];
      if (token) await deps.sessions.destroy(token);
      return reply.clearCookie(SESSION_COOKIE, { path: cookieOptions.path }).send({ ok: true });
    });

    auth.get('/auth/me', async (req) => {
      const session = req.adminSession!;
      const info = await deps.tenantInfo(session.tenantId);
      return {
        ...publicSession(session),
        mustChangePassword: session.mustChangePassword,
        timeZone: info.timeZone,
        chatwootAccountUrl: deps.chatwootPublicUrl
          ? `${deps.chatwootPublicUrl.replace(/\/$/, '')}/app/accounts/${info.chatwootAccountId}`
          : null,
      };
    });

    auth.get('/knowledge', async (req) => deps.knowledge.getForEdit(req.adminSession!.tenantId));

    auth.get('/knowledge/versions', async (req) => ({
      versions: await deps.knowledge.listVersions(req.adminSession!.tenantId, 50),
    }));

    auth.get('/knowledge/versions/:id', async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      if (!params.success) return badRequest(reply, 'Versão inválida.');
      const version = await deps.knowledge.getVersion(req.adminSession!.tenantId, params.data.id);
      if (!version) return reply.code(404).send({ error: 'Versão não encontrada.' });
      return version;
    });

    auth.post('/knowledge/import/preview', async (req, reply) => {
      const body = ImportBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Envie o arquivo .md exportado do documento.');
      const doc = parseKnowledgeDoc(body.data.markdown);
      return {
        items: doc.items,
        pending: doc.pending,
        warnings: doc.warnings,
        receptionHours: doc.receptionHours,
        evalCaseCount: doc.evalCases.length,
      };
    });

    auth.post('/knowledge/test', async (req, reply) => {
      if (!deps.llm) {
        return reply.code(503).send({ error: 'O teste da IA não está ligado neste servidor (falta a chave do modelo).' });
      }
      const body = TestBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Escreva uma pergunta de até 500 caracteres.');
      const { tenantId, userId } = req.adminSession!;
      const gate = await deps.testLimiter.hit(`kbtest:${userId}`);
      if (!gate.allowed) {
        return reply
          .code(429)
          .send({ error: `Limite de testes da hora atingido. Tente de novo em ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      }
      const info = await deps.tenantInfo(tenantId);
      const settings = await deps.settings.get(tenantId);
      try {
        const result = await testAgentAnswer(deps.llm, {
          tenantId,
          salonName: settings.name,
          timeZone: info.timeZone,
          now: deps.now?.() ?? new Date(),
          question: body.data.question,
          items: body.data.items
            .filter((i) => i.active && i.category.trim() && i.content.trim())
            .map((i) => ({ category: i.category.trim(), content: i.content.trim() })),
          maxSteps: deps.agentMaxSteps,
          catalog: deps.catalog,
        });
        req.log.info({ tenantId, userId, tools: result.toolCalls.map((c) => c.name), usage: result.usage }, 'teste da IA');
        return result;
      } catch (err) {
        req.log.warn({ err, tenantId }, 'teste da IA falhou');
        return reply.code(502).send({ error: 'A IA não respondeu agora. Tente de novo em instantes.' });
      }
    });

    auth.put('/knowledge', async (req, reply) => {
      const body = KnowledgeBody.safeParse(req.body);
      if (!body.success) return badRequest(reply, 'Dados inválidos.');
      const { tenantId, userId, email } = req.adminSession!;

      const result = await replaceKnowledge(deps.knowledge, tenantId, body.data.expectedVersion, body.data.items, email);
      if (!result.ok && 'error' in result) return badRequest(reply, result.error);
      if (!result.ok) {
        return reply.code(409).send({
          error: 'Outra pessoa salvou a base enquanto você editava. Recarregue para ver a versão atual.',
          currentVersion: result.currentVersion,
        });
      }
      req.log.info({ tenantId, userId, version: result.version }, 'base de conhecimento salva');
      return result;
    });

    auth.get('/clients', async (req, reply) => {
      const q = ClientsQuery.safeParse(req.query);
      if (!q.success) return badRequest(reply, 'Filtro inválido.');
      const now = deps.now?.() ?? new Date();
      return { clients: await deps.clients.list(req.adminSession!.tenantId, { search: q.data.q, now, limit: 200 }) };
    });

    auth.get('/report', async (req, reply) => {
      const q = ReportQuery.safeParse(req.query);
      if (!q.success) return badRequest(reply, 'Mês inválido (use AAAA-MM).');
      const { tenantId } = req.adminSession!;
      const { timeZone } = await deps.tenantInfo(tenantId);
      const now = deps.now?.() ?? new Date();
      const local = localParts(now, timeZone);
      const month = q.data.month ?? `${local.year}-${String(local.month).padStart(2, '0')}`;
      const report = await buildMonthlyReport(deps.reports, { tenantId, timeZone, month, now, usdBrl: deps.usdBrl });
      return { ...report, timeZone };
    });

    auth.get('/unanswered', async (req, reply) => {
      const range = RangeQuery.safeParse(req.query);
      if (!range.success) return badRequest(reply, 'Período inválido.');
      const items = await deps.unanswered.list(
        req.adminSession!.tenantId,
        new Date(range.data.from),
        new Date(range.data.to),
        200,
      );
      return { items };
    });

    auth.patch('/unanswered/:id', async (req, reply) => {
      const params = IdParams.safeParse(req.params);
      const body = ResolvedBody.safeParse(req.body);
      if (!params.success || !body.success) return badRequest(reply, 'Dados inválidos.');
      const ok = await deps.unanswered.setResolved(
        req.adminSession!.tenantId,
        params.data.id,
        body.data.resolved,
        deps.now?.() ?? new Date(),
      );
      if (!ok) return reply.code(404).send({ error: 'Pergunta não encontrada.' });
      return { ok: true };
    });
  });
}

function publicSession(s: AdminSession) {
  return { email: s.email, role: s.role };
}
