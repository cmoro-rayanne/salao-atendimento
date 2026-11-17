import type { z } from 'zod';

/** Mensagem num formato neutro; o adapter traduz para o formato do provedor. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant_tool_calls'; calls: ToolCall[] }
  | { role: 'tool_result'; callId: string; content: string; isError: boolean };

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema do input, enviado ao modelo. */
  inputJsonSchema: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmTurn = ({ type: 'text'; text: string } | { type: 'tool_calls'; calls: ToolCall[] }) & {
  usage?: TokenUsage;
};

/**
 * Prompt de sistema em duas partes: `cached` muda raramente (regras + base) e
 * pode usar cache de prompt do provedor; `turn` muda a cada resposta (hora atual etc.).
 */
export interface SystemPrompt {
  cached: string;
  turn: string;
}

/** Porta do modelo de IA. Trocar de provedor = escrever outro adapter. */
export interface LlmClient {
  complete(request: {
    system: SystemPrompt;
    messages: AgentMessage[];
    tools: ToolSpec[];
  }): Promise<LlmTurn>;
}

/** Ferramenta que o agente pode chamar. `run` executa um command do domínio. */
export interface AgentTool<Schema extends z.ZodType = z.ZodType> {
  spec: ToolSpec;
  input: Schema;
  /** Ferramenta que encerra a conversa com o bot (ex.: transferir para humano). */
  endsConversation?: boolean;
  run(input: z.output<Schema>, ctx: ToolContext): Promise<string>;
}

/**
 * Declara uma ferramenta com o tipo do input inferido do schema Zod.
 * O loop do agente valida o input com o mesmo schema antes de chamar `run`.
 */
export function defineTool<Schema extends z.ZodType>(tool: AgentTool<Schema>): AgentTool {
  return tool as unknown as AgentTool;
}

export interface ToolContext {
  tenantId: number;
  /** Fuso da academia (IANA), para datas e horários. */
  timeZone: string;
  accountId: number;
  conversationId: number;
  contact: { chatwootContactId: number; phone: string | null; name: string | null };
}
