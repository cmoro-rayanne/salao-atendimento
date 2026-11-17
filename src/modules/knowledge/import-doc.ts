/**
 * Lê o Markdown exportado do documento "Base de conhecimento da IA" (modelo em Docs).
 * Função pura: os títulos `##`, as tabelas e as listas `**Rótulo:** valor` do modelo são o contrato.
 */
import type { KnowledgeItem } from './ports.js';

export interface EvalCase {
  pergunta: string;
  espera: {
    contem?: string[];
    contem_algum?: string[];
    transfere?: boolean;
  };
  /** Sem critério objetivo: alguém precisa escrever o `espera` antes de o eval usar o caso. */
  revisar?: true;
  resposta_referencia?: string;
}

export interface ParsedKnowledgeDoc {
  /** Do título "Base de conhecimento da IA — <salão>", se houver. */
  salonName: string | null;
  items: KnowledgeItem[];
  /** Campos ainda com `[preencher]`, como "O salão › Endereço". */
  pending: string[];
  receptionHours: { open: number; close: number } | null;
  warnings: string[];
  evalCases: EvalCase[];
}

const PLACEHOLDER = /\[\s*preencher[^\]]*\]/i;
const PLACEHOLDER_ALL = /\[\s*preencher[^\]]*\]/gi;

interface Table {
  header: string[];
  rows: string[][];
}
interface Bullet {
  label: string | null;
  value: string;
}
type Block = { kind: 'table'; table: Table } | { kind: 'bullet'; bullet: Bullet };
interface Section {
  title: string;
  blocks: Block[];
}

export function parseKnowledgeDoc(markdown: string): ParsedKnowledgeDoc {
  const title = /^#\s+.*?[—–-]\s*(.+)$/m.exec(markdown);
  const out: ParsedKnowledgeDoc = {
    salonName: title ? clean(title[1] ?? '') || null : null,
    items: [],
    pending: [],
    receptionHours: null,
    warnings: [],
    evalCases: [],
  };

  for (const section of splitSections(markdown)) {
    const key = normalize(section.title);
    if (key.startsWith('como preencher')) continue;
    if (key.startsWith('perguntas')) {
      parseEvalCases(section, out);
      continue;
    }

    const lines: string[] = [];
    for (const block of section.blocks) {
      if (block.kind === 'bullet') {
        const line = bulletLine(section.title, block.bullet, out.pending);
        if (line) lines.push(line);
        continue;
      }
      const { table } = block;
      lines.push(...tableLines(section.title, table, out.pending));
      if (normalize(table.header[0] ?? '') === 'assunto') findReceptionHours(table, out);
    }
    if (lines.length > 0) out.items.push({ category: section.title, content: lines.join('\n') });
  }
  return out;
}

// ---------- Estrutura do Markdown ----------

function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let tableLinesBuf: string[] = [];

  const flushTable = () => {
    if (current && tableLinesBuf.length >= 2) {
      const [head, , ...body] = tableLinesBuf.map(splitRow);
      current.blocks.push({ kind: 'table', table: { header: head ?? [], rows: body } });
    }
    tableLinesBuf = [];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      tableLinesBuf.push(line);
      continue;
    }
    flushTable();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      current = { title: clean(heading[1] ?? ''), blocks: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet && current) current.blocks.push({ kind: 'bullet', bullet: splitBullet(bullet[1] ?? '') });
  }
  flushTable();
  return sections;
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cell += ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  // Tira as bordas: "| a | b |" → ["", " a ", " b ", ""].
  return cells.slice(1, line.trimEnd().endsWith('|') ? -1 : undefined).map(clean);
}

function splitBullet(text: string): Bullet {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
  if (!m) return { label: null, value: clean(text) };
  return { label: clean(m[1] ?? '').replace(/:$/, ''), value: clean(m[2] ?? '') };
}

/** Tira o escape e a formatação do Markdown exportado. */
function clean(text: string): string {
  return text
    .replace(/\\([\\[\]|*_`#>+\-.!(){}])/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

// ---------- Conteúdo da base ----------

/** Remove as frases ainda com `[preencher]`; o que sobrar da célula é aproveitado. */
function filled(value: string): string {
  if (!PLACEHOLDER.test(value)) return value;
  return value
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !PLACEHOLDER.test(sentence))
    .join(' ')
    .replace(PLACEHOLDER_ALL, '')
    .trim();
}

function tableLines(section: string, table: Table, pending: string[]): string[] {
  const lines: string[] = [];
  for (const row of table.rows) {
    const label = filled(row[0] ?? '');
    const rest = row.slice(1);
    const blankRow = row.every((c) => !c || (PLACEHOLDER.test(c) && !filled(c)));
    if (blankRow) continue; // linha extra do modelo que ninguém usou
    if (row.some((c) => PLACEHOLDER.test(c))) pending.push(`${section} › ${label || 'linha sem nome'}`);
    if (!label) continue;

    const values = rest.map((c, i) => ({ header: table.header[i + 1] ?? '', value: filled(c) })).filter((v) => v.value);
    if (values.length === 0) continue;
    if (table.header.length <= 2) {
      lines.push(`${label}: ${values[0]?.value}`);
    } else {
      lines.push(`${label} (${values.map((v) => `${v.header}: ${v.value}`).join('; ')})`);
    }
  }
  return lines;
}

function bulletLine(section: string, bullet: Bullet, pending: string[]): string | null {
  const value = filled(bullet.value);
  if (PLACEHOLDER.test(bullet.value)) pending.push(`${section} › ${bullet.label ?? bullet.value}`);
  if (!value) return null;
  if (!bullet.label) return value;
  return /[?:]$/.test(bullet.label) ? `${bullet.label} ${value}` : `${bullet.label}: ${value}`;
}

// ---------- Horário da recepção ----------

function findReceptionHours(table: Table, out: ParsedKnowledgeDoc): void {
  const row = table.rows.find((r) => normalize(r[0] ?? '').includes('recepcao'));
  if (!row) return;
  const value = filled(row[1] ?? '');
  if (!value) return;
  const weekday = value.split(/(?<=\.)\s+/).find((s) => /seg/i.test(s)) ?? value;
  const m = /(\d{1,2})(?:\s*h|:)(\d{2})?\s*(?:às|as|a|-|–|até|ate)\s*(\d{1,2})(?:\s*h|:)(\d{2})?/i.exec(weekday);
  const open = Number(m?.[1]);
  const close = Number(m?.[3]);
  const minutes = [m?.[2], m?.[4]].filter((x) => x && x !== '00');
  if (!m || minutes.length > 0 || !(open >= 0 && close <= 24 && open < close)) {
    out.warnings.push(
      `Horário da recepção: não deu para ler "${weekday}" como horas cheias (ex.: 7h às 21h). Ajuste em Configurações.`,
    );
    return;
  }
  out.receptionHours = { open, close };
}

// ---------- Casos de avaliação ----------

function parseEvalCases(section: Section, out: ParsedKnowledgeDoc): void {
  for (const block of section.blocks) {
    if (block.kind !== 'table') continue;
    for (const row of block.table.rows) {
      const [q = '', a = ''] = row;
      if (PLACEHOLDER.test(q) || PLACEHOLDER.test(a) || !q || !a) continue;
      out.evalCases.push(evalCaseFrom(q, a));
    }
  }
}

function evalCaseFrom(pergunta: string, resposta: string): EvalCase {
  if (/passar para a equipe|transferir|com a equipe|com a recep/i.test(resposta)) {
    return { pergunta, espera: { transfere: true } };
  }
  const money = [...resposta.matchAll(/\d{1,3}(?:\.\d{3})*,\d{2}/g)].map((m) => m[0]);
  if (money.length > 0) return { pergunta, espera: { contem: [...new Set(money)] } };
  const hours = [...resposta.matchAll(/\b(\d{1,2})h(\d{2})?\b/g)];
  if (hours.length > 0) {
    const variants = hours.flatMap((m) => {
      const h = m[1] ?? '';
      const min = m[2] ?? '00';
      return [m[0], `${h}:${min}`, `${h.padStart(2, '0')}:${min}`];
    });
    return { pergunta, espera: { contem_algum: [...new Set(variants)] } };
  }
  return { pergunta, espera: {}, revisar: true, resposta_referencia: resposta };
}
