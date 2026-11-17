-- Spec 0013: agenda de salão de beleza. Ver docs/specs/0013-agenda-salao.md.
create extension if not exists btree_gist;

alter table tenants
  add column slot_step_min   integer not null default 30 check (slot_step_min in (15, 30)),
  add column min_notice_min  integer not null default 60 check (min_notice_min >= 0),
  add column max_days_ahead  integer not null default 30 check (max_days_ahead between 1 and 180);

create table salon_services (
  id            bigserial primary key,
  tenant_id     bigint not null references tenants(id),
  name          text not null,
  description   text,
  duration_min  integer not null check (duration_min between 5 and 600),
  price_cents   integer check (price_cents >= 0),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index salon_services_tenant_idx on salon_services (tenant_id) where active;

create table professionals (
  id          bigserial primary key,
  tenant_id   bigint not null references tenants(id),
  name        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index professionals_tenant_idx on professionals (tenant_id) where active;

create table professional_services (
  professional_id  bigint not null references professionals(id) on delete cascade,
  service_id       bigint not null references salon_services(id) on delete cascade,
  primary key (professional_id, service_id)
);

-- Expediente semanal; várias faixas no mesmo dia (almoço = duas faixas). weekday: 0 = domingo.
create table working_hours (
  id               bigserial primary key,
  professional_id  bigint not null references professionals(id) on delete cascade,
  weekday          integer not null check (weekday between 0 and 6),
  start_min        integer not null check (start_min between 0 and 1439),
  end_min          integer not null check (end_min between 1 and 1440),
  check (end_min > start_min)
);
create index working_hours_prof_idx on working_hours (professional_id, weekday);

create table time_off (
  id               bigserial primary key,
  professional_id  bigint not null references professionals(id) on delete cascade,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  reason           text,
  check (ends_at > starts_at)
);
create index time_off_prof_idx on time_off (professional_id, starts_at);

create table appointments (
  id                        bigserial primary key,
  tenant_id                 bigint not null references tenants(id),
  lead_id                   bigint not null references leads(id),
  professional_id           bigint not null references professionals(id),
  service_id                bigint not null references salon_services(id),
  starts_at                 timestamptz not null,
  ends_at                   timestamptz not null,
  status                    text not null default 'agendado'
                            check (status in ('agendado', 'cancelado', 'concluido', 'faltou')),
  source                    text not null default 'ia' check (source in ('ia', 'painel')),
  version                   integer not null default 1,
  chatwoot_account_id       bigint,
  chatwoot_conversation_id  bigint,
  reminder_job_id           text,
  reminder_sent_at          timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz not null default now(),
  check (ends_at > starts_at),
  -- Última defesa: a mesma profissional não pode ter dois agendamentos ativos que se sobreponham.
  constraint appointments_no_overlap exclude using gist (
    professional_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status = 'agendado')
);
create index appointments_lead_idx on appointments (lead_id, starts_at) where status = 'agendado';
create index appointments_prof_idx on appointments (professional_id, starts_at) where status = 'agendado';
create index appointments_tenant_day_idx on appointments (tenant_id, starts_at);
