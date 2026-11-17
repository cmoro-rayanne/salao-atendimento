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
