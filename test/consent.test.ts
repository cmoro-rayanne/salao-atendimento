import { describe, expect, it } from 'vitest';
import { parseConsentCommand } from '../src/modules/consent/commands.js';

describe('parseConsentCommand', () => {
  it.each([
    ['SAIR', 'opt_out'],
    ['sair!', 'opt_out'],
    ['  Sáir  ', 'opt_out'],
    ['PARAR', 'opt_out'],
    ['stop 🛑', 'opt_out'],
    ['Não quero receber', 'opt_out'],
    ['voltar', 'opt_in'],
    ['VOLTAR.', 'opt_in'],
  ])('%s → %s', (text, expected) => {
    expect(parseConsentCommand(text)).toBe(expected);
  });

  it.each(['quero sair da academia', 'como faço para sair do plano?', 'vou voltar a treinar', 'oi'])('%s não é comando', (text) => {
    expect(parseConsentCommand(text)).toBeNull();
  });
});
