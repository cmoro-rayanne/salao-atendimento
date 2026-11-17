import { z } from 'zod';
import { transferToHuman, type TransferToHumanDeps } from '../handoff/transfer-to-human.js';
import type { LeadRepository } from '../leads/ports.js';
import { registerLead } from '../leads/register-lead.js';
import { bookTrialClass, cancelTrialClass, listAvailableSlots, type BookingDeps } from '../trial-classes/booking.js';
import { defineTool, type AgentTool } from './ports.js';

const RegistrarLeadInput = z.object({
  nome: z.string().max(120).optional().describe('Nome que a pessoa informou'),
  objetivo: z.string().max(300).optional().describe('Objetivo, ex.: emagrecer, ganhar massa, condicionamento'),
  modalidade: z.string().max(120).optional().describe('Modalidade de interesse, ex.: musculação, pilates'),
});

const ListarHorariosInput = z.object({
  modalidade: z.string().max(80).optional().describe('Filtrar por modalidade, se a pessoa disse qual quer'),
});

const AgendarInput = z.object({
  horario_id: z.number().int().positive().describe('O horario_id que veio de listar_horarios_experimental'),
});

const CancelarInput = z.object({});

const TransferirInput = z.object({
  motivo: z.string().min(3).max(200).describe('Por que a conversa precisa de uma pessoa'),
  resumo: z.string().max(600).optional().describe('Resumo curto do que a pessoa quer, para a equipe'),
  pergunta_sem_resposta: z
    .string()
    .max(400)
    .optional()
    .describe(
      'Só quando a resposta não está na base: a pergunta da pessoa em uma frase, sem nome, telefone ou outro dado pessoal. Ex.: "Vocês têm aula de natação?"',
    ),
});

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export interface ToolDeps {
  leads: LeadRepository;
  handoff: TransferToHumanDeps;
  booking: BookingDeps;
}

/** Ferramentas do agente (specs 0002 e 0003). */
export function buildTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      spec: {
        name: 'registrar_lead',
        description:
          'Salva ou completa os dados do interessado (nome, objetivo, modalidade). Use assim que a pessoa informar algum desses dados.',
        inputJsonSchema: jsonSchema(RegistrarLeadInput),
      },
      input: RegistrarLeadInput,
      run: (input, ctx) => registerLead(deps.leads, ctx, input),
    }),
    defineTool({
      spec: {
        name: 'listar_horarios_experimental',
        description:
          'Lista os horários livres da aula experimental nos próximos 7 dias. Use antes de oferecer ou agendar qualquer horário; nunca invente horários.',
        inputJsonSchema: jsonSchema(ListarHorariosInput),
      },
      input: ListarHorariosInput,
      run: (input, ctx) => listAvailableSlots(deps.booking, ctx, input.modalidade),
    }),
    defineTool({
      spec: {
        name: 'agendar_experimental',
        description:
          'Agenda a aula experimental da pessoa no horário escolhido. Só use depois que a pessoa confirmar o dia e a hora, e depois de saber o nome dela.',
        inputJsonSchema: jsonSchema(AgendarInput),
      },
      input: AgendarInput,
      run: (input, ctx) => bookTrialClass(deps.booking, ctx, input.horario_id),
    }),
    defineTool({
      spec: {
        name: 'cancelar_experimental',
        description:
          'Cancela a aula experimental futura da pessoa (para desistência ou para remarcar). Confirme com a pessoa antes.',
        inputJsonSchema: jsonSchema(CancelarInput),
      },
      input: CancelarInput,
      run: (_input, ctx) => cancelTrialClass(deps.booking, ctx),
    }),
    defineTool({
      spec: {
        name: 'transferir_para_humano',
        description:
          'Passa a conversa para a equipe da academia. Use para matrícula, pagamento, reclamação, cancelamento, saúde/lesão, pedido de falar com alguém, ou quando a resposta não estiver na base de conhecimento.',
        inputJsonSchema: jsonSchema(TransferirInput),
      },
      input: TransferirInput,
      endsConversation: true,
      run: async (input, ctx) => {
        await transferToHuman(deps.handoff, {
          tenantId: ctx.tenantId,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          reason: input.motivo,
          summary: input.resumo,
          unansweredQuestion: input.pergunta_sem_resposta,
        });
        return 'Conversa transferida para a equipe.';
      },
    }),
  ];
}
