import type { NewTrialSlot, TrialSlot, TrialSlotRepository } from './ports.js';

export const MAX_CAPACITY = 100;

export type CreateSlotResult = { ok: true; slot: TrialSlot } | { ok: false; error: string };

/** Command: cria um horário de aula experimental. */
export async function createSlot(
  repo: TrialSlotRepository,
  tenantId: number,
  input: NewTrialSlot,
  now: Date = new Date(),
): Promise<CreateSlotResult> {
  const modality = input.modality.trim();
  if (!modality) return { ok: false, error: 'Informe a modalidade.' };
  if (input.capacity < 1 || input.capacity > MAX_CAPACITY) {
    return { ok: false, error: `As vagas devem ficar entre 1 e ${MAX_CAPACITY}.` };
  }
  if (input.startsAt.getTime() <= now.getTime()) return { ok: false, error: 'O horário precisa ser no futuro.' };
  return { ok: true, slot: await repo.create(tenantId, { ...input, modality }) };
}

/** Command: muda as vagas de um horário. */
export async function changeCapacity(
  repo: TrialSlotRepository,
  tenantId: number,
  id: number,
  capacity: number,
): Promise<'ok' | 'not_found' | 'below_booked' | 'invalid'> {
  if (capacity < 0 || capacity > MAX_CAPACITY) return 'invalid';
  return repo.updateCapacity(tenantId, id, capacity);
}
