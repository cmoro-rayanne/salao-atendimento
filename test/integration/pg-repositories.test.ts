import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql, type Sql } from '../../src/adapters/db/client.js';
import { PgProcessedEventStore } from '../../src/adapters/db/processed-event-store.js';
import {
  PgAgentRunRepository,
  PgKnowledgeRepository,
  PgLeadRepository,
  PgTenantRepository,
} from '../../src/adapters/db/repositories.js';

/**
 * Testes contra um Postgres de verdade, com as migrations aplicadas.
 * Rodam só com TEST_DATABASE_URL definida, ex.:
 *   TEST_DATABASE_URL=postgres://... npm run migrate && npm test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('repositórios Postgres', () => {
  let sql: Sql;
  let tenantId: number;

  beforeAll(async () => {
    sql = createSql(url!);
    await sql`truncate tenants, leads, knowledge_items, processed_events, agent_runs, handoffs restart identity cascade`;
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (name, chatwoot_account_id, knowledge_version) values ('Studio Aurora', 1, 3) returning id
    `;
    tenantId = Number(t!.id);
    await sql`
      insert into knowledge_items (tenant_id, category, content, active) values
        (${tenantId}, 'Planos', 'Mensal R$ 120', true),
        (${tenantId}, 'Antigo', 'não usar', false)
    `;
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('acha a academia pela conta do Chatwoot', async () => {
    const tenant = await new PgTenantRepository(sql).findByChatwootAccount(1);
    expect(tenant).toEqual({ id: tenantId, name: 'Studio Aurora', timeZone: 'America/Sao_Paulo', privacyUrl: null });
    expect(await new PgTenantRepository(sql).findByChatwootAccount(999)).toBeNull();
  });

  it('carrega só os itens ativos da base, com a versão do salão', async () => {
    const kb = await new PgKnowledgeRepository(sql).getActive(tenantId);
    expect(kb).toEqual({ version: 3, items: [{ category: 'Planos', content: 'Mensal R$ 120' }] });
  });

  it('upsert de cliente: cria, completa o nome sem apagar e incrementa a versão', async () => {
    const leads = new PgLeadRepository(sql);
    const base = { tenantId, phone: '+5541999990000', chatwootContactId: 5 };

    const first = await leads.upsertByPhone({ ...base, name: 'Ana' });
    const second = await leads.upsertByPhone(base);

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const [row] = await sql`select name, version from leads where id = ${first.id}`;
    expect(row).toEqual({ name: 'Ana', version: 2 });
  });

  it('upserts concorrentes do mesmo telefone geram um único lead', async () => {
    const leads = new PgLeadRepository(sql);
    const input = { tenantId, phone: '+5541988887777', chatwootContactId: 6, name: 'Bia' };
    await Promise.all(Array.from({ length: 10 }, () => leads.upsertByPhone(input)));
    const [row] = await sql`select count(*)::int as n from leads where phone = ${input.phone}`;
    expect(row).toEqual({ n: 1 });
  });

  it('opt-out: liga, desliga e cria o lead quando não existe', async () => {
    const leads = new PgLeadRepository(sql);
    await leads.setOptOut({ tenantId, phone: '+5541900001111', chatwootContactId: 9, optedOut: true });
    const [on] = await sql`select opted_out_at is not null as out from leads where phone = '+5541900001111'`;
    expect(on).toEqual({ out: true });
    await leads.setOptOut({ tenantId, phone: '+5541900001111', chatwootContactId: 9, optedOut: false });
    const [off] = await sql`select opted_out_at is not null as out from leads where phone = '+5541900001111'`;
    expect(off).toEqual({ out: false });
  });

  it('marca evento uma única vez', async () => {
    const store = new PgProcessedEventStore(sql);
    expect(await store.markIfNew('chatwoot:message:1')).toBe(true);
    expect(await store.markIfNew('chatwoot:message:1')).toBe(false);
  });

  it('grava a execução do agente', async () => {
    await new PgAgentRunRepository(sql).record({
      tenantId,
      costUsd: 0.0012,
      conversationId: 77,
      model: 'm',
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 300,
      steps: 2,
      toolsUsed: ['registrar_lead'],
      knowledgeVersion: 3,
      outcome: 'reply',
    });
    const [row] = await sql`select tools_used, outcome from agent_runs where conversation_id = 77`;
    expect(row).toEqual({ tools_used: ['registrar_lead'], outcome: 'reply' });
  });
});
