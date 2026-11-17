-- Spec 0006: opt-out de mensagens ativas e link da política de privacidade.

alter table leads add column opted_out_at timestamptz;
alter table tenants add column privacy_url text;
