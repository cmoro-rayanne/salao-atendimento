export interface TenantSettings {
  name: string;
  timeZone: string;
  receptionHours: { open: number; close: number } | null;
  privacyUrl: string | null;
  /** Atraso da cliente tolerado sem perder o horário, em minutos (0 a 60). */
  lateToleranceMin: number;
}

export interface TenantSettingsRepository {
  get(tenantId: number): Promise<TenantSettings>;
  save(tenantId: number, settings: TenantSettings): Promise<void>;
}
