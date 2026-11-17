import type { EditableKnowledgeItem, KnowledgeAdminRepository, ReplaceKnowledgeResult } from './ports.js';

/** A base inteira vai no prompt a cada resposta: limites mantêm custo e qualidade sob controle. */
export const KNOWLEDGE_LIMITS = {
  maxItems: 60,
  maxCategoryLength: 80,
  maxItemLength: 4000,
  maxTotalLength: 30_000,
} as const;

export type ReplaceKnowledgeOutcome = ReplaceKnowledgeResult | { ok: false; error: string };

/** Command: salva a base editada no painel. */
export async function replaceKnowledge(
  repo: KnowledgeAdminRepository,
  tenantId: number,
  expectedVersion: number,
  rawItems: Array<Omit<EditableKnowledgeItem, 'id'>>,
  author = 'desconhecido',
): Promise<ReplaceKnowledgeOutcome> {
  const items = rawItems
    .map((i) => ({ category: i.category.trim(), content: i.content.trim(), active: i.active }))
    .filter((i) => i.category || i.content);

  const error = validate(items);
  if (error) return { ok: false, error };
  return repo.replaceAll(tenantId, expectedVersion, items, author);
}

function validate(items: Array<Omit<EditableKnowledgeItem, 'id'>>): string | null {
  const L = KNOWLEDGE_LIMITS;
  if (items.length > L.maxItems) return `A base pode ter no máximo ${L.maxItems} itens.`;
  for (const [idx, i] of items.entries()) {
    const n = idx + 1;
    if (!i.category) return `Item ${n}: informe a categoria.`;
    if (!i.content) return `Item ${n} (${i.category}): informe o conteúdo.`;
    if (i.category.length > L.maxCategoryLength) return `Item ${n}: categoria com mais de ${L.maxCategoryLength} caracteres.`;
    if (i.content.length > L.maxItemLength) return `Item ${n} (${i.category}): mais de ${L.maxItemLength} caracteres.`;
  }
  const total = items.filter((i) => i.active).reduce((sum, i) => sum + i.category.length + i.content.length, 0);
  if (total > L.maxTotalLength) return `A base ativa passou de ${L.maxTotalLength} caracteres; resuma ou desative itens.`;
  return null;
}
