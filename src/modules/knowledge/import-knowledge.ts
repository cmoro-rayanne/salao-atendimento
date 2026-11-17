import { localParts, zonedTimeToUtc } from '../../shared/time-zone.js';
import type { TenantSettingsRepository } from '../settings/ports.js';
import { createSlot } from '../trial-classes/manage-slots.js';
import type { NewTrialSlot, TrialSlotRepository } from '../trial-classes/ports.js';
import type { ParsedKnowledgeDoc, WeeklyTrialRule } from './import-doc.js';
import type { KnowledgeAdminRepository } from './ports.js';
import { replaceKnowledge } from './replace-knowledge.js';

export interface ImportDeps {
  knowledge: KnowledgeAdminRepository;
  slots: TrialSlotRepository;
  settings: TenantSettingsRepository;
}

export interface ImportOptions {
  /** Permite trocar uma base que já tem itens (editada no painel, por exemplo). */
  replace: boolean;
  weeks: number;
  now: Date;
}

export type ImportResult =
  | {
      ok: true;
      knowledgeVersion: number;
      itemCount: number;
      receptionHoursUpdated: boolean;
      slotsCreated: number;
      slotsSkipped: number;
    }
  | { ok: false; error: string };

/** Command: grava na academia o que o documento importado trouxe. */
export async function importKnowledgeDoc(
  deps: ImportDeps,
  tenantId: number,
  doc: ParsedKnowledgeDoc,
  opts: ImportOptions,
): Promise<ImportResult> {
  if (doc.items.length === 0) return { ok: false, error: 'O documento não tem nada preenchido para importar.' };

  const current = await deps.knowledge.getForEdit(tenantId);
  if (current.items.length > 0 && !opts.replace) {
    return {
      ok: false,
      error: `A base atual já tem itens (${current.items.length}). Use --replace para trocá-la pelo documento.`,
    };
  }
  const saved = await replaceKnowledge(
    deps.knowledge,
    tenantId,
    current.version,
    doc.items.map((i) => ({ ...i, active: true })),
    'importador',
  );
  if (!saved.ok) {
    return { ok: false, error: 'error' in saved ? saved.error : 'A base mudou durante a importação; rode de novo.' };
  }

  const settings = await deps.settings.get(tenantId);
  let receptionHoursUpdated = false;
  if (doc.receptionHours) {
    await deps.settings.save(tenantId, { ...settings, receptionHours: doc.receptionHours });
    receptionHoursUpdated = true;
  }

  const { created: slotsCreated, skipped: slotsSkipped } = await applyTrialSchedule(
    deps.slots,
    tenantId,
    doc.trialRules,
    settings.timeZone,
    opts,
  );

  return {
    ok: true,
    knowledgeVersion: saved.version,
    itemCount: doc.items.length,
    receptionHoursUpdated,
    slotsCreated,
    slotsSkipped,
  };
}

/** Command: cria os horários da experimental das próximas semanas, pulando os que já existem. */
export async function applyTrialSchedule(
  slots: TrialSlotRepository,
  tenantId: number,
  rules: WeeklyTrialRule[],
  timeZone: string,
  opts: { weeks: number; now: Date },
): Promise<{ created: number; skipped: number }> {
  const wanted = expandTrialRules(rules, opts.now, opts.weeks, timeZone);
  let created = 0;
  let skipped = 0;
  if (wanted.length === 0) return { created, skipped };
  const times = wanted.map((s) => s.startsAt.getTime());
  const existing = await slots.list(tenantId, new Date(Math.min(...times)), new Date(Math.max(...times) + 1));
  const taken = new Set(existing.map((s) => slotKey(s.modality, s.startsAt)));
  for (const slot of wanted) {
    if (taken.has(slotKey(slot.modality, slot.startsAt))) {
      skipped++;
      continue;
    }
    const result = await createSlot(slots, tenantId, slot, opts.now);
    if (!result.ok) {
      skipped++;
      continue;
    }
    taken.add(slotKey(slot.modality, slot.startsAt));
    created++;
  }
  return { created, skipped };
}

const slotKey = (modality: string, startsAt: Date) => `${modality.trim().toLowerCase()}@${startsAt.toISOString()}`;

/** Horários concretos das próximas `weeks` semanas, a partir de amanhã, no fuso da academia. */
export function expandTrialRules(rules: WeeklyTrialRule[], now: Date, weeks: number, timeZone: string): NewTrialSlot[] {
  const today = localParts(now, timeZone);
  const slots: NewTrialSlot[] = [];
  for (let offset = 1; offset <= weeks * 7; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = day.getUTCDay();
    for (const rule of rules) {
      if (!rule.weekdays.includes(weekday)) continue;
      for (const t of rule.times) {
        const startsAt = zonedTimeToUtc(
          { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: t.hour, minute: t.minute },
          timeZone,
        );
        slots.push({ modality: rule.modality, startsAt, capacity: rule.capacity });
      }
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
