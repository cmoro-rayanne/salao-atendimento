import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatwootMessage } from '../src/adapters/chatwoot/chatwoot-client.js';
import { toAgentHistory } from '../src/adapters/chatwoot/chatwoot-gateway.js';
import { AnthropicLlmClient, LlmError, toApiMessages } from '../src/adapters/llm/anthropic-client.js';
import { buildSystemPrompt } from '../src/modules/agent/prompt.js';

function msg(id: number, type: number, content: string | null, extra: Partial<ChatwootMessage> = {}): ChatwootMessage {
  return { id, message_type: type, content, created_at: id, ...extra };
}

describe('toAgentHistory', () => {
  it('converte, ordena, ignora notas privadas e eventos, e começa pelo cliente', () => {
    const history = toAgentHistory([
      msg(3, 1, 'Olá! Sou a assistente.'),
      msg(1, 1, 'Mensagem antiga do bot'),
      msg(2, 0, 'oi'),
      msg(4, 1, 'nota interna', { private: true }),
      msg(5, 2, 'Conversa atribuída'),
      msg(6, 0, 'quanto custa?'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'Olá! Sou a assistente.' },
      { role: 'user', content: 'quanto custa?' },
    ]);
  });

  it('limita às últimas 20 mensagens', () => {
    const many = Array.from({ length: 30 }, (_, i) => msg(i + 1, 0, `m${i + 1}`));
    const history = toAgentHistory(many);
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: 'user', content: 'm11' });
  });
});

describe('toApiMessages', () => {
  it('junta mensagens seguidas do mesmo papel e põe resultados de ferramenta no turno do usuário', () => {
    const out = toApiMessages([
      { role: 'user', content: 'oi' },
      { role: 'user', content: 'quanto custa?' },
      { role: 'assistant_tool_calls', calls: [{ id: 't1', name: 'registrar_lead', input: { nome: 'Ana' } }] },
      { role: 'tool_result', callId: 't1', content: 'ok', isError: false },
    ]);
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'oi' },
          { type: 'text', text: 'quanto custa?' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'registrar_lead', input: { nome: 'Ana' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
    ]);
  });
});

describe('AnthropicLlmClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = {
    system: { cached: 'regras + base', turn: 'Agora: segunda' },
    messages: [{ role: 'user' as const, content: 'oi' }],
    tools: [{ name: 'registrar_lead', description: 'd', inputJsonSchema: { type: 'object' } }],
  };

  it('envia o system com cache e devolve tool_calls com uso de tokens', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        content: [
          { type: 'text', text: 'Vou anotar.' },
          { type: 'tool_use', id: 't1', name: 'registrar_lead', input: { nome: 'Ana' } },
        ],
        usage: { input_tokens: 50, output_tokens: 7 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const turn = await new AnthropicLlmClient('chave', 'modelo-x').complete(request);
    expect(turn).toEqual({
      type: 'tool_calls',
      calls: [{ id: 't1', name: 'registrar_lead', input: { nome: 'Ana' } }],
      usage: { inputTokens: 50, outputTokens: 7 },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('modelo-x');
    expect(body.system[0]).toEqual({ type: 'text', text: 'regras + base', cache_control: { type: 'ephemeral' } });
    expect(body.system[1]).toEqual({ type: 'text', text: 'Agora: segunda' });
    expect(body.tools[0]).toEqual({ name: 'registrar_lead', description: 'd', input_schema: { type: 'object' } });
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('chave');
  });

  it('marca 429 como erro que vale tentar de novo e 400 como definitivo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    await expect(new AnthropicLlmClient('k', 'm').complete(request)).rejects.toMatchObject({ retryable: true });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    const err = await new AnthropicLlmClient('k', 'm').complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ retryable: false });
  });
});

describe('buildSystemPrompt', () => {
  it('mantém a parte cacheável estável e põe a hora local na parte do turno', () => {
    const input = {
      salonName: 'Cia da Forma',
      knowledge: { version: 2, items: [{ category: 'Horários', content: 'Seg a sex, 6h às 22h' }] },
      timeZone: 'America/Sao_Paulo',
      isFirstReply: false,
    };
    const a = buildSystemPrompt({ ...input, now: new Date('2026-11-16T13:00:00Z') });
    const b = buildSystemPrompt({ ...input, now: new Date('2026-11-16T21:30:00Z') });

    expect(a.cached).toBe(b.cached);
    expect(a.cached).toContain('Seg a sex, 6h às 22h');
    expect(a.cached).toContain('versão 2');
    expect(a.turn).toContain('10:00');
    expect(b.turn).toContain('18:30');
  });
});
