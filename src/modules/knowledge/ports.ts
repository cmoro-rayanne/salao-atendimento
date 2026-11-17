export interface KnowledgeItem {
  category: string;
  content: string;
}

/** Base de conhecimento ativa de uma academia, numa versão específica. */
export interface KnowledgeBase {
  version: number;
  items: KnowledgeItem[];
}

export interface KnowledgeRepository {
  getActive(tenantId: number): Promise<KnowledgeBase>;
}

export interface EditableKnowledgeItem extends KnowledgeItem {
  id: number;
  active: boolean;
}

export interface EditableKnowledgeBase {
  version: number;
  items: EditableKnowledgeItem[];
}

export type ReplaceKnowledgeResult = { ok: true; version: number } | { ok: false; currentVersion: number };

/** Leitura e escrita da base pelo painel. */
export interface KnowledgeAdminRepository {
  getForEdit(tenantId: number): Promise<EditableKnowledgeBase>;
  /**
   * Troca todos os itens numa transação, só se a versão atual for `expectedVersion`
   * (lock otimista), e incrementa a versão.
   */
  replaceAll(
    tenantId: number,
    expectedVersion: number,
    items: Array<Omit<EditableKnowledgeItem, 'id'>>,
    /** Quem salvou (e-mail ou "importador"), guardado no histórico. */
    author?: string,
  ): Promise<ReplaceKnowledgeResult>;
  listVersions(tenantId: number, limit: number): Promise<KnowledgeVersionSummary[]>;
  getVersion(tenantId: number, version: number): Promise<KnowledgeVersion | null>;
}

export interface KnowledgeVersionSummary {
  version: number;
  author: string;
  createdAt: Date;
  itemCount: number;
  /** Caracteres dos itens ativos, como no limite da base. */
  activeChars: number;
}

export interface KnowledgeVersion extends KnowledgeVersionSummary {
  items: Array<Omit<EditableKnowledgeItem, 'id'>>;
}
