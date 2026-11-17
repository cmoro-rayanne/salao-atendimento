import { localParts, zonedTimeToUtc } from '../../shared/time-zone.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Faixa de expediente: `weekday` 0 = domingo … 6 = sábado; minutos desde 00:00 no fuso do salão. */
export interface WorkingInterval {
  weekday: number;
  startMin: number;
  endMin: number;
}

/** Período ocupado (folga, bloqueio ou agendamento). */
export interface Busy {
  startsAt: Date;
  endsAt: Date;
}

export interface ProfessionalSchedule {
  professionalId: number;
  hours: WorkingInterval[];
  timeOff: Busy[];
  /** Só agendamentos ativos (cancelado não ocupa horário). */
  appointments: Busy[];
}

export interface FreeSlotsQuery {
  schedules: ProfessionalSchedule[];
  durationMin: number;
  /** Passo entre horários oferecidos (15 ou 30). */
  stepMin: number;
  /** Janela pedida: só horários que começam em [from, to). */
  from: Date;
  to: Date;
  now: Date;
  /** Antecedência mínima para agendar. */
  minNoticeMin: number;
  /** Quantos dias à frente a agenda está aberta. */
  maxDaysAhead: number;
  timeZone: string;
}

export interface FreeSlot {
  professionalId: number;
  startsAt: Date;
}

const overlaps = (aStart: number, aEnd: number, b: Busy) => aStart < b.endsAt.getTime() && b.startsAt.getTime() < aEnd;

/**
 * Horários livres: expediente − folgas − agendamentos, em passos de `stepMin`, cabendo `durationMin`.
 * Função pura (sem banco): quem chama carrega os dados da janela e passa aqui.
 */
export function computeFreeSlots(q: FreeSlotsQuery): FreeSlot[] {
  if (q.durationMin <= 0 || q.stepMin <= 0) return [];

  const earliest = Math.max(q.from.getTime(), q.now.getTime() + q.minNoticeMin * MINUTE);
  const latest = Math.min(q.to.getTime(), q.now.getTime() + q.maxDaysAhead * DAY);
  if (earliest >= latest) return [];

  // Dias locais cobertos pela janela (um a mais de cada lado absorve diferença de fuso).
  const first = localParts(new Date(earliest), q.timeZone);
  const dayCount = Math.ceil((latest - earliest) / DAY) + 2;
  const slots: FreeSlot[] = [];

  for (const prof of q.schedules) {
    const seen = new Set<number>();
    const busy = [...prof.timeOff, ...prof.appointments];

    for (let i = 0; i < dayCount; i += 1) {
      const date = new Date(Date.UTC(first.year, first.month - 1, first.day + i));
      const weekday = date.getUTCDay();

      for (const h of prof.hours) {
        if (h.weekday !== weekday) continue;
        for (let m = h.startMin; m + q.durationMin <= h.endMin; m += q.stepMin) {
          const startsAt = zonedTimeToUtc(
            {
              year: date.getUTCFullYear(),
              month: date.getUTCMonth() + 1,
              day: date.getUTCDate(),
              hour: Math.floor(m / 60),
              minute: m % 60,
            },
            q.timeZone,
          );
          const start = startsAt.getTime();
          const end = start + q.durationMin * MINUTE;
          if (start < earliest || start >= latest || seen.has(start)) continue;
          if (busy.some((b) => overlaps(start, end, b))) continue;
          seen.add(start);
          slots.push({ professionalId: prof.professionalId, startsAt });
        }
      }
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.professionalId - b.professionalId);
}

export interface Candidate {
  professionalId: number;
  /** Agendamentos ativos dessa profissional no mesmo dia. */
  dayLoad: number;
}

/** "Qualquer profissional": a que tem menos agendamentos no dia; empate pelo menor id (resultado estável). */
export function pickProfessional(candidates: Candidate[]): number | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => a.dayLoad - b.dayLoad || a.professionalId - b.professionalId)[0]!.professionalId;
}
