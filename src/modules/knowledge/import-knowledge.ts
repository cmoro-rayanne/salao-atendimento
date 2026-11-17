import type { TenantSettingsRepository } from '../settings/ports.js';
import type { ParsedKnowledgeDoc } from './import-doc.js';
import type { KnowledgeAdminRepository } from './ports.js';
import { replaceKnowledge } from './replace-knowledge.js';

export interface ImportDeps {
  knowledge: KnowledgeAdminRepository;
  settings: TenantSettingsRepository;
}

export interface ImportOptions {
  /** Permite trocar uma base que já tem itens (editada no painel, por exemplo). */
  replace: boolean;
}

export type ImportResult =
  | { ok: true; knowledgeVersion: number; itemCount: number; receptionHoursUpdated: boolean }
  | { ok: false; error: string };

/** Command: grava no salão o que o documento importado trouxe. */
export async function importKnowledgeDoc(
  deps: ImportDeps,
  tenantId: number,
  doc: ParsedKnowledgeDoc,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (doc.items.length === 0) return { ok: false, error: 'O documento não tem nada preenchido para importar.' };

  const current = await deps.knowledge.getForEdit(tenantId);
  if (current.items.length > 0 && !opts.replace) {
    return {
      ok: false,
      error: `A base atual já tem itens (${current.items.length}). Use --replace para trocá-la pelo documento.`,
    };
  }
  const saved = await replaceKnowledge(
    deps.knowledge,
    tenantId,
    current.version,
    doc.items.map((i) => ({ ...i, active: true })),
    'importador',
  );
  if (!saved.ok) {
    return { ok: false, error: 'error' in saved ? saved.error : 'A base mudou durante a importação; rode de novo.' };
  }

  let receptionHoursUpdated = false;
  if (doc.receptionHours) {
    const settings = await deps.settings.get(tenantId);
    await deps.settings.save(tenantId, { ...settings, receptionHours: doc.receptionHours });
    receptionHoursUpdated = true;
  }

  return { ok: true, knowledgeVersion: saved.version, itemCount: doc.items.length, receptionHoursUpdated };
}
