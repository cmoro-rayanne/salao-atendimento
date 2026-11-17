/**
 * Importa o documento "Base de conhecimento da IA" exportado em Markdown.
 * Uso:
 *   npm run kb:import -- --file base.md                       # só mostra o relatório, não toca o banco
 *   npm run kb:import -- --file base.md --tenant 1 --apply    # grava base, recepção e grade
 * Opções: --replace (troca uma base que já tem itens), --weeks 4, --eval-dir eval/academia
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  PgKnowledgeAdminRepository,
  PgTenantSettingsRepository,
  PgTrialSlotRepository,
} from '../adapters/db/admin-repositories.js';
import { createSql } from '../adapters/db/client.js';
import { parseKnowledgeDoc, type ParsedKnowledgeDoc } from '../modules/knowledge/import-doc.js';
import { expandTrialRules, importKnowledgeDoc } from '../modules/knowledge/import-knowledge.js';
import { formatLocal } from '../shared/time-zone.js';

const Args = z.object({
  file: z.string().min(1),
  tenant: z.coerce.number().int().positive().optional(),
  apply: z.boolean().default(false),
  replace: z.boolean().default(false),
  weeks: z.coerce.number().int().min(1).max(12).default(4),
  'eval-dir': z.string().optional(),
  'time-zone': z.string().default('America/Sao_Paulo'),
});

const DAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function report(doc: ParsedKnowledgeDoc, timeZone: string, weeks: number): void {
  const chars = doc.items.reduce((n, i) => n + i.category.length + i.content.length, 0);
  console.log(`\nBase: ${doc.items.length} itens, ${chars} caracteres`);
  for (const i of doc.items) console.log(`\n## ${i.category}\n${i.content}`);

  console.log(`\nHorário da recepção: ${doc.receptionHours ? `${doc.receptionHours.open}h às ${doc.receptionHours.close}h` : 'não alterado'}`);

  console.log('\nGrade da experimental:');
  if (doc.trialRules.length === 0) console.log('  (nenhum horário)');
  for (const r of doc.trialRules) {
    const times = r.times.map((t) => `${t.hour}h${t.minute ? String(t.minute).padStart(2, '0') : ''}`).join(', ');
    console.log(`  ${r.modality}: ${r.weekdays.map((d) => DAYS[d]).join('/')} ${times} (${r.capacity} vagas)`);
  }
  const slots = expandTrialRules(doc.trialRules, new Date(), weeks, timeZone);
  if (slots.length > 0) {
    console.log(`  → ${slots.length} horários nas próximas ${weeks} semanas, de ${formatLocal(slots[0]!.startsAt, timeZone)} a ${formatLocal(slots.at(-1)!.startsAt, timeZone)}`);
  }

  const review = doc.evalCases.filter((c) => c.revisar).length;
  console.log(`\nCasos de avaliação: ${doc.evalCases.length} (${review} para revisar)`);

  if (doc.warnings.length > 0) {
    console.log('\nAvisos:');
    for (const w of doc.warnings) console.log(`  - ${w}`);
  }
  if (doc.pending.length > 0) {
    console.log(`\nAinda sem preencher (${doc.pending.length}), a IA vai passar essas perguntas para a equipe:`);
    for (const p of doc.pending) console.log(`  - ${p}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      tenant: { type: 'string' },
      apply: { type: 'boolean' },
      replace: { type: 'boolean' },
      weeks: { type: 'string' },
      'eval-dir': { type: 'string' },
      'time-zone': { type: 'string' },
    },
  });
  const args = Args.parse(values);
  const doc = parseKnowledgeDoc(await readFile(args.file, 'utf8'));
  report(doc, args['time-zone'], args.weeks);

  if (args['eval-dir']) {
    await mkdir(args['eval-dir'], { recursive: true });
    const base = {
      academia: doc.academyName ?? 'Academia',
      aviso: `Gerado de ${args.file} pelo importador.`,
      versao: 1,
      itens: doc.items.map((i) => ({ categoria: i.category, conteudo: i.content })),
    };
    await writeFile(join(args['eval-dir'], 'base.json'), `${JSON.stringify(base, null, 2)}\n`);
    await writeFile(join(args['eval-dir'], 'casos.json'), `${JSON.stringify(doc.evalCases, null, 2)}\n`);
    console.log(`\nEval: ${args['eval-dir']}/base.json e casos.json (EVAL_BASE e EVAL_CASOS)`);
  }

  if (!args.apply) {
    console.log('\nNada foi gravado. Para gravar: --tenant <id> --apply');
    return;
  }
  if (!args.tenant) throw new Error('Informe --tenant para gravar.');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');

  const sql = createSql(url);
  try {
    const result = await importKnowledgeDoc(
      {
        knowledge: new PgKnowledgeAdminRepository(sql),
        slots: new PgTrialSlotRepository(sql),
        settings: new PgTenantSettingsRepository(sql),
      },
      args.tenant,
      doc,
      { replace: args.replace, weeks: args.weeks, now: new Date() },
    );
    if (!result.ok) throw new Error(result.error);
    console.log(
      `\nGravado na academia ${args.tenant}: base versão ${result.knowledgeVersion} (${result.itemCount} itens), ` +
        `recepção ${result.receptionHoursUpdated ? 'atualizada' : 'sem mudança'}, ` +
        `${result.slotsCreated} horários criados, ${result.slotsSkipped} já existiam.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
