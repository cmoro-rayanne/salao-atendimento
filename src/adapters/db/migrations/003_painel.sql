-- Spec 0004: usuários do painel e grade com capacidade + reservas.

create table admin_users (
  id             bigserial primary key,
  tenant_id      bigint not null references tenants(id),
  email          text not null check (email = lower(email)),
  password_hash  text not null,
  role           text not null check (role in ('dono', 'recepcao')),
  created_at     timestamptz not null default now(),
  unique (email)
);

-- Antes: só "vagas restantes". Agora: capacidade + reservas, para a grade
-- mostrar as duas coisas e a reserva (spec 0003) incrementar de forma atômica.
alter table trial_slots rename column seats_left to capacity;
alter table trial_slots
  add column booked integer not null default 0,
  add constraint trial_slots_booked_range check (booked >= 0 and booked <= capacity);

create index trial_slots_tenant_starts_idx on trial_slots (tenant_id, starts_at);
