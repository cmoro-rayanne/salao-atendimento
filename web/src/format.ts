/** Formatação compartilhada pelas telas, sempre no fuso da academia. */

export function fmt(date: Date | string, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, ...opts }).format(new Date(date));
}

/** "+5541999990000" → "(41) 99999-0000"; outros formatos voltam como vieram. */
export function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

export const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const brl = (v: number | null) =>
  v === null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Início do mês corrente (horário local do navegador) e do seguinte. */
export function monthBounds(offset = 0): { from: Date; to: Date } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth() + offset, 1),
    to: new Date(now.getFullYear(), now.getMonth() + offset + 1, 1),
  };
}

/** Data ("2026-11-17") e hora ("09:30") do salão → instante ISO. Usa o fuso do salão, não o do navegador. */
export function salonTimeToIso(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      })
        .formatToParts(new Date(ms))
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - ms;
  };
  const guess = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(guess)).toISOString();
}

/** "2026-11-17" de hoje (ou de `ms`) no fuso do salão. */
export function salonDay(timeZone: string | undefined, ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(ms));
}

export const minutesToTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const timeToMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
