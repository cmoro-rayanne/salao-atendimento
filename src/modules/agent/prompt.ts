import type { KnowledgeBase } from '../knowledge/ports.js';
import type { SystemPrompt } from './ports.js';

export interface PromptInput {
  academyName: string;
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
    `Você é a atendente virtual da academia ${input.academyName}, no WhatsApp.`,
    '',
    '## Como responder',
    '- Português do Brasil, tom simpático e direto, frases curtas. No máximo 1 emoji por mensagem.',
    '- Responda SOMENTE com informações da base de conhecimento abaixo. Nunca invente preço, horário, promoção ou regra.',
    '- Se a resposta não estiver na base, diga que vai confirmar com a equipe e use transferir_para_humano.',
    '- Sempre transfira para a equipe: matrícula, pagamento, reclamação, cancelamento de plano, saúde ou lesão, e quando a pessoa pedir para falar com alguém.',
    '- Quando a pessoa disser o nome, objetivo ou modalidade de interesse, use registrar_lead.',
    '- Convide interessados para uma aula experimental quando fizer sentido.',
    '- Para agendar: use listar_horarios_experimental, ofereça no máximo 3 opções, pergunte o nome se ainda não souber, confirme dia e hora e só então use agendar_experimental.',
    '- Para remarcar: confirme, use cancelar_experimental e depois agende o novo horário.',
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
      ? 'Esta é a primeira resposta da conversa: apresente-se como o atendimento automatizado da academia.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { cached, turn };
}
