-- Spec 0005: dados para leads, presença e relatório mensal.

alter table agent_runs add column tenant_id bigint references tenants(id);
alter table handoffs add column tenant_id bigint references tenants(id);
alter table leads add column enrolled_at timestamptz;

create index agent_runs_tenant_created_idx on agent_runs (tenant_id, created_at);
create index handoffs_tenant_created_idx on handoffs (tenant_id, created_at);
create index leads_tenant_created_idx on leads (tenant_id, created_at desc);
