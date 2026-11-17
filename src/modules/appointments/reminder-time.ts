import { localParts, zonedTimeToUtc } from '../../shared/time-zone.js';

const HOUR = 60 * 60 * 1000;

/**
 * Quando mandar o lembrete: véspera às 18 h no fuso do salão; se já passou,
 * 3 h antes do horário; se nem isso dá mais, não manda (a pessoa acabou de agendar).
 */
export function reminderTime(startsAt: Date, timeZone: string, now: Date): Date | null {
  const local = localParts(startsAt, timeZone);
  const eveDate = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
  const eve = zonedTimeToUtc(
    { year: eveDate.getUTCFullYear(), month: eveDate.getUTCMonth() + 1, day: eveDate.getUTCDate(), hour: 18, minute: 0 },
    timeZone,
  );
  if (eve.getTime() > now.getTime()) return eve;

  const threeBefore = new Date(startsAt.getTime() - 3 * HOUR);
  return threeBefore.getTime() > now.getTime() ? threeBefore : null;
}
