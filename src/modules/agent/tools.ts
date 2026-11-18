import { z } from 'zod';
import { transferToHuman, type TransferToHumanDeps } from '../handoff/transfer-to-human.js';
import type { LeadRepository } from '../leads/ports.js';
import { registerLead } from '../leads/register-lead.js';
import {
  bookService,
  cancelAppointment,
  listFreeSlots,
  listMine,
  confirmLateArrival,
  listServices,
  rescheduleAppointment,
  type AgendaDeps,
} from '../appointments/agenda.js';
import { defineTool, type AgentTool } from './ports.js';

const RegistrarLeadInput = z.object({
  nome: z.string().max(120).optional().describe('Nome que a pessoa informou'),
});

const ConsultarHorariosInput = z.object({
  servico_id: z.number().int().positive().describe('O servico_id que veio de listar_servicos'),
  profissional_id: z.number().int().positive().optional().describe('Só se a pessoa pediu uma profissional específica'),
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Dia pedido, AAAA-MM-DD. Sem data, mostra os próximos 7 dias'),
});

const AgendarInput = z.object({
  servico_id: z.number().int().positive().describe('O servico_id que veio de listar_servicos'),
  profissional_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Omita se a pessoa aceita qualquer profissional livre'),
  inicio: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .describe('O valor de "inicio" exatamente como veio de consultar_horarios, AAAA-MM-DDTHH:MM'),
});

const RemarcarInput = z.object({
  agendamento_id: z.number().int().positive().describe('O agendamento_id que veio de meus_agendamentos'),
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('Novo horário, como veio de consultar_horarios'),
  profissional_id: z.number().int().positive().optional().describe('Só se a pessoa quiser trocar de profissional'),
});

const CancelarInput = z.object({
  agendamento_id: z.number().int().positive().describe('O agendamento_id que veio de meus_agendamentos'),
});

const ChegadaInput = z.object({
  agendamento_id: z.number().int().positive().describe('O agendamento_id que veio de meus_agendamentos, com aviso de atraso'),
});

const SemInput = z.object({});

const TransferirInput = z.object({
  motivo: z.string().min(3).max(200).describe('Por que a conversa precisa de uma pessoa'),
  resumo: z.string().max(600).optional().describe('Resumo curto do que a pessoa quer, para a equipe'),
  pergunta_sem_resposta: z
    .string()
    .max(400)
    .optional()
    .describe(
      'Só quando a resposta não está na base: a pergunta da pessoa em uma frase, sem nome, telefone ou outro dado pessoal. Ex.: "Vocês fazem alongamento capilar?"',
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
  agenda: AgendaDeps;
}

/** Ferramentas do agente (specs 0002 e 0013). */
export function buildTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      spec: {
        name: 'registrar_lead',
        description:
          'Salva o nome da cliente. Use assim que a pessoa disser como quer ser chamada.',
        inputJsonSchema: jsonSchema(RegistrarLeadInput),
      },
      input: RegistrarLeadInput,
      run: (input, ctx) => registerLead(deps.leads, ctx, input),
    }),
    defineTool({
      spec: {
        name: 'listar_servicos',
        description:
          'Lista os serviços do salão com duração, valor (quando cadastrado) e quem faz cada um. Use antes de falar de serviços ou valores; nunca invente serviço nem preço.',
        inputJsonSchema: jsonSchema(SemInput),
      },
      input: SemInput,
      run: (_input, ctx) => listServices(deps.agenda, ctx),
    }),
    defineTool({
      spec: {
        name: 'consultar_horarios',
        description:
          'Lista os horários livres de um serviço (próximos 7 dias ou um dia pedido), com as profissionais livres em cada um. Use antes de oferecer qualquer horário; nunca invente horários.',
        inputJsonSchema: jsonSchema(ConsultarHorariosInput),
      },
      input: ConsultarHorariosInput,
      run: (input, ctx) =>
        listFreeSlots(deps.agenda, ctx, { serviceId: input.servico_id, professionalId: input.profissional_id, day: input.data }),
    }),
    defineTool({
      spec: {
        name: 'meus_agendamentos',
        description: 'Lista os agendamentos futuros da pessoa, com os ids. Use antes de remarcar ou cancelar.',
        inputJsonSchema: jsonSchema(SemInput),
      },
      input: SemInput,
      run: (_input, ctx) => listMine(deps.agenda, ctx),
    }),
    defineTool({
      spec: {
        name: 'confirmar_chegada_atrasada',
        description:
          'Registra que a cliente topou chegar no novo horário previsto de um aviso de atraso do salão. Só use depois de ela dizer claramente que pode. Não altera o agendamento.',
        inputJsonSchema: jsonSchema(ChegadaInput),
      },
      input: ChegadaInput,
      run: (input, ctx) => confirmLateArrival(deps.agenda, ctx, input.agendamento_id),
    }),
    defineTool({
      spec: {
        name: 'agendar_servico',
        description:
          'Agenda o serviço no horário escolhido. Só use depois que a pessoa confirmar serviço, dia, hora e profissional (ou "qualquer uma"), e depois de saber o nome dela.',
        inputJsonSchema: jsonSchema(AgendarInput),
      },
      input: AgendarInput,
      run: (input, ctx) =>
        bookService(deps.agenda, ctx, { serviceId: input.servico_id, professionalId: input.profissional_id, start: input.inicio }),
    }),
    defineTool({
      spec: {
        name: 'remarcar_agendamento',
        description:
          'Muda o horário (ou a profissional) de um agendamento da pessoa. Confirme o novo horário antes. Se o novo horário estiver ocupado, o original continua valendo.',
        inputJsonSchema: jsonSchema(RemarcarInput),
      },
      input: RemarcarInput,
      run: (input, ctx) =>
        rescheduleAppointment(deps.agenda, ctx, {
          appointmentId: input.agendamento_id,
          start: input.inicio,
          professionalId: input.profissional_id,
        }),
    }),
    defineTool({
      spec: {
        name: 'cancelar_agendamento',
        description: 'Cancela um agendamento futuro da pessoa e libera o horário. Confirme com a pessoa antes.',
        inputJsonSchema: jsonSchema(CancelarInput),
      },
      input: CancelarInput,
      run: (input, ctx) => cancelAppointment(deps.agenda, ctx, input.agendamento_id),
    }),
    defineTool({
      spec: {
        name: 'transferir_para_humano',
        description:
          'Passa a conversa para a equipe do salão. Use para pagamento, reclamação, alergia ou reação a produto, pedido de falar com alguém, orçamento de serviço fora do cadastro, ou quando a resposta não estiver na base de conhecimento.',
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
