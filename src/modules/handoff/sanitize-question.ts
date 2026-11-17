export const MAX_QUESTION_LENGTH = 300;

/**
 * A pergunta vem do LLM, que pode copiar dados da pessoa apesar da instrução.
 * Tira o que identifica alguém antes de gravar.
 */
export function sanitizeQuestion(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[removido]')
    .replace(/[+(]*(?:\d[\s().-]*){8,}/g, (m) => `[removido]${/\s$/.test(m) ? ' ' : ''}`)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 3) return null;
  return text.length > MAX_QUESTION_LENGTH ? `${text.slice(0, MAX_QUESTION_LENGTH - 1)}…` : text;
}
