import type { ToolContext } from '../agent/ports.js';
import type { LeadRepository } from './ports.js';

export interface RegisterLeadInput {
  nome?: string | undefined;
  objetivo?: string | undefined;
  modalidade?: string | undefined;
}

/** Command: registra ou completa o lead do contato da conversa. */
export async function registerLead(leads: LeadRepository, ctx: ToolContext, input: RegisterLeadInput): Promise<string> {
  if (!ctx.contact.phone) {
    return 'Não foi possível registrar: o contato não tem telefone. Siga o atendimento normalmente.';
  }

  const { created } = await leads.upsertByPhone({
    tenantId: ctx.tenantId,
    phone: ctx.contact.phone,
    chatwootContactId: ctx.contact.chatwootContactId,
    name: clean(input.nome) ?? clean(ctx.contact.name ?? undefined),
    goal: clean(input.objetivo),
    modality: clean(input.modalidade),
  });

  return created ? 'Lead registrado.' : 'Lead atualizado.';
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
