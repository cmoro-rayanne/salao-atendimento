import type { HandoffRepository, TeamInbox } from './ports.js';
import { sanitizeQuestion } from './sanitize-question.js';

export interface TransferToHumanDeps {
  inbox: TeamInbox;
  handoffs: HandoffRepository;
}

export interface TransferRequest {
  tenantId: number | null;
  accountId: number;
  conversationId: number;
  reason: string;
  summary?: string | undefined;
  /** Pergunta que a base não respondeu, como a IA resumiu. */
  unansweredQuestion?: string | undefined;
}

/**
 * Command: passa a conversa para a equipe. A nota vem antes da mudança de
 * status para a equipe já abrir a conversa com o contexto.
 */
export async function transferToHuman(deps: TransferToHumanDeps, req: TransferRequest): Promise<void> {
  const lines = ['Transferido pela IA.', `Motivo: ${req.reason}`];
  if (req.summary) lines.push(`Resumo: ${req.summary}`);
  const question = sanitizeQuestion(req.unansweredQuestion);
  if (question) lines.push(`Não está na base: ${question}`);

  await deps.inbox.addPrivateNote(req.accountId, req.conversationId, lines.join('\n'));
  await deps.inbox.assignToTeam(req.accountId, req.conversationId);
  await deps.handoffs.record(req.conversationId, req.reason, req.tenantId, question);
}
