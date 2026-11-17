/**
 * Comandos de consentimento por WhatsApp. Só a mensagem inteira conta:
 * "sair" é comando, "quero sair da academia" é conversa normal (a IA atende).
 */
const OPT_OUT = new Set(['sair', 'parar', 'stop', 'descadastrar', 'cancelar lembretes', 'nao quero receber']);
const OPT_IN = new Set(['voltar', 'receber', 'start']);

export type ConsentCommand = 'opt_out' | 'opt_in';

export function normalizeCommand(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ') // pontuação e emoji
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseConsentCommand(text: string): ConsentCommand | null {
  const n = normalizeCommand(text);
  if (OPT_OUT.has(n)) return 'opt_out';
  if (OPT_IN.has(n)) return 'opt_in';
  return null;
}

export const OPT_OUT_REPLY =
  'Pronto, você não vai mais receber lembretes nem mensagens automáticas da academia. Se quiser voltar a receber, é só mandar VOLTAR. Pode continuar perguntando o que precisar por aqui.';
export const OPT_IN_REPLY = 'Combinado, você volta a receber os lembretes das suas aulas. Para parar, é só mandar SAIR.';

/** Rodapé fixo da primeira resposta de cada conversa (não depende da IA). */
export function firstReplyFooter(privacyUrl: string | null): string {
  const privacy = privacyUrl ? ` Política de privacidade: ${privacyUrl}` : '';
  return `_Atendimento automatizado.${privacy} Para não receber lembretes, responda SAIR._`;
}
