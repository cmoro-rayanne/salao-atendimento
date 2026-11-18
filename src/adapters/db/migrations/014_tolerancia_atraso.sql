-- Spec 0014: tolerância de atraso da cliente, configurável por salão (minutos; 0 = sem tolerância).
alter table tenants add column late_tolerance_min integer not null default 15 check (late_tolerance_min between 0 and 60);
