-- Spec 0008: senha provisória e auditoria simples de alterações de acesso.

alter table admin_users
  add column must_change_password boolean not null default false,
  add column updated_at timestamptz not null default now();
