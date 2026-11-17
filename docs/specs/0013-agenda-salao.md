# Spec 0013 — Agenda de salão de beleza pelo WhatsApp

## Objetivo
Adaptar o modelo da academia (`whatsapp-ai-agent`, commit `b1d0d02`) para **salões de beleza**: a IA agenda, remarca e cancela
serviços pelo WhatsApp, o salão vê e ajusta a agenda no painel, e a cliente recebe lembrete antes do horário.
Primeira entrega é um **modelo para oferecer** a salões (sem cliente real ainda): tudo configurável pelo painel.

## Decisões
- **Repositório novo** (`salao-atendimento`), copiado da academia. Multiempresa continua (`tenants`): um salão = um tenant.
- **Sem grade fixa de horários.** Na academia o dono cria horários com vagas. No salão o horário livre é **calculado**:
  expediente da profissional − folgas/bloqueios − agendamentos existentes, em passos de 15 ou 30 min
  (`slot_step_min`), cabendo a duração do serviço.
- **Um serviço por agendamento** na primeira versão. Combos (corte + escova) ficam como serviço próprio, com duração somada.
- **Cliente pode ter vários agendamentos futuros** (diferente da aula experimental). Remarcar e cancelar usam o id do agendamento;
  a IA lista os agendamentos futuros da pessoa antes.
- **"Qualquer profissional"**: o sistema escolhe a que tiver o horário livre e menos agendamentos no dia.
- **Choque de horário é impossível no banco**: `EXCLUDE USING gist` por profissional entre agendamentos ativos (última defesa);
  a regra também é checada na transação antes de gravar.
- **A IA não informa preço nem prazo de execução fora do cadastro** (preço vem de `price_cents` do serviço; vazio = "a combinar" e transfere).
- **Lembrete**: mesma regra da academia (véspera 18 h no fuso do salão; senão 3 h antes; senão não envia), por template aprovado pela Meta.
- **Fora desta entrega**: sinal/pagamento, fila de espera, aniversariantes e campanhas, mais de um serviço por visita,
  integração com Google Agenda, comissões.

## Design
### Dados (migration `010_agenda_salao.sql`)
- `salon_services(id, tenant_id, name, description, duration_min, price_cents null, active)`
- `professionals(id, tenant_id, name, active)` e `professional_services(professional_id, service_id)`
- `working_hours(professional_id, weekday 0–6, start_min, end_min)` — várias faixas no mesmo dia (almoço = duas faixas)
- `time_off(id, professional_id, starts_at, ends_at, reason)` — folga, férias, bloqueio
- `appointments(id, tenant_id, lead_id, professional_id, service_id, starts_at, ends_at, status, source, version, chatwoot_account_id,
  chatwoot_conversation_id, reminder_job_id, reminder_sent_at, cancelled_at, created_at)`
  - `status`: `agendado | cancelado | concluido | faltou`; `source`: `ia | painel`
  - `EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status = 'agendado')`
- `tenants` ganha `slot_step_min` (15|30, padrão 30), `min_notice_min` (padrão 60), `max_days_ahead` (padrão 30).
- Remove (em PR próprio): `trial_slots`, `trial_bookings` e telas Aulas/Grade.

### Módulo `src/modules/appointments` (sem Fastify/BullMQ/Postgres/SDK)
- `availability.ts` — função pura `computeFreeSlots`: expediente, folgas, agendamentos, passo, antecedência, janela.
- `book.ts` (command), `reschedule.ts` (command), `cancel.ts` (command), `list-slots.ts` e `list-mine.ts` (queries).
- `ports.ts` — `AppointmentRepository` (book atômico, reschedule atômico, cancel, listas), `CatalogRepository`, `ReminderScheduler`.
- Adapters: `PgAppointmentRepository`, `PgCatalogRepository`; fila de lembrete reaproveita `reminder-queue.ts`.

### Ferramentas da IA
`listar_servicos` (query, do cadastro), `consultar_horarios(servico_id, profissional_id?, data?)` (query), `meus_agendamentos` (query),
`agendar_servico(servico_id, profissional_id|0, inicio)` (command), `remarcar_agendamento(agendamento_id, novo_inicio)` (command),
`cancelar_agendamento(agendamento_id)` (command), mais `registrar_lead` e `transferir_para_humano` já existentes.
Todas idempotentes: repetir o mesmo pedido devolve o agendamento existente.

### Painel
Agenda (dia e semana, uma coluna por profissional; agendar manual, remarcar, cancelar, marcar concluído/faltou, bloquear horário),
Serviços, Profissionais (serviços que faz + expediente semanal + folgas), Leads, O que a IA sabe, Relatório (agendamentos, faltas,
serviços mais pedidos), Configurações. Saem Aulas agendadas e Grade da experimental.

### Prompt e base
Prompt reescrito para salão (tom acolhedor, confirma serviço, profissional e horário antes de agendar, não promete resultado
estético, transfere para humano em reclamação ou alergia/reação). Base de exemplo: salão fictício "Studio Aurora".

## Entregas em ordem (PRs pequenos)
1. ~~Esta spec + `availability.ts` com testes.~~ Feito.
2. ~~Migration, repositórios Postgres e testes de integração (inclui concorrência na mesma vaga).~~ Feito (`PgAppointmentRepository`, `PgCatalogRepository`).
3. Comandos/queries + ferramentas da IA + prompt + eval do salão.
4. Lembrete (fila) e relatório.
5. Painel: serviços, profissionais, agenda.
6. Limpeza do código da academia (trial) e base de exemplo.

## Critérios de aceite
- [x] Horários livres respeitam expediente, folga, bloqueio, antecedência mínima, passo e duração do serviço.
- [x] Duas clientes pedindo o mesmo horário da mesma profissional: só uma agenda; a outra recebe "horário ocupado".
- [x] Banco recusa sobreposição mesmo se a regra da aplicação falhar.
- [ ] "Qualquer profissional" escolhe quem tem o horário livre e respeita quem faz o serviço.
- [x] Remarcar é atômico: se o novo horário estiver ocupado, o antigo continua valendo.
- [ ] Cancelar libera o horário e remove o lembrete; lembrete não sai para cancelado nem duas vezes.
- [ ] A IA não agenda sem serviço, horário e confirmação da cliente; não informa preço fora do cadastro.
- [x] Salão não vê nem altera dados de outro salão.
