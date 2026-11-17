/** Utilitários de fuso sem dependência: usam a base de fusos do próprio Node (Intl). */

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

/** Converte um horário de parede no fuso dado para o instante UTC correspondente. */
export function zonedTimeToUtc(p: LocalParts, timeZone: string): Date {
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Duas passadas resolvem a diferença de fuso (inclusive perto de mudança de horário de verão).
  let guess = asIfUtc;
  for (let i = 0; i < 2; i++) {
    const seen = localParts(new Date(guess), timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    guess += asIfUtc - seenUtc;
  }
  return new Date(guess);
}

export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
