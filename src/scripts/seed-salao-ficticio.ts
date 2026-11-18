/**
 * Carga de um salão fictício (serviços, duas profissionais e expediente) para testar a agenda e a IA.
 * Uso: DATABASE_URL=... npm run salao:seed -- --tenant 1
 * Só carrega se o salão ainda não tiver serviços. Dados inventados, sem cliente real.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { PgAgendaAdminRepository } from '../adapters/db/agenda-admin-repository.js';
import { createSql } from '../adapters/db/client.js';

export const SalaoFicticio = z.object({
  salao: z.string(),
  servicos: z.array(
    z.object({
      nome: z.string().min(1),
      duracaoMin: z.number().int().min(5).max(480),
      precoCentavos: z.number().int().min(0).nullable(),
      descricao: z.string().nullable(),
    }),
  ),
  profissionais: z.array(
    z.object({
      nome: z.string().min(1),
      servicos: z.array(z.string()),
      expediente: z.array(z.object({ weekday: z.number().int(), startMin: z.number().int(), endMin: z.number().int() })),
    }),
  ),
});

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { tenant: { type: 'string' } } });
  const tenantId = z.coerce.number().int().positive().parse(values.tenant);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  const data = SalaoFicticio.parse(JSON.parse(await readFile('seed/salao-ficticio.json', 'utf8')));

  const sql = createSql(url);
  try {
    const admin = new PgAgendaAdminRepository(sql);
    if ((await admin.listServices(tenantId)).length) {
      console.log('O salão já tem serviços cadastrados; nada foi carregado.');
      return;
    }
    const ids = new Map<string, number>();
    for (const s of data.servicos) {
      const created = await admin.createService(tenantId, {
        name: s.nome,
        description: s.descricao,
        durationMin: s.duracaoMin,
        priceCents: s.precoCentavos,
        active: true,
      });
      ids.set(s.nome, created.id);
    }
    for (const p of data.profissionais) {
      const result = await admin.createProfessional(tenantId, {
        name: p.nome,
        active: true,
        serviceIds: p.servicos.map((n) => ids.get(n) ?? Number.NaN),
        hours: p.expediente,
      });
      if (result === 'invalid_services') throw new Error(`Serviço inexistente para ${p.nome}`);
    }
    console.log(`${data.salao}: ${data.servicos.length} serviços e ${data.profissionais.length} profissionais carregados.`);
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
