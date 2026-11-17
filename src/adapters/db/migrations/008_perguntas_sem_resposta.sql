-- Pergunta que a IA não soube responder (spec 0010).
alter table handoffs
  add column question text,
  add column question_resolved_at timestamptz;

create index handoffs_question_idx on handoffs (tenant_id, created_at) where question is not null;
