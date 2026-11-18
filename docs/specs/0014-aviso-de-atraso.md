# Spec 0014 — Aviso de atraso (salão → cliente e cliente → salão)

## Objetivo
Quando o salão está atrasado, a recepção avisa a cliente pelo WhatsApp em um clique. A cliente escolhe: chegar mais tarde no novo
horário previsto, ou remarcar (inclusive para um horário mais cedo). A IA cuida da resposta e a agenda reflete o que ela escolheu.

## Dois sentidos
O aviso vale nos dois sentidos (confirmado pela Ray):
1. **Salão → cliente:** o salão está atrasado e avisa (descrito abaixo).
2. **Cliente → salão:** a cliente diz no WhatsApp que vai se atrasar. A IA usa `avisar_atraso_cliente(agendamento_id, minutos)`,
   que grava em `client_delay_reports` (migration 013, `UNIQUE (appointment_id, delay_min)`), deixa uma nota privada para a equipe
   no Chatwoot e mostra o aviso na agenda do painel.
   - **Tolerância configurável pela dona em Configurações** (`tenants.late_tolerance_min`, migration 014; padrão 15, de 0 a 60 min): até esse tempo o horário é mantido e a IA confirma isso à cliente.
     Acima da tolerância a IA não promete nada, diz que a equipe vai avaliar e oferece remarcar. Acima de 60 min não registra e propõe remarcar.
   - Só vale para agendamentos da própria pessoa que começam de 30 min atrás a 6 h à frente. Não altera o agendamento.

## Decisões
- **Disparo manual, por agendamento.** Botão "Avisar atraso" na agenda do painel, com os minutos de atraso (5 a 120). Dono e recepção podem.
  Aviso em lote por profissional fica para a entrega 2.
- **Só para agendamentos que começam de 30 minutos atrás até 6 horas à frente**, ativos (`agendado`). Fora disso o painel recusa:
  um atraso de hoje não faz sentido para um agendamento da semana que vem.
- **Só vai para quem tem conversa do WhatsApp e não pediu SAIR.** Agendamento feito só no painel não tem conversa: o painel informa
  "essa cliente não tem WhatsApp neste sistema, ligue para ela".
- **Mensagem por template aprovado pela Meta** (`aviso_atraso`), porque a janela de 24 h costuma estar fechada.
  Parâmetros: `{{1}}` nome, `{{2}}` serviço, `{{3}}` minutos de atraso, `{{4}}` novo horário previsto (hora local).
  Texto padrão: "Oi, {{1}}! Estamos com cerca de {{3}} minutos de atraso e seu horário de {{2}} passa a ser por volta das {{4}}.
  Você consegue chegar nesse horário? Se preferir, responda por aqui para remarcar, inclusive para um horário mais cedo."
- **O agendamento não muda sozinho.** O horário continua na agenda; o novo horário é uma previsão. Mudar o início poderia bater
  com o próximo agendamento da profissional. Quem muda é a cliente, pela remarcação (que já checa conflito).
- **Idempotência.** `UNIQUE (appointment_id, delay_min)`: clicar duas vezes com os mesmos minutos não manda duas mensagens.
  Aumentar o atraso (de 15 para 30) é outro aviso, permitido.
- **Envio no worker**, por fila (`appointment-delay-notice`), com tentativas, DLQ e alerta, igual ao lembrete.
  Falhou o enfileiramento: o registro é apagado e o painel mostra erro.
- **Resposta da cliente tratada pela IA**, com duas mudanças:
  - `meus_agendamentos` informa o aviso pendente (minutos e horário previsto) ao lado do agendamento.
  - Nova ferramenta `confirmar_chegada_atrasada(agendamento_id)`: a cliente topou chegar no horário previsto.
  - "Mais cedo" ou "outro dia" usa `consultar_horarios` + `remarcar_agendamento`, sem ferramenta nova.
- **Situação do aviso no painel**, derivada (sem coluna a mais): `aguardando envio` (sem `sent_at`), `enviado`,
  `confirmou chegar às HH:MM` (`response = chegara_depois`), `remarcou` (início diferente do original) ou `cancelou`.

## Design
### Dados (migration `012_aviso_atraso.sql`)
`delay_notices(id, tenant_id, appointment_id, delay_min, original_starts_at, sent_at null, response null check in ('chegara_depois'),
responded_at null, created_at)`, `UNIQUE (appointment_id, delay_min)`.

### Módulo `src/modules/appointments`
- `delay-notice.ts`: `requestDelayNotice` (command do painel) e `sendDelayNotice` (use case do job, idempotente: marca `sent_at` só se vazio).
- `ports.ts`: `DelayNoticeRepository` (`create`, `remove`, `getForSend`, `markSent`, `listPending`, `markConfirmed`),
  `DelayNoticeSender`, `DelayNoticeScheduler`.
- Adapters: `PgDelayNoticeRepository`, `BullDelayNoticeScheduler`, `ChatwootGateway.sendDelayNotice`.

### API do painel
`POST /admin/api/appointments/:id/delay-notice` com `{ delayMin }`. `GET /admin/api/appointments` passa a trazer `delayNotice`
(`delayMin`, `status`, `expectedAt`) do aviso mais recente.

### Painel
Na agenda, cada agendamento ativo e próximo ganha "Avisar atraso": escolhe 10, 15, 20, 30, 45 ou 60 minutos (ou outro valor) e confirma;
depois mostra a situação do aviso.

## Entregas
1. **Aviso por agendamento** (esta spec): migration, domínio, fila, template, ferramenta da IA, rota e botão no painel, com testes.
2. Aviso em lote: "a Ana está 20 min atrasada" avisa todas as clientes dela dos próximos agendamentos do dia.
3. Relatório: quantos avisos, quantas clientes confirmaram, remarcaram ou cancelaram.

## Critérios de aceite
- [ ] O painel recusa aviso para agendamento cancelado, concluído, fora da janela, de outro salão ou sem conversa do WhatsApp.
- [ ] Cliente que pediu SAIR não recebe o aviso.
- [ ] Dois cliques com os mesmos minutos geram uma única mensagem.
- [ ] A IA, ao ver a resposta "pode sim", chama `confirmar_chegada_atrasada` e confirma o horário previsto sem mexer na agenda.
- [ ] Ao pedir um horário mais cedo, a IA consulta horários livres e remarca; o aviso aparece como "remarcou".
- [ ] `consultar_horarios` e `remarcar_agendamento` continuam sendo o único caminho de mudança de horário.
- [ ] Cliente que avisa até 15 min recebe "horário mantido"; acima de 15 min não recebe promessa e a IA oferece remarcar; a equipe recebe nota privada em ambos.
- [ ] Testado contra Postgres e Redis reais (repositório, rota e fila): os testes unitários cobrem o domínio com a agenda em memória.
- [ ] Antes de produção: template `aviso_atraso` aprovado na Meta e `npm run eval` rodado com casos de aviso de atraso.
