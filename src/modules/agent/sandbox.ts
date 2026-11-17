/**
 * Teste da IA pelo painel: roda o agente de verdade com a base do editor,
 * mas com ferramentas que não gravam, não agendam e não transferem nada.
 */
import type { TrialSlot } from '../trial-classes/ports.js';
import type { KnowledgeItem } from '../knowledge/ports.js';
import type { LlmClient, TokenUsage } from './ports.js';
import { buildSystemPrompt } from './prompt.js';
import { runAgent } from './run-agent.js';
import { buildTools } from './tools.js';

export interface SandboxInput {
  tenantId: number;
  academyName: string;
  timeZone: string;
  now: Date;
  question: string;
  items: KnowledgeItem[];
  maxSteps: number;
  /** Leitura real dos horários livres (só consulta), para a resposta sair como no WhatsApp. */
  listAvailable: (tenantId: number, from: Date, to: Date, modality?: string) => Promise<TrialSlot[]>;
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
    booking: {
      now: () => input.now,
      reminders: { schedule: async () => 'teste', cancel: async () => {} },
      bookings: {
        listAvailable: input.listAvailable,
        book: async (req) => {
          const slot = (await input.listAvailable(req.tenantId, new Date(0), new Date(8.64e15))).find((s) => s.id === req.slotId);
          return slot
            ? { kind: 'booked', booking: { bookingId: 0, slotId: slot.id, modality: slot.modality, startsAt: slot.startsAt } }
            : { kind: 'not_available' };
        },
        setReminderJob: async () => {},
        cancelActive: async () => ({ kind: 'none' }),
        getForReminder: async () => null,
        markReminderSent: async () => true,
        clearReminderSent: async () => {},
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
      academyName: input.academyName,
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
