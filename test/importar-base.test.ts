import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKnowledgeDoc } from '../src/modules/knowledge/import-doc.js';
import { importKnowledgeDoc, type ImportDeps } from '../src/modules/knowledge/import-knowledge.js';
import type { EditableKnowledgeItem } from '../src/modules/knowledge/ports.js';
import type { TenantSettings } from '../src/modules/settings/ports.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.md`, import.meta.url), 'utf8');
const TZ = 'America/Sao_Paulo';

describe('parseKnowledgeDoc', () => {
  it('modelo vazio: nenhum item e todas as pendências', () => {
    const doc = parseKnowledgeDoc(fixture('base-modelo'));
    expect(doc.items).toEqual([]);
    expect(doc.pending).toContain('O salão › Endereço');
    expect(doc.pending).toContain('Agendamento › Atraso');
    expect(doc.pending).toHaveLength(21);
    expect(doc.receptionHours).toBeNull();
    expect(doc.evalCases).toEqual([]);
  });

  it('documento preenchido: base, recepção e casos', () => {
    const doc = parseKnowledgeDoc(fixture('base-preenchida'));
    expect(doc.salonName).toBe('Studio Aurora');
    expect(doc.items.map((i) => i.category)).toEqual([
      'O salão',
      'Serviços e preços',
      'Agendamento',
      'Regras e outras informações',
    ]);
    const salao = doc.items[0]!.content;
    expect(salao).toContain('Endereço: Rua Exemplo, 100, Centro. Em frente à praça.');
    // A frase do sábado ainda sem preencher sai; o resto da célula fica.
    expect(salao).toContain('Horário da recepção: Terça a sexta: 9h às 19h.');
    expect(salao).not.toMatch(/preencher/i);
    expect(doc.items[1]!.content).toContain('Corte (O que inclui: Lavagem e finalização; Preço: R$ 90,00)');
    expect(doc.items.every((i) => !/preencher|\\\[/.test(i.content))).toBe(true);
    // Instruções para o salão não entram na base.
    expect(doc.items.some((i) => /Como preencher/.test(i.category + i.content))).toBe(false);

    expect(doc.receptionHours).toEqual({ open: 9, close: 19 });
    expect(doc.pending).toContain('O salão › Horário da recepção');
    expect(doc.warnings).toEqual([]);

    expect(doc.evalCases).toEqual([
      { pergunta: 'quanto ta o corte?', espera: { contem: ['90,00'] } },
      { pergunta: 'quero cancelar meu horário', espera: { transfere: true } },
      { pergunta: 'tem escova de manhã?', espera: { contem_algum: ['9h', '9:00', '09:00'] } },
      { pergunta: 'vcs tem estacionamento?', espera: {}, revisar: true, resposta_referencia: 'Não temos estacionamento próprio' },
    ]);
  });

  it('recepção com minutos não é chutada', () => {
    const md = '## O salão\n\n| Assunto | O que a IA deve saber |\n| --- | --- |\n| Horário da recepção | Segunda a sexta: 7h30 às 21h |\n';
    const doc = parseKnowledgeDoc(md);
    expect(doc.receptionHours).toBeNull();
    expect(doc.warnings[0]).toMatch(/horas cheias/);
  });
});

function fakeDeps(initialItems: EditableKnowledgeItem[] = []) {
  let kb = { version: 3, items: initialItems };
  let settings: TenantSettings = { name: 'Cia', timeZone: TZ, receptionHours: null, privacyUrl: null, lateToleranceMin: 15 };
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
  };
  return { deps, getKb: () => kb, getSettings: () => settings };
}

describe('importKnowledgeDoc', () => {
  const doc = parseKnowledgeDoc(fixture('base-preenchida'));
  const opts = { replace: false };

  it('grava base e horário da recepção; rodar de novo com replace mantém o resultado', async () => {
    const { deps, getKb, getSettings } = fakeDeps();
    const r = await importKnowledgeDoc(deps, 1, doc, opts);
    expect(r).toEqual({ ok: true, knowledgeVersion: 4, itemCount: 4, receptionHoursUpdated: true });
    expect(getKb().items.every((i) => i.active)).toBe(true);
    expect(getSettings().receptionHours).toEqual({ open: 9, close: 19 });

    const again = await importKnowledgeDoc(deps, 1, doc, { ...opts, replace: true });
    expect(again).toMatchObject({ ok: true, itemCount: 4 });
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
