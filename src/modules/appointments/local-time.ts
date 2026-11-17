import { localParts, zonedTimeToUtc } from '../../shared/time-zone.js';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-17T10:00" (horário do salão) → instante UTC. Devolve null se o texto ou a data não existirem. */
export function parseLocalDateTime(text: string, timeZone: string): Date | null {
  const m = LOCAL.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const utc = zonedTimeToUtc({ year, month, day, hour, minute }, timeZone);
  const back = localParts(utc, timeZone);
  // Data inexistente (31/02, 25h) volta diferente do que entrou.
  return back.year === year && back.month === month && back.day === day && back.hour === hour && back.minute === minute ? utc : null;
}

/** "2026-11-17" → [início, início do dia seguinte) no fuso do salão. */
export function parseLocalDay(text: string, timeZone: string): { from: Date; to: Date } | null {
  const m = DATE.exec(text.trim());
  if (!m) return null;
  const from = parseLocalDateTime(`${m[0]}T00:00`, timeZone);
  if (!from) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  const to = zonedTimeToUtc(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 },
    timeZone,
  );
  return { from, to };
}

/** "2026-11-17T10:00" no fuso do salão: o formato que a IA devolve para agendar. */
export function toLocalIso(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}
