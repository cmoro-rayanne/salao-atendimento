/**
 * Cria um usuário do painel.
 * Uso: ADMIN_PASSWORD='...' npm run admin:create -- --tenant 1 --email dono@academia.com.br --role dono
 * A senha vem por variável de ambiente para não ficar no histórico do shell como argumento.
 */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ScryptPasswordHasher } from '../adapters/crypto/scrypt-hasher.js';
import { PgAdminUserRepository } from '../adapters/db/admin-repositories.js';
import { createSql } from '../adapters/db/client.js';
import { normalizeEmail } from '../modules/auth/login.js';

const Args = z.object({
  tenant: z.coerce.number().int().positive(),
  email: z.email(),
  role: z.enum(['dono', 'recepcao']),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { tenant: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', default: 'dono' } },
  });
  const args = Args.parse(values);
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (password.length < 10) throw new Error('Defina ADMIN_PASSWORD com pelo menos 10 caracteres');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');

  const sql = createSql(url);
  try {
    const user = await new PgAdminUserRepository(sql).create({
      tenantId: args.tenant,
      email: normalizeEmail(args.email),
      passwordHash: await new ScryptPasswordHasher().hash(password),
      role: args.role,
      mustChangePassword: false,
    });
    if (!user) throw new Error('Esse e-mail já tem acesso ao painel.');
    console.log(`usuário criado: ${user.email} (${user.role}) na academia ${user.tenantId}`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
