import type { AgentMessage } from '../agent/ports.js';

/** Guarda ids de eventos já processados (idempotência). */
export interface ProcessedEventStore {
  /** Registra o evento. Retorna `false` se ele já tinha sido registrado antes. */
  markIfNew(eventId: string): Promise<boolean>;
}

export interface ReplyJob {
  accountId: number;
  conversationId: number;
}

/** Fila que agenda a resposta de uma conversa. */
export interface ConversationQueue {
  /**
   * Agenda a resposta com atraso. Chamadas repetidas para a mesma conversa
   * dentro do atraso viram um único job (agrupa mensagens em sequência).
   */
  scheduleReply(job: ReplyJob, delayMs: number): Promise<void>;
}

export interface Tenant {
  id: number;
  name: string;
  timeZone: string;
  privacyUrl: string | null;
}

export interface TenantRepository {
  findByChatwootAccount(accountId: number): Promise<Tenant | null>;
}

export interface ConversationContact {
  chatwootContactId: number;
  phone: string | null;
  name: string | null;
}

export interface ConversationSnapshot {
  contact: ConversationContact;
  /** Histórico em ordem cronológica, já no formato neutro do agente. */
  history: AgentMessage[];
  /** `true` se o bot ou a equipe já respondeu nesta conversa. */
  hasReplies: boolean;
}

/** Leitura e escrita na conversa (hoje, via Chatwoot). */
export interface ConversationGateway {
  load(accountId: number, conversationId: number): Promise<ConversationSnapshot>;
  sendReply(accountId: number, conversationId: number, text: string): Promise<void>;
}

export interface AgentRunRecord {
  tenantId: number | null;
  conversationId: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Custo em dólares, quando o preço por token está configurado. */
  costUsd: number | null;
  latencyMs: number;
  steps: number;
  toolsUsed: string[];
  knowledgeVersion: number | null;
  outcome:
    | 'reply'
    | 'handoff_tool'
    | 'handoff_max_steps'
    | 'handoff_no_tenant'
    | 'handoff_failure'
    | 'skipped'
    | 'opt_out'
    | 'opt_in';
  error?: string | undefined;
}

export interface AgentRunRepository {
  record(run: AgentRunRecord): Promise<void>;
}

/** Garante uma resposta por vez por conversa, mesmo com vários workers. */
export interface ConversationLock {
  /** Devolve uma função para liberar, ou `null` se outra resposta já está em andamento. */
  acquire(conversationId: number, ttlMs: number): Promise<(() => Promise<void>) | null>;
}

/** Limite de mensagens por conversa (proteção contra spam e gasto de IA). */
export interface ConversationRateLimiter {
  /** `firstExceeded` é `true` só na primeira mensagem acima do limite (para alertar uma vez). */
  hit(conversationId: number): Promise<{ allowed: boolean; firstExceeded: boolean }>;
}
