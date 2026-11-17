-- Spec 0013, entrega 6: o salão não tem aula experimental nem funil de matrícula.
-- Destrutiva de propósito: remove dados do modelo da academia. Faça backup antes de rodar em banco com dados reais.
drop table if exists trial_bookings;
drop table if exists trial_slots;

alter table leads
  drop column if exists goal,
  drop column if exists modality,
  drop column if exists status,
  drop column if exists enrolled_at;
