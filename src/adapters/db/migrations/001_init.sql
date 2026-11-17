-- Estrutura inicial. Ver docs/arquitetura.md (seção "Modelo de dados").

create table tenants (
  id                    bigserial primary key,
  name                  text not null,
  chatwoot_account_id   bigint not null unique,
  reception_hours       jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

create table leads (
  id                    bigserial primary key,
  tenant_id             bigint not null references tenants(id),
  chatwoot_contact_id   bigint,
  phone                 text not null,
  name                  text,
  goal                  text,
  modality              text,
  status                text not null default 'novo'
                        check (status in ('novo', 'qualificado', 'experimental_agendada', 'matriculado', 'perdido')),
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (tenant_id, phone)
);

create table trial_slots (
  id          bigserial primary key,
  tenant_id   bigint not null references tenants(id),
  modality    text not null,
  starts_at   timestamptz not null,
  seats_left  integer not null check (seats_left >= 0)
);

create table trial_bookings (
  id               bigserial primary key,
  slot_id          bigint not null references trial_slots(id),
  lead_id          bigint not null references leads(id),
  status           text not null default 'agendada' check (status in ('agendada', 'cancelada', 'compareceu', 'faltou')),
  reminder_job_id  text,
  created_at       timestamptz not null default now(),
  unique (slot_id, lead_id)
);

create table knowledge_items (
  id          bigserial primary key,
  tenant_id   bigint not null references tenants(id),
  category    text not null,
  content     text not null,
  active      boolean not null default true,
  version     integer not null default 1,
  updated_at  timestamptz not null default now()
);

create table processed_events (
  event_id     text primary key,
  received_at  timestamptz not null default now()
);

create table agent_runs (
  id                 bigserial primary key,
  conversation_id    bigint not null,
  model              text,
  input_tokens       integer,
  output_tokens      integer,
  cost_usd           numeric(10, 6),
  latency_ms         integer,
  steps              integer,
  tools_used         text[] not null default '{}',
  knowledge_version  integer,
  outcome            text not null,
  error              text,
  created_at         timestamptz not null default now()
);

create table handoffs (
  id               bigserial primary key,
  conversation_id  bigint not null,
  reason           text not null,
  created_at       timestamptz not null default now()
);

create index agent_runs_created_at_idx on agent_runs (created_at);
