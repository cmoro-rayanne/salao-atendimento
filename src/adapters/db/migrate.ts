import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql } from './client.js';

/**
 * Runner mínimo de migrations: aplica, em ordem, os .sql ainda não aplicados,
 * cada um numa transação. Sem down migrations: corrige-se com uma nova.
 */
async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  const sql = createSql(url);
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(dir, file), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${file})`;
      });
      console.log(`migration aplicada: ${file}`);
    }
  } finally {
    await sql.end();
  }
}

migrate().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
