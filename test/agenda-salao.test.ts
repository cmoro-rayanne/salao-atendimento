import { describe, expect, it } from 'vitest';
import {
  computeFreeSlots,
  pickProfessional,
  type FreeSlotsQuery,
  type ProfessionalSchedule,
} from '../src/modules/appointments/availability.js';

const TZ = 'America/Sao_Paulo';
const at = (iso: string) => new Date(`${iso}-03:00`);
const NOW = at('2026-11-16T08:00:00'); // segunda-feira

// terça a sábado, 9h–12h e 13h–18h
const weekdays = [2, 3, 4, 5, 6];
const hours = weekdays.flatMap((weekday) => [
  { weekday, startMin: 9 * 60, endMin: 12 * 60 },
  { weekday, startMin: 13 * 60, endMin: 18 * 60 },
]);

const prof = (over: Partial<ProfessionalSchedule> = {}): ProfessionalSchedule => ({
  professionalId: 1,
  hours,
  timeOff: [],
  appointments: [],
  ...over,
});

const query = (over: Partial<FreeSlotsQuery> = {}): FreeSlotsQuery => ({
  schedules: [prof()],
  durationMin: 60,
  stepMin: 30,
  from: at('2026-11-17T00:00:00'),
  to: at('2026-11-18T00:00:00'), // só a terça
  now: NOW,
  minNoticeMin: 60,
  maxDaysAhead: 30,
  timeZone: TZ,
  ...over,
});

const times = (q: FreeSlotsQuery) =>
  computeFreeSlots(q).map((s) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(s.startsAt));

describe('horários livres', () => {
  it('gera horários nas duas faixas, sem atravessar o almoço', () => {
    const t = times(query());
    expect(t[0]).toBe('09:00');
    expect(t).toContain('11:00'); // 11h–12h cabe
    expect(t).not.toContain('11:30'); // passaria do meio-dia
    expect(t).not.toContain('12:00');
    expect(t).toContain('13:00');
    expect(t.at(-1)).toBe('17:00');
  });

  it('não oferece dia sem expediente (segunda e domingo)', () => {
    expect(computeFreeSlots(query({ from: at('2026-11-16T00:00:00'), to: at('2026-11-17T00:00:00'), now: at('2026-11-15T08:00:00') }))).toEqual([]);
  });

  it('duração maior reduz os horários possíveis', () => {
    const t = times(query({ durationMin: 150 })); // 2h30
    expect(t).toContain('09:00');
    expect(t).not.toContain('10:00'); // 10h–12h30 invade o almoço
    expect(t).toContain('13:00');
    expect(t).not.toContain('16:00'); // até 18h30
    expect(t.at(-1)).toBe('15:30');
  });

  it('passo de 15 min oferece mais horários que o de 30', () => {
    expect(computeFreeSlots(query({ stepMin: 15 })).length).toBeGreaterThan(computeFreeSlots(query({ stepMin: 30 })).length);
  });

  it('agendamento existente tira só os horários que se sobrepõem', () => {
    const t = times(query({ schedules: [prof({ appointments: [{ startsAt: at('2026-11-17T10:00:00'), endsAt: at('2026-11-17T11:00:00') }] })] }));
    expect(t).toContain('09:00'); // 9h–10h encosta, não sobrepõe
    expect(t).not.toContain('09:30');
    expect(t).not.toContain('10:00');
    expect(t).not.toContain('10:30');
    expect(t).toContain('11:00');
  });

  it('folga e bloqueio também tiram horários', () => {
    const t = times(query({ schedules: [prof({ timeOff: [{ startsAt: at('2026-11-17T13:00:00'), endsAt: at('2026-11-17T18:00:00') }] })] }));
    expect(t.every((h) => h < '12:00')).toBe(true);
  });

  it('respeita antecedência mínima', () => {
    const t = times(query({ now: at('2026-11-17T08:30:00'), minNoticeMin: 60 }));
    expect(t[0]).toBe('09:30'); // 9h:30 é o primeiro que começa depois de 1h
  });

  it('respeita limite de dias à frente', () => {
    const q = query({ from: at('2026-11-17T00:00:00'), to: at('2026-12-31T00:00:00'), maxDaysAhead: 3 });
    const last = computeFreeSlots(q).at(-1)!;
    expect(last.startsAt.getTime()).toBeLessThanOrEqual(NOW.getTime() + 3 * 24 * 3600 * 1000);
  });

  it('janela pedida limita o resultado', () => {
    const slots = computeFreeSlots(query({ from: at('2026-11-17T00:00:00'), to: at('2026-11-20T00:00:00') }));
    const days = new Set(slots.map((s) => s.startsAt.toISOString().slice(0, 10)));
    expect(days.size).toBe(3);
  });

  it('duas profissionais: horário ocupado de uma continua livre para a outra', () => {
    const busy = [{ startsAt: at('2026-11-17T09:00:00'), endsAt: at('2026-11-17T10:00:00') }];
    const slots = computeFreeSlots(query({ schedules: [prof({ professionalId: 1, appointments: busy }), prof({ professionalId: 2 })] }));
    const nine = slots.filter((s) => s.startsAt.getTime() === at('2026-11-17T09:00:00').getTime());
    expect(nine.map((s) => s.professionalId)).toEqual([2]);
  });

  it('faixas sobrepostas no cadastro não duplicam horários', () => {
    const dup = prof({ hours: [...hours, { weekday: 2, startMin: 9 * 60, endMin: 12 * 60 }] });
    const t = times(query({ schedules: [dup] }));
    expect(new Set(t).size).toBe(t.length);
  });

  it('entradas inválidas não geram horários', () => {
    expect(computeFreeSlots(query({ durationMin: 0 }))).toEqual([]);
    expect(computeFreeSlots(query({ stepMin: 0 }))).toEqual([]);
    expect(computeFreeSlots(query({ from: at('2026-11-18T00:00:00'), to: at('2026-11-17T00:00:00') }))).toEqual([]);
  });
});

describe('qualquer profissional', () => {
  it('escolhe quem tem menos agendamentos no dia; empate pelo menor id', () => {
    expect(pickProfessional([{ professionalId: 2, dayLoad: 1 }, { professionalId: 1, dayLoad: 3 }])).toBe(2);
    expect(pickProfessional([{ professionalId: 5, dayLoad: 2 }, { professionalId: 3, dayLoad: 2 }])).toBe(3);
    expect(pickProfessional([])).toBeNull();
  });
});
