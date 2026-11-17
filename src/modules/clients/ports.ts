export interface ClientListItem {
  id: number;
  name: string | null;
  phone: string;
  chatwootContactId: number | null;
  /** Próximo horário marcado (ativo), se houver. */
  nextAppointment: { startsAt: Date; serviceName: string; professionalName: string } | null;
  completed: number;
  noShows: number;
  /** A pessoa pediu para não receber mensagens ativas (lembretes). */
  optedOut: boolean;
  updatedAt: Date;
}

export interface ClientQuery {
  search?: string | undefined;
  now: Date;
  limit: number;
}

/** Clientes (contatos do WhatsApp) vistos pelo painel. */
export interface ClientAdminRepository {
  /** Mais recentes primeiro; busca por nome ou telefone (só dígitos, 3 ou mais). */
  list(tenantId: number, query: ClientQuery): Promise<ClientListItem[]>;
}
