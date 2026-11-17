import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type LlmClient, type LlmTurn } from '../src/modules/agent/ports.js';
import { runAgent } from '../src/modules/agent/run-agent.js';

/** LLM falso que devolve turnos pré-programados, em ordem. */
function scriptedLlm(turns: LlmTurn[]): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    async complete(): Promise<LlmTurn> {
      const turn = turns[llm.calls++];
      if (!turn) throw new Error('roteiro do LLM acabou');
      return turn;
    },
  };
  return llm;
}

const registered: string[] = [];
const registrarLead = defineTool({
  spec: { name: 'registrar_lead', description: 'Salva o lead', inputJsonSchema: {} },
  input: z.object({ nome: z.string().min(1) }),
  async run(input) {
    registered.push(input.nome);
    return 'lead registrado';
  },
});

const transferir = defineTool({
  spec: { name: 'transferir_para_humano', description: 'Passa para a equipe', inputJsonSchema: {} },
  input: z.object({ motivo: z.string() }),
  endsConversation: true,
  async run() {
    return 'transferido';
  },
});

const base = {
  system: { cached: 'Você é a atendente da academia.', turn: '' },
  history: [{ role: 'user' as const, content: 'Oi, sou a Ana' }],
  tools: [registrarLead, transferir],
  maxSteps: 3,
  ctx: {
    tenantId: 1,
    timeZone: 'America/Sao_Paulo',
    accountId: 1,
    conversationId: 55,
    contact: { chatwootContactId: 9, phone: '+5541999990000', name: 'Ana' },
  },
};

describe('runAgent', () => {
  it('responde direto quando o modelo devolve texto', async () => {
    const llm = scriptedLlm([{ type: 'text', text: '  Olá, Ana!  ' }]);
    const out = await runAgent(llm, base);
    expect(out).toMatchObject({ kind: 'reply', text: 'Olá, Ana!', steps: 1, toolsUsed: [] });
  });

  it('executa a ferramenta e depois responde', async () => {
    const llm = scriptedLlm([
      { type: 'tool_calls', calls: [{ id: 'c1', name: 'registrar_lead', input: { nome: 'Ana' } }] },
      { type: 'text', text: 'Anotado!' },
    ]);
    const out = await runAgent(llm, base);
    expect(out).toMatchObject({ kind: 'reply', text: 'Anotado!', steps: 2, toolsUsed: ['registrar_lead'] });
    expect(registered).toContain('Ana');
  });

  it('input inválido volta como erro para o modelo, sem executar a ferramenta', async () => {
    const before = registered.length;
    const llm = scriptedLlm([
      { type: 'tool_calls', calls: [{ id: 'c1', name: 'registrar_lead', input: { nome: '' } }] },
      { type: 'text', text: 'Qual é o seu nome?' },
    ]);
    const out = await runAgent(llm, base);
    expect(out.kind).toBe('reply');
    expect(registered.length).toBe(before);
  });

  it('transfere para humano quando a ferramenta encerra a conversa', async () => {
    const llm = scriptedLlm([
      { type: 'tool_calls', calls: [{ id: 'c1', name: 'transferir_para_humano', input: { motivo: 'matrícula' } }] },
    ]);
    const out = await runAgent(llm, base);
    expect(out).toMatchObject({ kind: 'handoff', reason: 'tool' });
  });

  it('soma o uso de tokens de todos os passos', async () => {
    const llm = scriptedLlm([
      {
        type: 'tool_calls',
        calls: [{ id: 'c1', name: 'registrar_lead', input: { nome: 'Bia' } }],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      { type: 'text', text: 'Pronto!', usage: { inputTokens: 120, outputTokens: 5 } },
    ]);
    const out = await runAgent(llm, base);
    expect(out.usage).toEqual({ inputTokens: 220, outputTokens: 15 });
  });

  it('transfere quando passa do limite de passos', async () => {
    const loop: LlmTurn = { type: 'tool_calls', calls: [{ id: 'x', name: 'desconhecida', input: {} }] };
    const llm = scriptedLlm([loop, loop, loop, loop]);
    const out = await runAgent(llm, base);
    expect(out).toMatchObject({ kind: 'handoff', reason: 'max_steps', steps: 3 });
    expect(llm.calls).toBe(3);
  });
});
