import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import type { ReplyJob } from '../src/modules/conversation/ports.js';

const SECRET = 'segredo-de-teste-com-mais-de-24-caracteres';

function app() {
  const jobs: ReplyJob[] = [];
  const seen = new Set<string>();
  const server = buildServer({
    webhookSecret: SECRET,
    logLevel: 'silent',
    debounceMs: 0,
    events: {
      async markIfNew(id) {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    },
    queue: {
      async scheduleReply(job) {
        jobs.push(job);
      },
    },
  });
  return { server, jobs };
}

const payload = {
  event: 'message_created',
  id: 9,
  content: 'oi',
  message_type: 'incoming',
  account: { id: 1 },
  conversation: { id: 7, status: 'pending' },
};

describe('POST /webhooks/chatwoot/:secret', () => {
  it('recusa segredo errado', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/webhooks/chatwoot/errado', payload });
    expect(res.statusCode).toBe(401);
  });

  it('aceita e agenda com o segredo certo', async () => {
    const { server, jobs } = app();
    const res = await server.inject({ method: 'POST', url: `/webhooks/chatwoot/${SECRET}`, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'scheduled' });
    expect(jobs).toEqual([{ accountId: 1, conversationId: 7 }]);
  });

  it('ignora outros eventos com 200', async () => {
    const { server } = app();
    const res = await server.inject({
      method: 'POST',
      url: `/webhooks/chatwoot/${SECRET}`,
      payload: { event: 'conversation_status_changed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ignored_event' });
  });

  it('recusa payload malformado com 400', async () => {
    const { server } = app();
    const res = await server.inject({
      method: 'POST',
      url: `/webhooks/chatwoot/${SECRET}`,
      payload: { event: 'message_created', id: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /health/ready', () => {
  it('200 quando tudo responde; 503 com o nome do que falhou', async () => {
    const base = {
      webhookSecret: 'x'.repeat(30),
      logLevel: 'silent',
      debounceMs: 0,
      events: { markIfNew: async () => true },
      queue: { scheduleReply: async () => {} },
    };
    const ok = buildServer({ ...base, healthChecks: { database: async () => true, worker: async () => true } });
    expect((await ok.inject({ method: 'GET', url: '/health/ready' })).json()).toEqual({
      status: 'ok',
      checks: { database: true, worker: true },
    });

    const bad = buildServer({
      ...base,
      healthChecks: {
        database: async () => true,
        worker: async () => false,
        redis: async () => {
          throw new Error('fora');
        },
      },
    });
    const res = await bad.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', checks: { database: true, worker: false, redis: false } });
  });
});
