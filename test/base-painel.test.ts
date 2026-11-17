import { InMemoryAgenda } from '../src/modules/appointments/in-memory.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fakeAdminForTests } from './helpers/fake-admin.js';
import type { LlmClient, LlmTurn } from '../src/modules/agent/ports.js';
import { testAgentAnswer } from '../src/modules/agent/sandbox.js';

const NOW = new Date('2026-11-16T14:00:00-03:00');
const agenda = new InMemoryAgenda();
const corte = agenda.addService({ name: 'Corte', durationMin: 60, priceCents: 8000 });
agenda.addProfessional('Ana', [corte.id], [{ weekday: 2, startMin: 9 * 60, endMin: 12 * 60 }]); // terças de manhã

/** LLM roteirizado: devolve os turnos na ordem e guarda o que recebeu. */
function scripted(turns: LlmTurn[]) {
  const seen: Parameters<LlmClient['complete']>[0][] = [];
  const llm: LlmClient = {
    complete: async (req) => {
      seen.push(req);
      const t = turns.shift();
      if (!t) throw new Error('sem turno');
      return t;
    },
  };
  return { llm, seen };
}

const base = {
  tenantId: 1,
  salonName: 'Studio Aurora',
  timeZone: 'America/Sao_Paulo',
  now: NOW,
  maxSteps: 4,
  catalog: agenda,
};

describe('testAgentAnswer (teste da IA pelo painel)', () => {
  it('usa a base do editor no prompt e devolve a resposta', async () => {
    const { llm, seen } = scripted([{ type: 'text', text: ' Mensal R$ 149,90. ' }]);
    const r = await testAgentAnswer(llm, { ...base, question: 'quanto custa?', items: [{ category: 'Planos', content: 'Mensal R$ 149,90' }] });
    expect(r).toEqual({ reply: 'Mensal R$ 149,90.', handoff: null, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } });
    expect(seen[0]!.system.cached).toContain('Mensal R$ 149,90');
    expect(seen[0]!.messages).toEqual([{ role: 'user', content: 'quanto custa?' }]);
  });

  it('transferência vira aviso, com a pergunta higienizada, sem tocar em nada', async () => {
    const { llm } = scripted([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'transferir_para_humano', input: { motivo: 'Não está na base', pergunta_sem_resposta: 'Tem natação? 41999991234' } }],
      },
    ]);
    const r = await testAgentAnswer(llm, { ...base, question: 'tem natação?', items: [] });
    expect(r.reply).toBeNull();
    expect(r.handoff).toEqual({ reason: 'Não está na base', question: 'Tem natação? [removido]' });
    expect(r.toolCalls.map((c) => c.name)).toEqual(['transferir_para_humano']);
  });

  it('agendamento é simulado com o cadastro real e a conversa continua', async () => {
    const { llm } = scripted([
      { type: 'tool_calls', calls: [{ id: 'c1', name: 'consultar_horarios', input: { servico_id: corte.id } }] },
      { type: 'tool_calls', calls: [{ id: 'c2', name: 'agendar_servico', input: { servico_id: corte.id, profissional_id: 1, inicio: '2026-11-17T10:00' } }] },
      { type: 'text', text: 'Agendado!' },
    ]);
    const r = await testAgentAnswer(llm, { ...base, question: 'quero cortar o cabelo', items: [] });
    expect(r.reply).toBe('Agendado!');
    expect(r.toolCalls.map((c) => c.name)).toEqual(['consultar_horarios', 'agendar_servico']);
    // simulado: nada foi gravado na agenda
    expect(await agenda.listUpcoming(1, '+550000000000', new Date(0))).toEqual([]);
  });
});

describe('rotas: importar o documento e testar a IA', () => {
  const md = readFileSync(new URL('./fixtures/base-preenchida.md', import.meta.url), 'utf8');

  it('pré-visualiza o documento sem gravar nada', async () => {
    const { app, cookie, kbVersion } = await fakeAdminForTests();
    const r = await app.inject({ method: 'POST', url: '/admin/api/knowledge/import/preview', headers: { cookie }, payload: { markdown: md } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.items).toHaveLength(5);
    expect(body.receptionHours).toEqual({ open: 7, close: 21 });
    expect(body.slotCount).toBeGreaterThan(0);
    expect(body.warnings).toHaveLength(1);
    expect(await kbVersion()).toBe(1);
  });

  it('cria os horários da experimental uma vez só', async () => {
    const { app, cookie } = await fakeAdminForTests();
    const post = () =>
      app.inject({ method: 'POST', url: '/admin/api/knowledge/import/schedule', headers: { cookie }, payload: { markdown: md, weeks: 1 } });
    const first = (await post()).json();
    expect(first.created).toBe(15);
    expect((await post()).json()).toEqual({ created: 0, skipped: 15 });
  });

  it('teste da IA: 503 sem chave, resposta com chave, 429 no limite', async () => {
    const { app, cookie, deps } = await fakeAdminForTests();
    const payload = { question: 'quanto custa?', items: [{ category: 'Planos', content: 'Mensal R$ 149,90', active: true }] };
    const send = () => app.inject({ method: 'POST', url: '/admin/api/knowledge/test', headers: { cookie }, payload });
    expect((await send()).statusCode).toBe(503);

    deps.llm = scripted([{ type: 'text', text: 'R$ 149,90' }]).llm;
    expect((await send()).json()).toMatchObject({ reply: 'R$ 149,90', handoff: null });

    deps.testLimiter = { hit: async () => ({ allowed: false, retryAfterSec: 600 }), reset: async () => {} };
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toContain('10 min');
  });
});
