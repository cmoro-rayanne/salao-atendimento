-- Spec 0003: dados da conversa na reserva (para o lembrete) e controle do lembrete.

alter table trial_bookings
  add column chatwoot_account_id bigint,
  add column chatwoot_conversation_id bigint,
  add column reminder_sent_at timestamptz,
  add column cancelled_at timestamptz;

create index trial_bookings_lead_status_idx on trial_bookings (lead_id, status);
