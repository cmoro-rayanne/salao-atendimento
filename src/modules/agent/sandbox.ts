/**
 * Teste da IA pelo painel: roda o agente de verdade com a base do editor,
 * mas com ferramentas que não gravam, não agendam e não transferem nada.
 */
import type { CatalogRepository } from '../appointments/ports.js';
import type { KnowledgeItem } from '../knowledge/ports.js';
import type { LlmClient, TokenUsage } from './ports.js';
import { buildSystemPrompt } from './prompt.js';
import { runAgent } from './run-agent.js';
import { buildTools } from './tools.js';

export interface SandboxInput {
  tenantId: number;
  salonName: string;
  timeZone: string;
  now: Date;
  question: string;
  items: KnowledgeItem[];
  maxSteps: number;
  /** Cadastro real do salão (só leitura), para a resposta sair como no WhatsApp. */
  catalog: CatalogRepository;
}

export interface SandboxResult {
  /** Texto que a pessoa receberia; null quando a IA passaria para a equipe. */
  reply: string | null;
  handoff: { reason: string; question: string | null } | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  usage: TokenUsage;
}

export async function testAgentAnswer(llm: LlmClient, input: SandboxInput): Promise<SandboxResult> {
  const calls: SandboxResult['toolCalls'] = [];
  let handoff: SandboxResult['handoff'] = null;

  const tools = buildTools({
    leads: { upsertByPhone: async () => ({ id: 0, created: false }), setOptOut: async () => {} },
    handoff: {
      inbox: { addPrivateNote: async () => {}, assignToTeam: async () => {} },
      handoffs: {
        record: async (_conv, reason, _tenant, question) => {
          handoff = { reason, question: question ?? null };
        },
      },
    },
    agenda: {
      now: () => input.now,
      catalog: input.catalog,
      reminders: { schedule: async () => 'teste', cancel: async () => {} },
      appointments: {
        // Nada é gravado: o "agendamento" de teste só devolve o que seria marcado.
        book: async (req) => {
          const service = await input.catalog.getService(req.tenantId, req.serviceId);
          const professional = (await input.catalog.listProfessionals(req.tenantId, req.serviceId)).find((p) => p.id === req.professionalId);
          if (!service || !professional) return { kind: 'not_available' };
          return {
            kind: 'booked',
            appointment: {
              id: 0,
              serviceId: service.id,
              serviceName: service.name,
              professionalId: professional.id,
              professionalName: professional.name,
              startsAt: req.startsAt,
              endsAt: new Date(req.startsAt.getTime() + service.durationMin * 60_000),
            },
          };
        },
        reschedule: async () => ({ kind: 'not_found' }),
        cancel: async () => ({ kind: 'not_found' }),
        listUpcoming: async () => [],
        setReminderJob: async () => {},
      },
    },
  }).map((tool) => ({
    ...tool,
    run: (args: unknown, ctx: Parameters<typeof tool.run>[1]) => {
      calls.push({ name: tool.spec.name, input: args });
      return tool.run(args as never, ctx);
    },
  }));

  const outcome = await runAgent(llm, {
    system: buildSystemPrompt({
      salonName: input.salonName,
      knowledge: { version: 0, items: input.items },
      now: input.now,
      timeZone: input.timeZone,
      isFirstReply: false,
    }),
    history: [{ role: 'user', content: input.question }],
    tools,
    maxSteps: input.maxSteps,
    ctx: {
      tenantId: input.tenantId,
      timeZone: input.timeZone,
      accountId: 0,
      conversationId: 0,
      contact: { chatwootContactId: 0, phone: '+550000000000', name: null },
    },
  });

  if (outcome.kind === 'handoff' && !handoff) handoff = { reason: 'A IA não chegou a uma resposta em poucos passos.', question: null };
  return {
    reply: outcome.kind === 'reply' ? outcome.text : null,
    handoff,
    toolCalls: calls,
    usage: outcome.usage,
  };
}
