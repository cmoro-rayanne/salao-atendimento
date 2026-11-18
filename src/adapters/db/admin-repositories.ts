import { z } from 'zod';
import type { AdminUser, AdminUserRepository, AdminUserSummary } from '../../modules/auth/ports.js';
import type { TenantSettings, TenantSettingsRepository } from '../../modules/settings/ports.js';
import type {
  EditableKnowledgeBase,
  EditableKnowledgeItem,
  KnowledgeAdminRepository,
  KnowledgeVersion,
  KnowledgeVersionSummary,
  ReplaceKnowledgeResult,
} from '../../modules/knowledge/ports.js';
import type { Sql } from './client.js';

interface AdminUserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  role: 'dono' | 'recepcao';
  must_change_password: boolean;
}

const toAdminUser = (r: AdminUserRow): AdminUser => ({
  id: Number(r.id),
  tenantId: Number(r.tenant_id),
  email: r.email,
  passwordHash: r.password_hash,
  role: r.role,
  mustChangePassword: r.must_change_password,
});

export class PgAdminUserRepository implements AdminUserRepository {
  constructor(private readonly sql: Sql) {}

  async findByEmail(email: string): Promise<AdminUser | null> {
    const [row] = await this.sql<AdminUserRow[]>`
      select id, tenant_id, email, password_hash, role, must_change_password from admin_users where email = ${email}
    `;
    return row ? toAdminUser(row) : null;
  }

  async findById(tenantId: number, id: number): Promise<AdminUser | null> {
    const [row] = await this.sql<AdminUserRow[]>`
      select id, tenant_id, email, password_hash, role, must_change_password from admin_users
      where id = ${id} and tenant_id = ${tenantId}
    `;
    return row ? toAdminUser(row) : null;
  }

  async listByTenant(tenantId: number): Promise<AdminUserSummary[]> {
    const rows = await this.sql<{ id: string; email: string; role: AdminUser['role']; must_change_password: boolean; created_at: Date }[]>`
      select id, email, role, must_change_password, created_at from admin_users
      where tenant_id = ${tenantId} order by role, email
    `;
    return rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      role: r.role,
      mustChangePassword: r.must_change_password,
      createdAt: r.created_at,
    }));
  }

  async create(input: Omit<AdminUser, 'id'>): Promise<AdminUser | null> {
    const [row] = await this.sql<AdminUserRow[]>`
      insert into admin_users (tenant_id, email, password_hash, role, must_change_password)
      values (${input.tenantId}, ${input.email}, ${input.passwordHash}, ${input.role}, ${input.mustChangePassword})
      on conflict (email) do nothing
      returning id, tenant_id, email, password_hash, role, must_change_password
    `;
    return row ? toAdminUser(row) : null;
  }

  async setPassword(tenantId: number, id: number, passwordHash: string, mustChange: boolean): Promise<boolean> {
    const rows = await this.sql`
      update admin_users set password_hash = ${passwordHash}, must_change_password = ${mustChange}, updated_at = now()
      where id = ${id} and tenant_id = ${tenantId}
      returning id
    `;
    return rows.length === 1;
  }

  async remove(tenantId: number, id: number): Promise<'ok' | 'not_found' | 'last_owner'> {
    return this.sql.begin(async (tx) => {
      // Trava os donos da academia: duas remoções simultâneas não deixam a academia sem dono.
      const owners = await tx<{ id: string }[]>`
        select id from admin_users where tenant_id = ${tenantId} and role = 'dono' for update
      `;
      const [target] = await tx<{ role: string }[]>`
        select role from admin_users where id = ${id} and tenant_id = ${tenantId} for update
      `;
      if (!target) return 'not_found' as const;
      if (target.role === 'dono' && owners.length <= 1) return 'last_owner' as const;
      await tx`delete from admin_users where id = ${id} and tenant_id = ${tenantId}`;
      return 'ok' as const;
    });
  }
}

export class PgKnowledgeAdminRepository implements KnowledgeAdminRepository {
  constructor(private readonly sql: Sql) {}

  async getForEdit(tenantId: number): Promise<EditableKnowledgeBase> {
    const [tenant] = await this.sql<{ knowledge_version: number }[]>`
      select knowledge_version from tenants where id = ${tenantId}
    `;
    const items = await this.sql<{ id: string; category: string; content: string; active: boolean }[]>`
      select id, category, content, active from knowledge_items where tenant_id = ${tenantId} order by id
    `;
    return {
      version: tenant?.knowledge_version ?? 0,
      items: items.map((i) => ({ id: Number(i.id), category: i.category, content: i.content, active: i.active })),
    };
  }

  async replaceAll(
    tenantId: number,
    expectedVersion: number,
    items: Array<Omit<EditableKnowledgeItem, 'id'>>,
    author = 'desconhecido',
  ): Promise<ReplaceKnowledgeResult> {
    return this.sql.begin(async (tx) => {
      // O update condicional trava a linha do tenant: dois salvamentos ao mesmo tempo viram um 409.
      const [bumped] = await tx<{ knowledge_version: number }[]>`
        update tenants set knowledge_version = knowledge_version + 1
        where id = ${tenantId} and knowledge_version = ${expectedVersion}
        returning knowledge_version
      `;
      if (!bumped) {
        const [current] = await tx<{ knowledge_version: number }[]>`
          select knowledge_version from tenants where id = ${tenantId}
        `;
        return { ok: false as const, currentVersion: current?.knowledge_version ?? 0 };
      }

      await tx`delete from knowledge_items where tenant_id = ${tenantId}`;
      if (items.length) {
        const rows = items.map((i) => ({
          tenant_id: tenantId,
          category: i.category,
          content: i.content,
          active: i.active,
          version: bumped.knowledge_version,
        }));
        await tx`insert into knowledge_items ${tx(rows, 'tenant_id', 'category', 'content', 'active', 'version')}`;
      }
      const snapshot = items.map((i) => ({ category: i.category, content: i.content, active: i.active }));
      await tx`
        insert into knowledge_versions (tenant_id, version, items, author)
        values (${tenantId}, ${bumped.knowledge_version}, ${tx.json(snapshot)}, ${author})
      `;
      return { ok: true as const, version: bumped.knowledge_version };
    });
  }

  async listVersions(tenantId: number, limit: number): Promise<KnowledgeVersionSummary[]> {
    const rows = await this.sql<VersionRow[]>`
      select version, author, created_at, items from knowledge_versions
      where tenant_id = ${tenantId} order by version desc limit ${limit}
    `;
    return rows.map((r) => summarize(r).summary);
  }

  async getVersion(tenantId: number, version: number): Promise<KnowledgeVersion | null> {
    const [row] = await this.sql<VersionRow[]>`
      select version, author, created_at, items from knowledge_versions
      where tenant_id = ${tenantId} and version = ${version}
    `;
    if (!row) return null;
    const { summary, items } = summarize(row);
    return { ...summary, items };
  }
}

interface VersionRow {
  version: number;
  author: string;
  created_at: Date;
  items: unknown;
}

const SnapshotItems = z.array(z.object({ category: z.string(), content: z.string(), active: z.boolean() }));

function summarize(r: VersionRow) {
  const items = SnapshotItems.parse(r.items);
  const activeChars = items.filter((i) => i.active).reduce((n, i) => n + i.category.length + i.content.length, 0);
  return {
    items,
    summary: { version: r.version, author: r.author, createdAt: r.created_at, itemCount: items.length, activeChars },
  };
}

export class PgTenantSettingsRepository implements TenantSettingsRepository {
  constructor(private readonly sql: Sql) {}

  async get(tenantId: number): Promise<TenantSettings> {
    const [row] = await this.sql<{ name: string; time_zone: string; reception_hours: unknown; privacy_url: string | null; late_tolerance_min: number }[]>`
      select name, time_zone, reception_hours, privacy_url, late_tolerance_min from tenants where id = ${tenantId}
    `;
    if (!row) throw new Error(`tenant ${tenantId} não existe`);
    const rh = row.reception_hours as { open?: unknown; close?: unknown } | null;
    const receptionHours =
      rh && typeof rh.open === 'number' && typeof rh.close === 'number' ? { open: rh.open, close: rh.close } : null;
    return { name: row.name, timeZone: row.time_zone, receptionHours, privacyUrl: row.privacy_url, lateToleranceMin: row.late_tolerance_min };
  }

  async save(tenantId: number, s: TenantSettings): Promise<void> {
    await this.sql`
      update tenants set
        name = ${s.name},
        time_zone = ${s.timeZone},
        reception_hours = ${this.sql.json(s.receptionHours ?? {})},
        privacy_url = ${s.privacyUrl},
        late_tolerance_min = ${s.lateToleranceMin}
      where id = ${tenantId}
    `;
  }
}
