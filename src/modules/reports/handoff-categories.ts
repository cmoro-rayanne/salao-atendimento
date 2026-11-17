/**
 * Os motivos de transferência são texto livre escrito pela IA (mais alguns fixos do sistema).
 * Agrupamos por palavras-chave para o relatório; a ordem importa (primeira que bate).
 */
const RULES: Array<[string, RegExp]> = [
  ['Falha técnica', /falha t[eé]cnica|n[aã]o concluiu|tenant ausente|n[aã]o cadastrada/i],
  ['Lesão ou saúde', /les[aã]o|sa[uú]de|machuc|m[eé]dic|dor\b|gr[aá]vida|cirurgia/i],
  ['Reclamação ou cancelamento', /reclama|cancelar (o )?plano|cancelamento|insatisf/i],
  ['Matrícula ou pagamento', /matr[ií]cul|pagamento|pagar|pix|cart[aã]o|boleto|contrat|fechar (o )?plano/i],
  ['Pediu para falar com alguém', /falar com|atendente|humano|pessoa da equipe|algu[eé]m da equipe/i],
  ['Dúvida fora da base', /base|n[aã]o (sei|sabe|tenho|tem a) informa|sem informa|d[uú]vida|n[aã]o est[aá]/i],
];

export const OTHER_CATEGORY = 'Outros';

export function categorizeHandoff(reason: string): string {
  return RULES.find(([, re]) => re.test(reason))?.[0] ?? OTHER_CATEGORY;
}
