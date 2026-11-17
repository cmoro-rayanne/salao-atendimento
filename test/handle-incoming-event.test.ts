import { describe, expect, it } from 'vitest';
import type { MessageCreated } from '../src/adapters/chatwoot/webhook-schema.js';
import { handleIncomingEvent } from '../src/modules/conversation/handle-incoming-event.js';
import type { ConversationQueue, ProcessedEventStore, ReplyJob } from '../src/modules/conversation/ports.js';

class MemoryEvents implements ProcessedEventStore {
  readonly seen = new Set<string>();
  async markIfNew(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

class MemoryQueue implements ConversationQueue {
  readonly jobs: ReplyJob[] = [];
  async scheduleReply(job: ReplyJob): Promise<void> {
    this.jobs.push(job);
  }
}

function event(overrides: Partial<MessageCreated> = {}): MessageCreated {
  return {
    event: 'message_created',
    id: 101,
    content: 'Quanto custa o plano mensal?',
    message_type: 'incoming',
    account: { id: 1 },
    conversation: { id: 55, status: 'pending' },
    ...overrides,
  };
}

function setup() {
  const events = new MemoryEvents();
  const queue = new MemoryQueue();
  return { events, queue, deps: { events, queue, debounceMs: 4000 } };
}

describe('handleIncomingEvent', () => {
  it('agenda resposta para mensagem recebida em conversa com o bot', async () => {
    const { deps, queue } = setup();
    const result = await handleIncomingEvent(event(), deps);
    expect(result).toEqual({ kind: 'scheduled', conversationId: 55 });
    expect(queue.jobs).toEqual([{ accountId: 1, conversationId: 55 }]);
  });

  it('não responde duas vezes ao mesmo evento (reentrega do webhook)', async () => {
    const { deps, queue } = setup();
    await handleIncomingEvent(event(), deps);
    const second = await handleIncomingEvent(event(), deps);
    expect(second).toEqual({ kind: 'duplicate' });
    expect(queue.jobs).toHaveLength(1);
  });

  it('ignora conversa que está com a equipe', async () => {
    const { deps, queue } = setup();
    const result = await handleIncomingEvent(event({ conversation: { id: 55, status: 'open' } }), deps);
    expect(result).toEqual({ kind: 'ignored', reason: 'with_human' });
    expect(queue.jobs).toHaveLength(0);
  });

  it('ignora mensagens enviadas pelo próprio bot ou pela equipe', async () => {
    const { deps } = setup();
    const result = await handleIncomingEvent(event({ message_type: 'outgoing' }), deps);
    expect(result).toEqual({ kind: 'ignored', reason: 'not_incoming' });
  });

  it('ignora notas privadas', async () => {
    const { deps } = setup();
    const result = await handleIncomingEvent(event({ private: true }), deps);
    expect(result).toEqual({ kind: 'ignored', reason: 'private_note' });
  });
});

describe('limite por conversa', () => {
  it('acima do limite não agenda resposta e alerta uma vez', async () => {
    const { events, queue } = setup();
    const alerts: string[] = [];
    let n = 0;
    const deps = {
      events,
      queue,
      debounceMs: 0,
      rateLimiter: {
        hit: async () => {
          n++;
          return { allowed: n <= 2, firstExceeded: n === 3 };
        },
      },
      alerts: { notify: async (a: { key: string }) => void alerts.push(a.key) },
    };
    const results = [];
    for (let i = 1; i <= 4; i++) results.push((await handleIncomingEvent(event({ id: i }), deps)).kind);
    expect(results).toEqual(['scheduled', 'scheduled', 'rate_limited', 'rate_limited']);
    expect(alerts).toEqual(['rate-limit:55']);
  });

  it('evento duplicado não conta no limite', async () => {
    const { events, queue } = setup();
    let hits = 0;
    const deps = { events, queue, debounceMs: 0, rateLimiter: { hit: async () => (hits++, { allowed: true, firstExceeded: false }) } };
    await handleIncomingEvent(event(), deps);
    await handleIncomingEvent(event(), deps);
    expect(hits).toBe(1);
  });
});
