import type { ToolContext } from '../agent/ports.js';
import type { LeadRepository } from './ports.js';

export interface RegisterLeadInput {
  nome?: string | undefined;
}

/** Command: registra ou completa a cliente da conversa. */
export async function registerLead(leads: LeadRepository, ctx: ToolContext, input: RegisterLeadInput): Promise<string> {
  if (!ctx.contact.phone) {
    return 'Não foi possível registrar: o contato não tem telefone. Siga o atendimento normalmente.';
  }

  const { created } = await leads.upsertByPhone({
    tenantId: ctx.tenantId,
    phone: ctx.contact.phone,
    chatwootContactId: ctx.contact.chatwootContactId,
    name: clean(input.nome) ?? clean(ctx.contact.name ?? undefined),
  });

  return created ? 'Cliente registrada.' : 'Cliente atualizada.';
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
