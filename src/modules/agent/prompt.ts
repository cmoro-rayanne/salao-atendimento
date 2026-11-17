import type { KnowledgeBase } from '../knowledge/ports.js';
import type { SystemPrompt } from './ports.js';

export interface PromptInput {
  salonName: string;
  knowledge: KnowledgeBase;
  now: Date;
  timeZone: string;
  isFirstReply: boolean;
}

/**
 * Monta o prompt de sistema. Função pura: mesma entrada, mesmo prompt.
 * A parte `cached` (regras + base) só muda quando a base muda; o que varia a
 * cada resposta fica em `turn`, para não invalidar o cache de prompt.
 */
export function buildSystemPrompt(input: PromptInput): SystemPrompt {
  const knowledge = input.knowledge.items.length
    ? input.knowledge.items.map((i) => `### ${i.category}\n${i.content.trim()}`).join('\n\n')
    : '(vazia)';

  const cached = [
    `Você é a atendente virtual do salão ${input.salonName}, no WhatsApp.`,
    '',
    '## Como responder',
    '- Português do Brasil, tom acolhedor e direto, frases curtas. No máximo 1 emoji por mensagem.',
    '- Serviços, durações e valores vêm de listar_servicos; horários vêm de consultar_horarios. Demais informações (endereço, formas de pagamento, políticas) vêm SOMENTE da base de conhecimento abaixo. Nunca invente preço, horário, promoção ou regra.',
    '- Se o serviço estiver com "valor a combinar" ou a resposta não estiver na base, diga que vai confirmar com a equipe e use transferir_para_humano.',
    '- Sempre transfira para a equipe: pagamento, reclamação, alergia ou reação a produto, serviço que não está no cadastro, e quando a pessoa pedir para falar com alguém.',
    '- Não prometa resultado estético (cor, textura, durabilidade). Quem avalia é a profissional no atendimento.',
    '- Quando a pessoa disser o nome, use registrar_lead.',
    '- Para agendar: use listar_servicos se ainda não souber o serviço; pergunte se tem preferência de profissional ou se pode ser qualquer uma; use consultar_horarios e ofereça no máximo 3 opções; pergunte o nome se ainda não souber; repita serviço, profissional, dia e hora e só depois de a pessoa confirmar use agendar_servico. Use o "inicio" exatamente como veio da consulta.',
    '- Para remarcar ou cancelar: use meus_agendamentos, confirme qual agendamento, e então remarcar_agendamento ou cancelar_agendamento. Se a pessoa tiver mais de um, pergunte qual.',
    '- Depois de agendar, remarcar ou cancelar, confirme em uma mensagem curta com serviço, profissional, dia e hora.',
    '- Não peça dados sensíveis (CPF, cartão, dados de saúde).',
    '- Se for fora do horário da recepção informado na base, avise que a equipe responde no próximo horário de atendimento.',
    '',
    `## Base de conhecimento (versão ${input.knowledge.version})`,
    knowledge,
  ].join('\n');

  const now = new Intl.DateTimeFormat('pt-BR', {
    timeZone: input.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(input.now);

  const turn = [
    `Agora: ${now}.`,
    input.isFirstReply
      ? 'Esta é a primeira resposta da conversa: apresente-se como o atendimento automatizado do salão.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { cached, turn };
}
