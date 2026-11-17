export interface UpsertLeadInput {
  tenantId: number;
  phone: string;
  chatwootContactId: number;
  name?: string | undefined;
  goal?: string | undefined;
  modality?: string | undefined;
}

export interface LeadRepository {
  /**
   * Cria o lead ou atualiza o existente (mesmo tenant + telefone) numa única
   * operação atômica. Campos ausentes não apagam o que já estava salvo.
   */
  upsertByPhone(input: UpsertLeadInput): Promise<{ id: number; created: boolean }>;
  /** Liga ou desliga o opt-out de mensagens ativas (cria o lead se não existir). */
  setOptOut(input: { tenantId: number; phone: string; chatwootContactId: number; optedOut: boolean }): Promise<void>;
}

export const LEAD_STATUSES = ['novo', 'qualificado', 'experimental_agendada', 'matriculado', 'perdido'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export interface LeadListItem {
  id: number;
  name: string | null;
  phone: string;
  goal: string | null;
  modality: string | null;
  status: LeadStatus;
  version: number;
  chatwootContactId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadQuery {
  status?: LeadStatus | undefined;
  search?: string | undefined;
  from: Date;
  to: Date;
  limit: number;
}

export type UpdateLeadStatusResult =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'not_found' };

/** Leads vistos pelo painel. */
export interface LeadAdminRepository {
  /** Leads com contato no período (por última atualização), mais recentes primeiro, e contagem por situação. */
  list(tenantId: number, query: LeadQuery): Promise<{ items: LeadListItem[]; counts: Record<LeadStatus, number> }>;
  /** Lock otimista: só altera se `version` ainda for `expectedVersion`. Matricular grava a data. */
  updateStatus(tenantId: number, id: number, status: LeadStatus, expectedVersion: number): Promise<UpdateLeadStatusResult>;
}
