import { describe, expect, it } from 'vitest';
import { categorizeHandoff } from '../src/modules/reports/handoff-categories.js';
import { monthRange } from '../src/modules/reports/monthly-report.js';

describe('categorias de transferência', () => {
  it.each([
    ['Quer se matricular no plano mensal', 'Matrícula ou pagamento'],
    ['Perguntou sobre pagamento no PIX', 'Matrícula ou pagamento'],
    ['Machucou o joelho e quer saber se pode treinar', 'Lesão ou saúde'],
    ['Pediu para falar com uma atendente', 'Pediu para falar com alguém'],
    ['Quer cancelar o plano', 'Reclamação ou cancelamento'],
    ['Pergunta sobre natação não está na base', 'Dúvida fora da base'],
    ['Falha técnica ao responder.', 'Falha técnica'],
    ['A IA não concluiu em 5 passos.', 'Falha técnica'],
    ['Quer saber do estacionamento', 'Outros'],
  ])('%s → %s', (reason, label) => {
    expect(categorizeHandoff(reason)).toBe(label);
  });
});

describe('monthRange', () => {
  it('começa e termina à meia-noite do fuso da academia, inclusive em dezembro', () => {
    expect(monthRange('2026-11', 'America/Sao_Paulo')).toEqual({
      from: new Date('2026-11-01T03:00:00Z'),
      to: new Date('2026-12-01T03:00:00Z'),
    });
    expect(monthRange('2026-12', 'America/Sao_Paulo').to).toEqual(new Date('2027-01-01T03:00:00Z'));
  });
});
