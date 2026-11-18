-- Spec 0014 (parte 2): a cliente avisa o salão do próprio atraso pelo WhatsApp.
create table client_delay_reports (
  id              bigserial primary key,
  tenant_id       bigint not null references tenants(id),
  appointment_id  bigint not null references appointments(id) on delete cascade,
  delay_min       integer not null check (delay_min between 5 and 60),
  created_at      timestamptz not null default now(),
  constraint client_delay_reports_once unique (appointment_id, delay_min)
);
create index client_delay_reports_appointment_idx on client_delay_reports (appointment_id, id desc);
