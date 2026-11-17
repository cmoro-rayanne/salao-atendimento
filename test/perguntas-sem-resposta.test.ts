import { describe, expect, it } from 'vitest';
import { sanitizeQuestion } from '../src/modules/handoff/sanitize-question.js';
import { transferToHuman } from '../src/modules/handoff/transfer-to-human.js';

describe('sanitizeQuestion', () => {
  it.each([
    ['Vocês têm natação?', 'Vocês têm natação?'],
    ['  tem   aula  de  dança? ', 'tem aula de dança?'],
    ['Me liga no (41) 99999-1234 pra falar de natação', 'Me liga no [removido] pra falar de natação'],
    ['Meu CPF é 123.456.789-00, tem desconto?', 'Meu CPF é [removido], tem desconto?'],
    ['Manda para ana.silva+gym@mail.com.br o horário', 'Manda para [removido] o horário'],
    ['Abre às 6h? E no dia 25/12?', 'Abre às 6h? E no dia 25/12?'],
  ])('%s', (raw, expected) => {
    expect(sanitizeQuestion(raw)).toBe(expected);
  });

  it('vazio ou curto vira null; longo é cortado', () => {
    expect(sanitizeQuestion(undefined)).toBeNull();
    expect(sanitizeQuestion('  ')).toBeNull();
    expect(sanitizeQuestion('x'.repeat(500))).toHaveLength(300);
  });
});

describe('transferToHuman com pergunta sem resposta', () => {
  it('grava a pergunta higienizada e a mostra na nota para a equipe', async () => {
    const notes: string[] = [];
    const records: unknown[][] = [];
    await transferToHuman(
      {
        inbox: { addPrivateNote: async (_a, _c, note) => void notes.push(note), assignToTeam: async () => {} },
        handoffs: { record: async (...args) => void records.push(args) },
      },
      { tenantId: 1, accountId: 1, conversationId: 9, reason: 'Não está na base', unansweredQuestion: 'Tem natação? meu zap 41999991234' },
    );
    expect(records).toEqual([[9, 'Não está na base', 1, 'Tem natação? meu zap [removido]']]);
    expect(notes[0]).toContain('Não está na base: Tem natação? meu zap [removido]');
  });

  it('sem a pergunta, grava null', async () => {
    const records: unknown[][] = [];
    await transferToHuman(
      { inbox: { addPrivateNote: async () => {}, assignToTeam: async () => {} }, handoffs: { record: async (...a) => void records.push(a) } },
      { tenantId: 1, accountId: 1, conversationId: 9, reason: 'Quer se matricular' },
    );
    expect(records).toEqual([[9, 'Quer se matricular', 1, null]]);
  });
});
