import { describe, expect, it } from 'vitest';
import { overlappingHours } from '../src/http/agenda-routes.js';
import { normalizePhone } from '../src/modules/appointments/panel.js';

describe('normalizePhone', () => {
  it.each([
    ['(41) 99999-0001', '+5541999990001'],
    ['41 3333-4444', '+554133334444'],
    ['+55 41 99999-0001', '+5541999990001'],
    ['5541999990001', '+5541999990001'],
  ])('%s → %s', (raw, expected) => expect(normalizePhone(raw)).toBe(expected));

  it.each(['', '123', '999990001', '+1 415 555 0100', 'abc'])('recusa %s', (raw) => expect(normalizePhone(raw)).toBeNull());
});

describe('overlappingHours', () => {
  it('detecta sobreposição só dentro do mesmo dia', () => {
    expect(overlappingHours([{ weekday: 2, startMin: 540, endMin: 720 }, { weekday: 2, startMin: 700, endMin: 800 }])).toBe(true);
    expect(overlappingHours([{ weekday: 2, startMin: 540, endMin: 720 }, { weekday: 3, startMin: 600, endMin: 800 }])).toBe(false);
    expect(overlappingHours([{ weekday: 2, startMin: 540, endMin: 720 }, { weekday: 2, startMin: 720, endMin: 800 }])).toBe(false);
  });
});
