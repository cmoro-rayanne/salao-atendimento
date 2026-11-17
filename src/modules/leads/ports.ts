export interface UpsertLeadInput {
  tenantId: number;
  phone: string;
  chatwootContactId: number;
  name?: string | undefined;
}

export interface LeadRepository {
  /**
   * Cria a cliente ou atualiza a existente (mesmo salão + telefone) numa única
   * operação atômica. Campos ausentes não apagam o que já estava salvo.
   */
  upsertByPhone(input: UpsertLeadInput): Promise<{ id: number; created: boolean }>;
  /** Liga ou desliga o opt-out de mensagens ativas (cria o contato se não existir). */
  setOptOut(input: { tenantId: number; phone: string; chatwootContactId: number; optedOut: boolean }): Promise<void>;
}
