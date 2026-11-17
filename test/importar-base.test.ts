import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKnowledgeDoc, parseWeeklySchedule } from '../src/modules/knowledge/import-doc.js';
import { expandTrialRules, importKnowledgeDoc, type ImportDeps } from '../src/modules/knowledge/import-knowledge.js';
import type { EditableKnowledgeItem } from '../src/modules/knowledge/ports.js';
import type { TenantSettings } from '../src/modules/settings/ports.js';
import type { TrialSlot } from '../src/modules/trial-classes/ports.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-16T14:00:00-03:00'); // segunda
const TZ = 'America/Sao_Paulo';

describe('parseKnowledgeDoc', () => {
  it('modelo vazio: só o que o próprio modelo já escreve, e todas as pendências', () => {
    const doc = parseKnowledgeDoc(fixture('base-modelo'));
    expect(doc.items).toEqual([
      { category: 'Modalidades e grade das aulas', content: 'Musculação (Dias e horários: Livre, no horário da academia)' },
    ]);
    expect(doc.pending).toContain('A academia › Endereço');
    expect(doc.pending).toContain('Aula experimental › É gratuita?');
    expect(doc.pending).toHaveLength(27);
    expect(doc.receptionHours).toBeNull();
    expect(doc.trialRules).toEqual([]);
    expect(doc.evalCases).toEqual([]);
  });

  it('documento preenchido: base, recepção, grade e casos', () => {
    const doc = parseKnowledgeDoc(fixture('base-preenchida'));
    expect(doc.academyName).toBe('Cia da Forma');
    expect(doc.items.map((i) => i.category)).toEqual([
      'A academia',
      'Planos, preços e matrícula',
      'Modalidades e grade das aulas',
      'Aula experimental',
      'Regras e outras informações',
    ]);
    const academia = doc.items[0]!.content;
    expect(academia).toContain('Endereço: Rua Exemplo, 100, Centro. Em frente à praça.');
    // A frase do sábado ainda sem preencher sai; o resto da célula fica.
    expect(academia).toContain('Horário da recepção: Segunda a sexta: 7h às 21h.');
    expect(academia).not.toMatch(/preencher/i);
    expect(doc.items[3]!.content).toContain('É gratuita? Sim, uma aula grátis.');
    expect(doc.items[1]!.content).toContain('Mensal (O que inclui: Musculação e aulas coletivas; Preço: R$ 149,90)');
    expect(doc.items[1]!.content).not.toContain('Semestral');
    expect(doc.items.every((i) => !/preencher|\\\[/.test(i.content))).toBe(true);
    // Instruções para a academia e a tabela da grade não entram na base.
    expect(doc.items.some((i) => /Como preencher|Vagas por horário/.test(i.category + i.content))).toBe(false);

    expect(doc.receptionHours).toEqual({ open: 7, close: 21 });
    expect(doc.pending).toContain('A academia › Horário da recepção');

    expect(doc.trialRules).toEqual([
      { modality: 'Musculação', capacity: 3, weekdays: [1, 2, 3, 4, 5], times: [{ hour: 7, minute: 0 }, { hour: 18, minute: 30 }] },
      { modality: 'Musculação', capacity: 3, weekdays: [6], times: [{ hour: 9, minute: 0 }] },
      { modality: 'Pilates', capacity: 4, weekdays: [2, 4], times: [{ hour: 8, minute: 0 }, { hour: 18, minute: 0 }] },
    ]);
    expect(doc.warnings).toEqual([expect.stringContaining('Funcional')]);

    expect(doc.evalCases).toEqual([
      { pergunta: 'quanto ta a mensalidade?', espera: { contem: ['149,90'] } },
      { pergunta: 'quero me matricular', espera: { transfere: true } },
      { pergunta: 'tem pilates de manhã?', espera: { contem_algum: ['8h', '8:00', '08:00'] } },
      { pergunta: 'vcs tem vestiário?', espera: {}, revisar: true, resposta_referencia: 'Sim, com chuveiro' },
    ]);
  });

  it('recepção com minutos não é chutada', () => {
    const md = '## A academia\n\n| Assunto | O que a IA deve saber |\n| --- | --- |\n| Horário da recepção | Segunda a sexta: 7h30 às 21h |\n';
    const doc = parseKnowledgeDoc(md);
    expect(doc.receptionHours).toBeNull();
    expect(doc.warnings[0]).toMatch(/horas cheias/);
  });
});

describe('parseWeeklySchedule', () => {
  it.each([
    ['seg/qua/sex 7h e 19h', [[1, 3, 5], ['7:0', '19:0']]],
    ['Segunda a sexta 07:00', [[1, 2, 3, 4, 5], ['7:0']]],
    ['seg-sex 6h30', [[1, 2, 3, 4, 5], ['6:30']]],
    ['sábado 9h', [[6], ['9:0']]],
    ['terça-feira e quinta-feira 18h', [[2, 4], ['18:0']]],
    ['sex a seg 10h', [[0, 1, 5, 6], ['10:0']]],
    ['todos os dias 8h', [[0, 1, 2, 3, 4, 5, 6], ['8:0']]],
  ] as const)('%s', (text, [days, times]) => {
    const r = parseWeeklySchedule(text);
    expect('groups' in r && r.groups[0]).toEqual({
      weekdays: days,
      times: times.map((t) => ({ hour: Number(t.split(':')[0]), minute: Number(t.split(':')[1]) })),
    });
  });

  it.each(['toda hora', 'seg e qua', '7h e 19h', 'seg 25h'])('recusa "%s"', (text) => {
    expect(parseWeeklySchedule(text)).toHaveProperty('error');
  });
});

describe('expandTrialRules', () => {
  it('gera as próximas semanas a partir de amanhã, no fuso da academia', () => {
    const slots = expandTrialRules(
      [{ modality: 'Pilates', capacity: 4, weekdays: [1, 2], times: [{ hour: 8, minute: 0 }] }],
      NOW,
      2,
      TZ,
    );
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-11-17T11:00:00.000Z', // terça 8h em Brasília (UTC-3)
      '2026-11-23T11:00:00.000Z',
      '2026-11-24T11:00:00.000Z',
      '2026-11-30T11:00:00.000Z',
    ]);
  });
});

function fakeDeps(initialItems: EditableKnowledgeItem[] = []) {
  let kb = { version: 3, items: initialItems };
  let settings: TenantSettings = { name: 'Cia', timeZone: TZ, receptionHours: null, privacyUrl: null };
  const slots: TrialSlot[] = [];
  const deps: ImportDeps = {
    knowledge: {
      getForEdit: async () => kb,
      replaceAll: async (_t, expected, items) => {
        if (expected !== kb.version) return { ok: false, currentVersion: kb.version };
        kb = { version: kb.version + 1, items: items.map((i, n) => ({ ...i, id: n + 1 })) };
        return { ok: true, version: kb.version };
      },
      listVersions: async () => [],
      getVersion: async () => null,
    },
    settings: {
      get: async () => settings,
      save: async (_t, s) => {
        settings = s;
      },
    },
    slots: {
      list: async (_t, from, to) => slots.filter((s) => s.startsAt >= from && s.startsAt < to),
      create: async (_t, s) => {
        const slot = { ...s, id: slots.length + 1, booked: 0 };
        slots.push(slot);
        return slot;
      },
      updateCapacity: async () => 'ok',
      delete: async () => 'ok',
    },
  };
  return { deps, slots, getKb: () => kb, getSettings: () => settings };
}

describe('importKnowledgeDoc', () => {
  const doc = parseKnowledgeDoc(fixture('base-preenchida'));
  const opts = { replace: false, weeks: 1, now: NOW };

  it('grava base, horário da recepção e a grade; rodar de novo não duplica horários', async () => {
    const { deps, slots, getKb, getSettings } = fakeDeps();
    const r = await importKnowledgeDoc(deps, 1, doc, opts);
    // Musculação: 7h e 18h30 de ter a sex (4 dias úteis até domingo) + seg 23 = 5 dias × 2, sáb 9h; Pilates ter/qui 8h e 18h.
    expect(r).toEqual({ ok: true, knowledgeVersion: 4, itemCount: 5, receptionHoursUpdated: true, slotsCreated: 15, slotsSkipped: 0 });
    expect(getKb().items.every((i) => i.active)).toBe(true);
    expect(getSettings().receptionHours).toEqual({ open: 7, close: 21 });
    expect(slots.filter((s) => s.modality === 'Pilates')).toHaveLength(4);

    const again = await importKnowledgeDoc(deps, 1, doc, { ...opts, replace: true });
    expect(again).toMatchObject({ ok: true, slotsCreated: 0, slotsSkipped: 15 });
    expect(slots).toHaveLength(15);
  });

  it('não troca uma base que já tem itens sem --replace', async () => {
    const { deps, getKb } = fakeDeps([{ id: 1, category: 'Editado no painel', content: 'x', active: true }]);
    const r = await importKnowledgeDoc(deps, 1, doc, opts);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('--replace') });
    expect(getKb().items[0]?.category).toBe('Editado no painel');
  });

  it('documento sem nada preenchido não grava', async () => {
    const { deps } = fakeDeps();
    const empty = { ...parseKnowledgeDoc(fixture('base-modelo')), items: [] };
    expect(await importKnowledgeDoc(deps, 1, empty, opts)).toEqual({ ok: false, error: expect.any(String) });
  });
});
