import type { AgentRunRecord, AgentRunRepository, Tenant, TenantRepository } from '../../modules/conversation/ports.js';
import type { HandoffRepository } from '../../modules/handoff/ports.js';
import type { KnowledgeBase, KnowledgeRepository } from '../../modules/knowledge/ports.js';
import type { LeadRepository, UpsertLeadInput } from '../../modules/leads/ports.js';
import type { Sql } from './client.js';

export class PgTenantRepository implements TenantRepository {
  constructor(private readonly sql: Sql) {}

  async infoOf(tenantId: number): Promise<{ timeZone: string; chatwootAccountId: number }> {
    const [row] = await this.sql<{ time_zone: string; chatwoot_account_id: string }[]>`
      select time_zone, chatwoot_account_id from tenants where id = ${tenantId}
    `;
    if (!row) throw new Error(`tenant ${tenantId} não existe`);
    return { timeZone: row.time_zone, chatwootAccountId: Number(row.chatwoot_account_id) };
  }

  async findByChatwootAccount(accountId: number): Promise<Tenant | null> {
    const rows = await this.sql<{ id: string; name: string; time_zone: string; privacy_url: string | null }[]>`
      select id, name, time_zone, privacy_url from tenants where chatwoot_account_id = ${accountId}
    `;
    const row = rows[0];
    return row ? { id: Number(row.id), name: row.name, timeZone: row.time_zone, privacyUrl: row.privacy_url } : null;
  }
}

export class PgKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly sql: Sql) {}

  async getActive(tenantId: number): Promise<KnowledgeBase> {
    const [tenant] = await this.sql<{ knowledge_version: number }[]>`
      select knowledge_version from tenants where id = ${tenantId}
    `;
    const items = await this.sql<{ category: string; content: string }[]>`
      select category, content from knowledge_items
      where tenant_id = ${tenantId} and active
      order by category, id
    `;
    return { version: tenant?.knowledge_version ?? 0, items: items.map((i) => ({ ...i })) };
  }
}

export class PgLeadRepository implements LeadRepository {
  constructor(private readonly sql: Sql) {}

  /** Upsert atômico: `coalesce` mantém o valor salvo quando o novo vem vazio. */
  async upsertByPhone(input: UpsertLeadInput): Promise<{ id: number; created: boolean }> {
    const [row] = await this.sql<{ id: string; created: boolean }[]>`
      insert into leads (tenant_id, phone, chatwoot_contact_id, name, goal, modality, status)
      values (
        ${input.tenantId}, ${input.phone}, ${input.chatwootContactId},
        ${input.name ?? null}, ${input.goal ?? null}, ${input.modality ?? null},
        ${input.goal || input.modality ? 'qualificado' : 'novo'}
      )
      on conflict (tenant_id, phone) do update set
        chatwoot_contact_id = excluded.chatwoot_contact_id,
        name       = coalesce(excluded.name, leads.name),
        goal       = coalesce(excluded.goal, leads.goal),
        modality   = coalesce(excluded.modality, leads.modality),
        status     = case when leads.status = 'novo' and (excluded.goal is not null or excluded.modality is not null)
                          then 'qualificado' else leads.status end,
        version    = leads.version + 1,
        updated_at = now()
      returning id, (xmax = 0) as created
    `;
    if (!row) throw new Error('upsert de lead não retornou linha');
    return { id: Number(row.id), created: row.created };
  }

  setOptOut(input: { tenantId: number; phone: string; chatwootContactId: number; optedOut: boolean }): Promise<void> {
    return PgLeadOptOut.set(this.sql, input);
  }
}

export class PgLeadOptOut {
  static async set(
    sql: Sql,
    input: { tenantId: number; phone: string; chatwootContactId: number; optedOut: boolean },
  ): Promise<void> {
    await sql`
      insert into leads (tenant_id, phone, chatwoot_contact_id, opted_out_at)
      values (${input.tenantId}, ${input.phone}, ${input.chatwootContactId}, ${input.optedOut ? new Date() : null})
      on conflict (tenant_id, phone) do update set
        opted_out_at = case when ${input.optedOut} then coalesce(leads.opted_out_at, now()) else null end,
        version = leads.version + 1,
        updated_at = now()
    `;
  }
}

export class PgHandoffRepository implements HandoffRepository {
  constructor(private readonly sql: Sql) {}

  async record(conversationId: number, reason: string, tenantId: number | null, question?: string | null): Promise<void> {
    await this.sql`
      insert into handoffs (conversation_id, reason, tenant_id, question)
      values (${conversationId}, ${reason}, ${tenantId}, ${question ?? null})
    `;
  }
}

export class PgAgentRunRepository implements AgentRunRepository {
  constructor(private readonly sql: Sql) {}

  async record(run: AgentRunRecord): Promise<void> {
    await this.sql`
      insert into agent_runs
        (tenant_id, conversation_id, model, input_tokens, output_tokens, cost_usd, latency_ms, steps, tools_used,
         knowledge_version, outcome, error)
      values
        (${run.tenantId}, ${run.conversationId}, ${run.model}, ${run.inputTokens}, ${run.outputTokens}, ${run.costUsd},
         ${run.latencyMs}, ${run.steps}, ${run.toolsUsed}, ${run.knowledgeVersion}, ${run.outcome}, ${run.error ?? null})
    `;
  }
}
