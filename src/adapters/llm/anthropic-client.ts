import { z } from 'zod';
import type { AgentMessage, LlmClient, LlmTurn, SystemPrompt, ToolSpec } from '../../modules/agent/ports.js';

const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;

const ResponseSchema = z.object({
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
      // Outros tipos de bloco (ex.: thinking) são ignorados.
      z.looseObject({ type: z.literal('thinking') }),
    ]),
  ),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** Erro do provedor. `retryable` indica se vale a fila tentar de novo. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

type ApiBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface ApiMessage {
  role: 'user' | 'assistant';
  content: ApiBlock[];
}

/** Adapter da Messages API da Anthropic (tool use + cache de prompt). */
export class AnthropicLlmClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly maxTokens = 600,
  ) {}

  async complete(request: { system: SystemPrompt; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<LlmTurn> {
    const system: ApiBlock[] = [{ type: 'text', text: request.system.cached, cache_control: { type: 'ephemeral' } }];
    if (request.system.turn) system.push({ type: 'text', text: request.system.turn });

    const res = await fetch(new URL('/v1/messages', this.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: toApiMessages(request.messages),
        tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputJsonSchema })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(`LLM respondeu ${res.status}`, res.status, retryable);
    }

    const body = ResponseSchema.parse(await res.json());
    const usage = { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens };

    const calls = body.content.flatMap((b) =>
      b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
    );
    if (calls.length) return { type: 'tool_calls', calls, usage };

    const text = body.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    return { type: 'text', text, usage };
  }
}

/** Converte o formato neutro para o da API, juntando blocos seguidos do mesmo papel. */
export function toApiMessages(messages: AgentMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  const push = (role: ApiMessage['role'], block: ApiBlock) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const m of messages) {
    switch (m.role) {
      case 'user':
        push('user', { type: 'text', text: m.content });
        break;
      case 'assistant':
        push('assistant', { type: 'text', text: m.content });
        break;
      case 'assistant_tool_calls':
        for (const c of m.calls) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.input });
        break;
      case 'tool_result':
        push('user', { type: 'tool_result', tool_use_id: m.callId, content: m.content, is_error: m.isError });
        break;
    }
  }
  return out;
}
