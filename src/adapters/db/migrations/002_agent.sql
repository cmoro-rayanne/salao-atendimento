-- Spec 0002: fuso por academia e versão da base de conhecimento.

alter table tenants
  add column time_zone text not null default 'America/Sao_Paulo',
  add column knowledge_version integer not null default 1;

create index knowledge_items_tenant_active_idx on knowledge_items (tenant_id) where active;
