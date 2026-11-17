import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgAdminUserRepository,
  PgKnowledgeAdminRepository,
  PgTenantSettingsRepository,
} from '../../src/adapters/db/admin-repositories.js';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import { PgKnowledgeRepository } from '../../src/adapters/db/repositories.js';
import { RedisLoginRateLimiter } from '../../src/adapters/queue/redis-auth.js';
import { JwtSessionStore } from '../../src/adapters/auth/jwt-session.js';

const dbUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!dbUrl)('painel no Postgres', () => {
  let sql: Sql;
  let t1: number;
  let t2: number;

  beforeAll(async () => {
    sql = createSql(dbUrl!);
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs, admin_users restart identity cascade`;
    [t1, t2] = (await sql<{ id: string }[]>`
      insert into tenants (name, chatwoot_account_id) values ('A', 11), ('B', 12) returning id
    `).map((r) => Number(r.id)) as [number, number];
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('usuário: cria e acha pelo e-mail; e-mail repetido é recusado', async () => {
    const users = new PgAdminUserRepository(sql);
    await users.create({ tenantId: t1, email: 'dono@a.com', passwordHash: 'h', role: 'dono', mustChangePassword: false });
    expect(await users.findByEmail('dono@a.com')).toMatchObject({ tenantId: t1, role: 'dono' });
    expect(await users.create({ tenantId: t2, email: 'dono@a.com', passwordHash: 'h', role: 'dono', mustChangePassword: false })).toBeNull();
  });

  it('usuários: lista, troca senha e nunca remove o último dono (nem com remoções simultâneas)', async () => {
    const users = new PgAdminUserRepository(sql);
    const d2 = await users.create({ tenantId: t1, email: 'socio@a.com', passwordHash: 'h', role: 'dono', mustChangePassword: true });
    const rec = await users.create({ tenantId: t1, email: 'rec@a.com', passwordHash: 'h', role: 'recepcao', mustChangePassword: true });
    const d1 = await users.findByEmail('dono@a.com');

    expect((await users.listByTenant(t1)).map((u) => u.email)).toEqual(['dono@a.com', 'socio@a.com', 'rec@a.com']);
    expect(await users.setPassword(t1, rec!.id, 'novo', false)).toBe(true);
    expect(await users.setPassword(t2, rec!.id, 'novo', false)).toBe(false);
    expect((await users.findById(t1, rec!.id))?.mustChangePassword).toBe(false);

    const results = await Promise.all([users.remove(t1, d1!.id), users.remove(t1, d2!.id)]);
    expect(results.sort()).toEqual(['last_owner', 'ok']);
    expect((await users.listByTenant(t1)).filter((u) => u.role === 'dono')).toHaveLength(1);
    expect(await users.remove(t2, rec!.id)).toBe('not_found');
  });

  it('configurações: salva e lê de volta', async () => {
    const repo = new PgTenantSettingsRepository(sql);
    await repo.save(t1, { name: 'Cia', timeZone: 'America/Manaus', receptionHours: { open: 6, close: 22 }, privacyUrl: 'https://x.com/p' });
    expect(await repo.get(t1)).toEqual({ name: 'Cia', timeZone: 'America/Manaus', receptionHours: { open: 6, close: 22 }, privacyUrl: 'https://x.com/p' });
    await repo.save(t1, { name: 'Cia', timeZone: 'America/Sao_Paulo', receptionHours: null, privacyUrl: null });
    expect(await repo.get(t1)).toMatchObject({ receptionHours: null, privacyUrl: null });
  });

  it('base: troca tudo, incrementa a versão e a IA passa a ler a nova', async () => {
    const admin = new PgKnowledgeAdminRepository(sql);
    const r = await admin.replaceAll(t1, 1, [
      { category: 'Planos', content: 'Mensal R$ 130', active: true },
      { category: 'Rascunho', content: 'ainda não', active: false },
    ]);
    expect(r).toEqual({ ok: true, version: 2 });
    expect(await new PgKnowledgeRepository(sql).getActive(t1)).toEqual({
      version: 2,
      items: [{ category: 'Planos', content: 'Mensal R$ 130' }],
    });
    expect((await admin.getForEdit(t2)).items).toHaveLength(0);
  });

  it('base: versão antiga não altera nada', async () => {
    const admin = new PgKnowledgeAdminRepository(sql);
    expect(await admin.replaceAll(t1, 1, [{ category: 'X', content: 'Y', active: true }])).toEqual({ ok: false, currentVersion: 2 });
    expect((await admin.getForEdit(t1)).items.map((i) => i.content)).toEqual(['Mensal R$ 130', 'ainda não']);
  });

  it('base: dois salvamentos simultâneos da mesma versão, só um ganha', async () => {
    const admin = new PgKnowledgeAdminRepository(sql);
    const results = await Promise.all([
      admin.replaceAll(t1, 2, [{ category: 'P', content: 'primeiro', active: true }]),
      admin.replaceAll(t1, 2, [{ category: 'P', content: 'segundo', active: true }]),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await admin.getForEdit(t1)).items).toHaveLength(1);
  });

  it('base: cada salvamento vira uma versão no histórico, por academia', async () => {
    const admin = new PgKnowledgeAdminRepository(sql);
    const r = await admin.replaceAll(t1, 3, [{ category: 'Hist', content: 'v4', active: true }, { category: 'Off', content: 'x', active: false }], 'ana@a.com');
    expect(r).toEqual({ ok: true, version: 4 });
    const list = await admin.listVersions(t1, 10);
    expect(list[0]).toEqual({ version: 4, author: 'ana@a.com', createdAt: expect.any(Date), itemCount: 2, activeChars: 6 });
    expect(list.map((v) => v.version)).toEqual([4, 3, 2]);
    expect((await admin.getVersion(t1, 4))?.items).toEqual([
      { category: 'Hist', content: 'v4', active: true },
      { category: 'Off', content: 'x', active: false },
    ]);
    expect(await admin.getVersion(t2, 4)).toBeNull();
    expect(await admin.listVersions(t2, 10)).toEqual([]);
  });
});

describe.skipIf(!redisUrl)('painel no Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await redis?.quit();
  });

  const jwtSecret = new TextEncoder().encode('segredo-de-teste-com-mais-de-32-caracteres');

  it('sessão (JWT): cria, lê e destrói; token não fica em texto no Redis', async () => {
    const store = new JwtSessionStore(redis, jwtSecret, 60);
    const token = await store.create({ userId: 1, tenantId: 1, email: 'a@a.com', role: 'dono', mustChangePassword: false });
    expect(await store.get(token)).toEqual({ userId: 1, tenantId: 1, email: 'a@a.com', role: 'dono', mustChangePassword: false });
    expect(await redis.keys(`*${token}*`)).toHaveLength(0);
    await store.destroy(token);
    expect(await store.get(token)).toBeNull();
    expect(await store.get('inventado')).toBeNull();
  });

  it('sessões por pessoa (JWT): encerra todas menos a atual', async () => {
    const store = new JwtSessionStore(redis, jwtSecret, 60);
    const s = { userId: 442, tenantId: 1, email: 'a@a.com', role: 'dono' as const, mustChangePassword: false };
    const a = await store.create(s);
    await new Promise((r) => setTimeout(r, 1100)); // garante iat diferente entre tokens (resolução de 1s)
    const b = await store.create(s);
    const c = await store.create({ ...s, userId: 443 });
    await store.destroyAllForUser(442, b);
    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).not.toBeNull();
    expect(await store.get(c)).not.toBeNull(); // outra pessoa
    await store.destroyAllForUser(442);
    expect(await store.get(b)).toBeNull();
  });

  it('rate limit: 5 tentativas na janela, a 6ª bloqueia; reset libera', async () => {
    const limiter = new RedisLoginRateLimiter(redis, 5, 60);
    const key = `1.1.1.1:teste-${Date.now()}`;
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await limiter.hit(key));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false]);
    expect(results[5]!.retryAfterSec).toBeGreaterThan(0);
    await limiter.reset(key);
    expect((await limiter.hit(key)).allowed).toBe(true);
  });
});
