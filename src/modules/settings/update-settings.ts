import type { TenantSettings, TenantSettingsRepository } from './ports.js';

/** Fusos do Brasil oferecidos no painel (IANA). */
export const BRAZIL_TIME_ZONES = [
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Recife',
  'America/Maceio',
  'America/Belem',
  'America/Araguaina',
  'America/Manaus',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Noronha',
] as const;

/** Command: valida e salva as configurações da academia. */
export async function updateSettings(
  repo: TenantSettingsRepository,
  tenantId: number,
  input: TenantSettings,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) return { ok: false, error: 'Informe o nome da academia (até 80 caracteres).' };
  if (!(BRAZIL_TIME_ZONES as readonly string[]).includes(input.timeZone)) return { ok: false, error: 'Fuso horário inválido.' };

  const rh = input.receptionHours;
  if (rh) {
    const valid = Number.isInteger(rh.open) && Number.isInteger(rh.close) && rh.open >= 0 && rh.close <= 24;
    if (!valid || rh.open >= rh.close) return { ok: false, error: 'O horário da recepção precisa abrir antes de fechar (0h a 24h).' };
  }

  if (!Number.isInteger(input.lateToleranceMin) || input.lateToleranceMin < 0 || input.lateToleranceMin > 60) {
    return { ok: false, error: 'A tolerância de atraso precisa ficar entre 0 e 60 minutos.' };
  }

  let privacyUrl: string | null = input.privacyUrl?.trim() || null;
  if (privacyUrl) {
    try {
      const url = new URL(privacyUrl);
      if (url.protocol !== 'https:') return { ok: false, error: 'O link da política de privacidade precisa começar com https://' };
      privacyUrl = url.toString();
    } catch {
      return { ok: false, error: 'Link da política de privacidade inválido.' };
    }
  }

  await repo.save(tenantId, { name, timeZone: input.timeZone, receptionHours: rh, privacyUrl, lateToleranceMin: input.lateToleranceMin });
  return { ok: true };
}
