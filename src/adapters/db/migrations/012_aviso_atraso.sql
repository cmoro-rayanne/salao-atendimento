-- Spec 0014: aviso de atraso para a cliente. Ver docs/specs/0014-aviso-de-atraso.md.
create table delay_notices (
  id                  bigserial primary key,
  tenant_id           bigint not null references tenants(id),
  appointment_id      bigint not null references appointments(id) on delete cascade,
  delay_min           integer not null check (delay_min between 5 and 120),
  original_starts_at  timestamptz not null,
  sent_at             timestamptz,
  response            text check (response in ('chegara_depois')),
  responded_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint delay_notices_once unique (appointment_id, delay_min)
);
create index delay_notices_appointment_idx on delay_notices (appointment_id, created_at desc);
