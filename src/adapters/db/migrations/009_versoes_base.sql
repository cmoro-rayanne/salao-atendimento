-- Histórico da base de conhecimento (spec 0011).
create table knowledge_versions (
  tenant_id   bigint not null references tenants(id) on delete cascade,
  version     integer not null,
  items       jsonb not null,
  author      text not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, version)
);

-- A base de hoje vira a primeira versão do histórico.
insert into knowledge_versions (tenant_id, version, items, author)
select t.id, t.knowledge_version,
       coalesce((select jsonb_agg(jsonb_build_object('category', k.category, 'content', k.content, 'active', k.active) order by k.id)
                 from knowledge_items k where k.tenant_id = t.id), '[]'::jsonb),
       'antes do histórico'
from tenants t;
