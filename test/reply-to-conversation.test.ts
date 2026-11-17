import { describe, expect, it } from 'vitest';
import type { AgentMessage, LlmClient, LlmTurn } from '../src/modules/agent/ports.js';
import type {
  AgentRunRecord,
  ConversationGateway,
  ConversationLock,
  ConversationSnapshot,
  Tenant,
} from '../src/modules/conversation/ports.js';
import {
  ConversationBusyError,
  HANDOFF_MESSAGE,
  handleExhaustedReply,
  replyToConversation,
  type ReplyDeps,
} from '../src/modules/conversation/reply-to-conversation.js';
import type { UpsertLeadInput } from '../src/modules/leads/ports.js';

const JOB = { accountId: 1, conversationId: 77 };

function scriptedLlm(turns: LlmTurn[]): LlmClient & { systems: string[] } {
  let i = 0;
  const systems: string[] = [];
  return {
    systems,
    async complete(req) {
      systems.push(req.system.cached + '\n' + req.system.turn);
      const turn = turns[i++];
      if (!turn) throw new Error('roteiro acabou');
      return turn;
    },
  };
}

function setup(opts: {
  turns: LlmTurn[];
  history?: AgentMessage[];
  hasReplies?: boolean;
  tenant?: Tenant | null;
  lockFree?: boolean;
}) {
  const optOuts: boolean[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const opened: number[] = [];
  const runs: AgentRunRecord[] = [];
  const handoffs: string[] = [];
  const leads: UpsertLeadInput[] = [];
  let released = 0;

  const snapshot: ConversationSnapshot = {
    contact: { chatwootContactId: 5, phone: '+5541999990000', name: 'Ana' },
    history: opts.history ?? [{ role: 'user', content: 'Quanto custa o mensal?' }],
    hasReplies: opts.hasReplies ?? false,
  };
  const conversations: ConversationGateway = {
    async load() {
      return snapshot;
    },
    async sendReply(_a, _c, text) {
      sent.push(text);
    },
  };
  const lock: ConversationLock = {
    async acquire() {
      if (opts.lockFree === false) return null;
      return async () => {
        released++;
      };
    },
  };
  const llm = scriptedLlm(opts.turns);

  const deps: ReplyDeps = {
    llm,
    model: 'modelo-teste',
    maxSteps: 3,
    tenants: {
      async findByChatwootAccount() {
        return opts.tenant === undefined
          ? { id: 10, name: 'Cia da Forma', timeZone: 'America/Sao_Paulo', privacyUrl: 'https://ciadaforma.com.br/privacidade' }
          : opts.tenant;
      },
    },
    knowledge: {
      async getActive() {
        return { version: 4, items: [{ category: 'Planos', content: 'Mensal: R$ 120' }] };
      },
    },
    conversations,
    runs: {
      async record(run) {
        runs.push(run);
      },
    },
    lock,
    leads: {
      async upsertByPhone(input) {
        leads.push(input);
        return { id: 1, created: true };
      },
      async setOptOut(input) {
        optOuts.push(input.optedOut);
      },
    },
    handoff: {
      inbox: {
        async addPrivateNote(_a, _c, note) {
          notes.push(note);
        },
        async assignToTeam(_a, conversationId) {
          opened.push(conversationId);
        },
      },
      handoffs: {
        async record(_c, reason) {
          handoffs.push(reason);
        },
      },
    },
    booking: {
      now: () => new Date('2026-11-16T13:00:00Z'),
      reminders: { schedule: async () => 'job-1', cancel: async () => {} },
      bookings: {
        listAvailable: async () => [],
        book: async () => ({ kind: 'not_available' }),
        setReminderJob: async () => {},
        cancelActive: async () => ({ kind: 'none' }),
        getForReminder: async () => null,
        markReminderSent: async () => true,
        clearReminderSent: async () => {},
      },
    },
    now: () => new Date('2026-11-16T13:00:00Z'),
  };

  return { deps, llm, sent, notes, opened, runs, handoffs, leads, optOuts, released: () => released };
}

describe('replyToConversation', () => {
  it('responde com o texto da IA e registra a execução', async () => {
    const t = setup({ turns: [{ type: 'text', text: 'O mensal custa R$ 120.', usage: { inputTokens: 900, outputTokens: 20 } }] });
    const outcome = await replyToConversation(t.deps, JOB);

    expect(outcome).toBe('reply');
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.startsWith('O mensal custa R$ 120.')).toBe(true);
    expect(t.runs[0]).toMatchObject({
      tenantId: 10,
      costUsd: null,
      outcome: 'reply',
      inputTokens: 900,
      outputTokens: 20,
      knowledgeVersion: 4,
      model: 'modelo-teste',
    });
    expect(t.released()).toBe(1);
  });

  it('coloca a base e o aviso de atendimento automatizado no prompt da primeira resposta', async () => {
    const t = setup({ turns: [{ type: 'text', text: 'Oi!' }] });
    await replyToConversation(t.deps, JOB);
    expect(t.llm.systems[0]).toContain('Mensal: R$ 120');
    expect(t.llm.systems[0]).toContain('Cia da Forma');
    expect(t.llm.systems[0]).toContain('atendimento automatizado');
  });

  it('não repete o aviso quando a conversa já tem respostas', async () => {
    const t = setup({ turns: [{ type: 'text', text: 'Oi!' }], hasReplies: true });
    await replyToConversation(t.deps, JOB);
    expect(t.llm.systems[0]).not.toContain('primeira resposta');
  });

  it('registra o lead pelo telefone do contato', async () => {
    const t = setup({
      turns: [
        { type: 'tool_calls', calls: [{ id: 'c1', name: 'registrar_lead', input: { objetivo: 'emagrecer' } }] },
        { type: 'text', text: 'Anotado!' },
      ],
    });
    await replyToConversation(t.deps, JOB);
    expect(t.leads).toEqual([
      { tenantId: 10, phone: '+5541999990000', chatwootContactId: 5, name: 'Ana', goal: 'emagrecer', modality: undefined },
    ]);
  });

  it('quando a IA transfere: nota para a equipe, conversa aberta e aviso ao cliente', async () => {
    const t = setup({
      turns: [
        {
          type: 'tool_calls',
          calls: [{ id: 'c1', name: 'transferir_para_humano', input: { motivo: 'quer se matricular', resumo: 'plano mensal' } }],
        },
      ],
    });
    const outcome = await replyToConversation(t.deps, JOB);

    expect(outcome).toBe('handoff_tool');
    expect(t.notes[0]).toContain('quer se matricular');
    expect(t.notes[0]).toContain('plano mensal');
    expect(t.opened).toEqual([77]);
    expect(t.sent[0]!.startsWith(HANDOFF_MESSAGE)).toBe(true);
    expect(t.handoffs).toEqual(['quer se matricular']);
  });

  it('transfere quando a IA passa do limite de passos', async () => {
    const loop: LlmTurn = { type: 'tool_calls', calls: [{ id: 'x', name: 'inexistente', input: {} }] };
    const t = setup({ turns: [loop, loop, loop] });
    const outcome = await replyToConversation(t.deps, JOB);
    expect(outcome).toBe('handoff_max_steps');
    expect(t.opened).toEqual([77]);
    expect(t.sent).toEqual([HANDOFF_MESSAGE]);
  });

  it('não chama a IA quando a academia não está cadastrada', async () => {
    const t = setup({ turns: [], tenant: null });
    const outcome = await replyToConversation(t.deps, JOB);
    expect(outcome).toBe('handoff_no_tenant');
    expect(t.llm.systems).toHaveLength(0);
    expect(t.opened).toEqual([77]);
  });

  it('não responde de novo se a última mensagem já é uma resposta (retentativa)', async () => {
    const t = setup({
      turns: [],
      history: [
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: 'Olá!' },
      ],
    });
    const outcome = await replyToConversation(t.deps, JOB);
    expect(outcome).toBe('skipped');
    expect(t.sent).toHaveLength(0);
  });

  it('acusa conversa ocupada quando não consegue o lock', async () => {
    const t = setup({ turns: [], lockFree: false });
    await expect(replyToConversation(t.deps, JOB)).rejects.toBeInstanceOf(ConversationBusyError);
  });

  it('libera o lock e propaga o erro quando a IA falha', async () => {
    const t = setup({ turns: [] });
    await expect(replyToConversation(t.deps, JOB)).rejects.toThrow('roteiro acabou');
    expect(t.released()).toBe(1);
    expect(t.sent).toHaveLength(0);
  });
});

describe('LGPD na conversa', () => {
  it('primeira resposta leva o aviso com o link de privacidade; as seguintes não', async () => {
    const first = setup({ turns: [{ type: 'text', text: 'Oi!' }] });
    await replyToConversation(first.deps, JOB);
    expect(first.sent[0]).toBe(
      'Oi!\n\n_Atendimento automatizado. Política de privacidade: https://ciadaforma.com.br/privacidade Para não receber lembretes, responda SAIR._',
    );

    const later = setup({ turns: [{ type: 'text', text: 'Oi de novo!' }], hasReplies: true });
    await replyToConversation(later.deps, JOB);
    expect(later.sent).toEqual(['Oi de novo!']);
  });

  it('SAIR marca opt-out e confirma sem chamar a IA; VOLTAR desfaz', async () => {
    const out = setup({ turns: [], history: [{ role: 'user', content: 'Sair!' }] });
    expect(await replyToConversation(out.deps, JOB)).toBe('opt_out');
    expect(out.optOuts).toEqual([true]);
    expect(out.llm.systems).toHaveLength(0);
    expect(out.sent[0]).toContain('não vai mais receber lembretes');

    const back = setup({ turns: [], history: [{ role: 'user', content: 'voltar' }] });
    expect(await replyToConversation(back.deps, JOB)).toBe('opt_in');
    expect(back.optOuts).toEqual([false]);
  });

  it('"quero sair da academia" é conversa normal, não comando', async () => {
    const t = setup({ turns: [{ type: 'text', text: 'Vou chamar a equipe.' }], history: [{ role: 'user', content: 'quero sair da academia' }] });
    expect(await replyToConversation(t.deps, JOB)).toBe('reply');
    expect(t.optOuts).toEqual([]);
  });
});

describe('custo da resposta', () => {
  it('calcula em dólares quando o preço por token está configurado', async () => {
    const t = setup({ turns: [{ type: 'text', text: 'Oi!', usage: { inputTokens: 2_000_000, outputTokens: 100_000 } }] });
    await replyToConversation({ ...t.deps, pricing: { inputUsdPerMTok: 1, outputUsdPerMTok: 5 } }, JOB);
    expect(t.runs[0]!.costUsd).toBeCloseTo(2.5);
  });
});

describe('handleExhaustedReply', () => {
  it('avisa o cliente, transfere e registra a falha', async () => {
    const t = setup({ turns: [] });
    await handleExhaustedReply(t.deps, JOB, 'timeout');
    expect(t.sent).toEqual([HANDOFF_MESSAGE]);
    expect(t.opened).toEqual([77]);
    expect(t.runs[0]).toMatchObject({ outcome: 'handoff_failure', error: 'timeout' });
  });
});
