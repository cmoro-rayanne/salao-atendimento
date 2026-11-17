import type { LlmClient } from '../agent/ports.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { runAgent } from '../agent/run-agent.js';
import type { ToolDeps } from '../agent/tools.js';
import { buildTools } from '../agent/tools.js';
import { firstReplyFooter, OPT_IN_REPLY, OPT_OUT_REPLY, parseConsentCommand } from '../consent/commands.js';
import { transferToHuman } from '../handoff/transfer-to-human.js';
import type { KnowledgeRepository } from '../knowledge/ports.js';
import type {
  AgentRunRecord,
  AgentRunRepository,
  ConversationGateway,
  ConversationLock,
  ReplyJob,
  TenantRepository,
} from './ports.js';

export const HANDOFF_MESSAGE = 'Vou chamar alguém da nossa equipe para continuar com você. Já já te respondem!';
const LOCK_TTL_MS = 60_000;

/** Outra resposta da mesma conversa está em andamento; o job deve tentar de novo. */
export class ConversationBusyError extends Error {
  constructor(conversationId: number) {
    super(`Conversa ${conversationId} ocupada`);
    this.name = 'ConversationBusyError';
  }
}

export interface LlmPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export function costUsd(pricing: LlmPricing | undefined, inputTokens: number, outputTokens: number): number | null {
  if (!pricing) return null;
  return (inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok) / 1_000_000;
}

export interface ReplyDeps extends ToolDeps {
  llm: LlmClient;
  model: string | null;
  pricing?: LlmPricing | undefined;
  maxSteps: number;
  tenants: TenantRepository;
  knowledge: KnowledgeRepository;
  conversations: ConversationGateway;
  runs: AgentRunRepository;
  lock: ConversationLock;
  now?: () => Date;
}

/**
 * Use case: responde a uma conversa que está com o bot.
 * Erros do LLM ou da rede sobem para a fila tentar de novo.
 */
export async function replyToConversation(deps: ReplyDeps, job: ReplyJob): Promise<AgentRunRecord['outcome']> {
  const release = await deps.lock.acquire(job.conversationId, LOCK_TTL_MS);
  if (!release) throw new ConversationBusyError(job.conversationId);

  const clock = deps.now ?? (() => new Date());
  const startedAt = clock().getTime();
  const base = {
    tenantId: null as number | null,
    conversationId: job.conversationId,
    model: deps.model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    steps: 0,
    toolsUsed: [],
  };

  try {
    const tenant = await deps.tenants.findByChatwootAccount(job.accountId);
    if (!tenant) {
      await handOff(deps, job, 'Academia não cadastrada no agente (tenant ausente).', null);
      await deps.runs.record({ ...base, latencyMs: 0, knowledgeVersion: null, outcome: 'handoff_no_tenant' });
      return 'handoff_no_tenant';
    }

    base.tenantId = tenant.id;
    const snapshot = await deps.conversations.load(job.accountId, job.conversationId);
    // Se a última mensagem não é do cliente, alguém já respondeu (ex.: retentativa depois do envio).
    const last = snapshot.history.at(-1);
    if (last?.role !== 'user') {
      await deps.runs.record({ ...base, latencyMs: 0, knowledgeVersion: null, outcome: 'skipped' });
      return 'skipped';
    }

    // SAIR / VOLTAR: resposta fixa, sem chamar a IA.
    const command = parseConsentCommand(last.content);
    if (command && snapshot.contact.phone) {
      await deps.leads.setOptOut({
        tenantId: tenant.id,
        phone: snapshot.contact.phone,
        chatwootContactId: snapshot.contact.chatwootContactId,
        optedOut: command === 'opt_out',
      });
      await deps.conversations.sendReply(job.accountId, job.conversationId, command === 'opt_out' ? OPT_OUT_REPLY : OPT_IN_REPLY);
      await deps.runs.record({ ...base, latencyMs: clock().getTime() - startedAt, knowledgeVersion: null, outcome: command });
      return command;
    }

    // A primeira resposta da conversa leva o aviso de atendimento automatizado e privacidade.
    const withFooter = (text: string) => (snapshot.hasReplies ? text : `${text}\n\n${firstReplyFooter(tenant.privacyUrl)}`);

    const knowledge = await deps.knowledge.getActive(tenant.id);
    const system = buildSystemPrompt({
      academyName: tenant.name,
      knowledge,
      now: clock(),
      timeZone: tenant.timeZone,
      isFirstReply: !snapshot.hasReplies,
    });

    const outcome = await runAgent(deps.llm, {
      system,
      history: snapshot.history,
      tools: buildTools(deps),
      maxSteps: deps.maxSteps,
      ctx: {
        tenantId: tenant.id,
        timeZone: tenant.timeZone,
        accountId: job.accountId,
        conversationId: job.conversationId,
        contact: snapshot.contact,
      },
    });

    let result: AgentRunRecord['outcome'];
    if (outcome.kind === 'reply') {
      await deps.conversations.sendReply(job.accountId, job.conversationId, withFooter(outcome.text));
      result = 'reply';
    } else if (outcome.reason === 'tool') {
      // A ferramenta já transferiu; só avisamos o cliente.
      await deps.conversations.sendReply(job.accountId, job.conversationId, withFooter(HANDOFF_MESSAGE));
      result = 'handoff_tool';
    } else {
      await handOff(deps, job, `A IA não concluiu em ${deps.maxSteps} passos.`, tenant.id);
      result = 'handoff_max_steps';
    }

    await deps.runs.record({
      ...base,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costUsd: costUsd(deps.pricing, outcome.usage.inputTokens, outcome.usage.outputTokens),
      steps: outcome.steps,
      toolsUsed: outcome.toolsUsed,
      latencyMs: clock().getTime() - startedAt,
      knowledgeVersion: knowledge.version,
      outcome: result,
    });
    return result;
  } finally {
    await release();
  }
}

/** Chamado quando o job esgota as tentativas: o cliente não fica sem resposta. */
export async function handleExhaustedReply(
  deps: Pick<ReplyDeps, 'conversations' | 'handoff' | 'runs' | 'model' | 'tenants'>,
  job: ReplyJob,
  error: string,
): Promise<void> {
  const tenant = await deps.tenants.findByChatwootAccount(job.accountId).catch(() => null);
  const tenantId = tenant?.id ?? null;
  await handOff(deps, job, 'Falha técnica ao responder.', tenantId);
  await deps.runs.record({
    tenantId,
    conversationId: job.conversationId,
    model: deps.model,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    latencyMs: 0,
    steps: 0,
    toolsUsed: [],
    knowledgeVersion: null,
    outcome: 'handoff_failure',
    error,
  });
}

async function handOff(
  deps: Pick<ReplyDeps, 'conversations' | 'handoff'>,
  job: ReplyJob,
  reason: string,
  tenantId: number | null,
): Promise<void> {
  await deps.conversations.sendReply(job.accountId, job.conversationId, HANDOFF_MESSAGE);
  await transferToHuman(deps.handoff, { tenantId, accountId: job.accountId, conversationId: job.conversationId, reason });
}
