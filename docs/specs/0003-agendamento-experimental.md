# Spec 0003 — Agendamento da aula experimental pela IA

## Objetivo
A IA mostra os horários livres da grade (spec 0004), agenda a aula experimental para quem está conversando, cancela quando pedido e manda um lembrete na véspera.

## Design
- **Ferramentas novas:**
  - `listar_horarios_experimental` (query): próximos 7 dias, só horários com vaga e que começam daqui a mais de 1 h; filtro opcional por modalidade.
  - `agendar_experimental` (command): reserva pelo id do horário. Transação única: trava o lead (`FOR UPDATE`), confere se já tem aula futura agendada, incrementa `booked` só se `booked < capacity` (update atômico) e grava a reserva. Repetir o mesmo pedido não duplica.
  - `cancelar_experimental` (command): cancela a aula futura do contato e devolve a vaga.
- **Regra:** cada contato tem no máximo uma aula experimental futura agendada. Para remarcar, a IA cancela e agenda de novo. (Suposição: se a academia limitar a uma experimental por pessoa para sempre, isso entra na base de conhecimento e a IA transfere quando for o caso.)
- **Lembrete:** job atrasado no BullMQ (fila `trial-reminder`) na véspera às 18 h no fuso da academia; se esse horário já passou, 3 h antes da aula; se faltar menos de 3 h, sem lembrete (a pessoa acabou de agendar). Enviado por **template aprovado pela Meta** (categoria utilidade), porque a janela de 24 h pode ter fechado. Cancelamento remove o job. O envio confere se a reserva ainda está ativa e grava `reminder_sent_at` (não envia duas vezes).
- **Template:** nome em `REMINDER_TEMPLATE_NAME` (padrão `lembrete_aula_experimental`), idioma `pt_BR`, variáveis `{{1}}` nome, `{{2}}` modalidade, `{{3}}` dia e hora. Precisa ser criado e aprovado no WhatsApp Manager antes do go-live.

Texto sugerido para o template (enviar para aprovação na Meta, categoria Utilidade):

> Olá, {{1}}! Lembrete da sua aula experimental de {{2}}: {{3}}. Se precisar remarcar, é só responder aqui.

## Critérios de aceite
- [x] A IA lista só horários com vaga, da própria academia, no fuso da academia.
- [x] Duas pessoas pedindo a última vaga ao mesmo tempo: só uma consegue.
- [x] O mesmo contato não fica com duas aulas futuras; pedir de novo o mesmo horário responde "já agendada".
- [x] Agendar marca o lead como `experimental_agendada` e agenda o lembrete; cancelar devolve a vaga e remove o lembrete.
- [x] Lembrete não é enviado para reserva cancelada nem duas vezes.
- [x] Testes unitários e de integração com Postgres e Redis.
- [ ] Validar o envio de template pelo Chatwoot com o número de teste da Meta.
