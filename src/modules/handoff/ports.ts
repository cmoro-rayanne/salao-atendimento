/** Onde a equipe atende (hoje, o Chatwoot). */
export interface TeamInbox {
  /** Nota visível só para a equipe, dentro da conversa. */
  addPrivateNote(accountId: number, conversationId: number, note: string): Promise<void>;
  /** Tira a conversa do bot e a coloca na fila da equipe. */
  assignToTeam(accountId: number, conversationId: number): Promise<void>;
}

export interface HandoffRepository {
  /** `question`: pergunta sem resposta na base, já higienizada. */
  record(conversationId: number, reason: string, tenantId: number | null, question?: string | null): Promise<void>;
}

export interface UnansweredQuestion {
  id: number;
  question: string;
  conversationId: number;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** Leitura pelo painel das perguntas que a IA não soube responder. */
export interface UnansweredQuestionRepository {
  list(tenantId: number, from: Date, to: Date, limit: number): Promise<UnansweredQuestion[]>;
  /** `false` se a pergunta não existe nessa academia. */
  setResolved(tenantId: number, id: number, resolved: boolean, now: Date): Promise<boolean>;
}
