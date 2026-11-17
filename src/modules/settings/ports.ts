export interface TenantSettings {
  name: string;
  timeZone: string;
  receptionHours: { open: number; close: number } | null;
  privacyUrl: string | null;
}

export interface TenantSettingsRepository {
  get(tenantId: number): Promise<TenantSettings>;
  save(tenantId: number, settings: TenantSettings): Promise<void>;
}
