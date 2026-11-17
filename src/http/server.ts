import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnyEventSchema, MessageCreatedSchema } from '../adapters/chatwoot/webhook-schema.js';
import { handleIncomingEvent, type HandleIncomingEventDeps } from '../modules/conversation/handle-incoming-event.js';
import { safeCompare } from '../shared/safe-compare.js';
import { adminRoutes, type AdminDeps } from './admin-routes.js';
import { runChecks, type HealthCheck } from './health.js';

export interface ServerDeps extends HandleIncomingEventDeps {
  webhookSecret: string;
  logLevel: string;
  /** Rotas do painel; ausente = painel desligado. */
  admin?: AdminDeps;
  /** Pasta com o build do painel (`web/dist`); servida em `/` se existir. */
  webRoot?: string;
  trustProxy?: boolean;
  /** Verificações de `/health/ready` (banco, Redis, worker). */
  healthChecks?: Record<string, HealthCheck>;
}

const ParamsSchema = z.object({ secret: z.string() });

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.logLevel, redact: ['req.url'] }, // a URL carrega o segredo do webhook
    bodyLimit: 1_000_000,
    trustProxy: deps.trustProxy ?? false,
  });

  // Vivo (o processo responde). Usado pelo Docker.
  app.get('/health', async () => ({ status: 'ok' }));

  // Pronto (banco, Redis e worker funcionando). Usado pelo deploy e pelo monitor externo.
  app.get('/health/ready', async (_req, reply) => {
    const checks = await runChecks(deps.healthChecks ?? {});
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });

  app.post('/webhooks/chatwoot/:secret', async (req, reply) => {
    const { secret } = ParamsSchema.parse(req.params);
    if (!safeCompare(secret, deps.webhookSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const base = AnyEventSchema.safeParse(req.body);
    if (!base.success) return reply.code(400).send({ error: 'invalid_payload' });
    if (base.data.event !== 'message_created') return reply.code(200).send({ result: 'ignored_event' });

    const event = MessageCreatedSchema.safeParse(req.body);
    if (!event.success) {
      req.log.warn({ issues: event.error.issues }, 'payload message_created inválido');
      return reply.code(400).send({ error: 'invalid_payload' });
    }

    const result = await handleIncomingEvent(event.data, deps);
    req.log.info({ conversationId: event.data.conversation.id, result: result.kind }, 'evento recebido');
    // Sempre 200 rápido: o trabalho pesado acontece no worker.
    return reply.code(200).send({ result: result.kind });
  });

  if (deps.admin) {
    const admin = deps.admin;
    void app.register(fastifyCookie);
    void app.register((scope) => adminRoutes(scope, admin), { prefix: '/admin/api' });
  }

  if (deps.webRoot && existsSync(deps.webRoot)) {
    void app.register(fastifyStatic, { root: deps.webRoot, prefix: '/', wildcard: false });
    // SPA: GET de página (sem extensão) que não seja API nem webhook devolve o index.html.
    // Arquivo inexistente (ex.: /assets/velho.js) continua 404, para não mascarar erro de deploy.
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? '';
      const isPage = !/\.[a-z0-9]+$/i.test(path);
      if (req.method === 'GET' && isPage && !path.startsWith('/admin/api') && !path.startsWith('/webhooks')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'erro não tratado');
    void reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
