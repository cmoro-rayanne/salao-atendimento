# Spec 0005 — Painel: leads, aulas agendadas e relatório mensal

Design: https://claude.ai/artifact/XDB4MDCFewt985XrTDBeTp

## Objetivo
A recepção acompanha os leads e marca presença nas aulas experimentais; o dono vê, por mês, quanto a IA atendeu, o que virou matrícula e onde ela precisou da equipe.

## Design
- **Leads** — `GET /admin/api/leads?status&q&from&to` (até 100, mais recentes primeiro, com contagem por situação no período) e `PATCH /admin/api/leads/:id` com `expectedVersion` (lock otimista; 409 se outra pessoa mudou). Marcar `matriculado` grava `enrolled_at`.
- **Aulas agendadas** — `GET /admin/api/bookings?from&to` (reservas não canceladas, com contato e situação do lembrete) e `PATCH /admin/api/bookings/:id` com `veio` / `faltou` / `desmarcar`, só para aulas que já começaram.
- **Relatório** — `GET /admin/api/report?month=AAAA-MM`, calculado no fuso da academia:
  - conversas atendidas (conversas distintas em `agent_runs`) e quantas a IA resolveu sem transferir;
  - funil: conversas → contatos com interesse (leads do mês com objetivo ou modalidade) → experimentais agendadas → vieram → matrículas (`enrolled_at` no mês);
  - transferências por motivo (`handoffs.reason`, agrupando os motivos livres da IA em categorias);
  - conversas por hora de chegada; com `reception_hours` configurado, a parte fora do horário da recepção;
  - custo de IA (`agent_runs.cost_usd`, quando o preço por token estiver configurado) convertido por `USD_BRL`, e tempo mediano de resposta.
- **Dados novos** (migration 005): `tenant_id` em `agent_runs` e `handoffs`; `leads.enrolled_at`; `tenants.reception_hours` no formato `{"open": 7, "close": 21}`. O worker passa a gravar `cost_usd` com `LLM_PRICE_INPUT_USD_PER_MTOK` e `LLM_PRICE_OUTPUT_USD_PER_MTOK`.
- **PDF** — "Baixar PDF do mês" usa a impressão do navegador, com CSS de impressão.

## Diferenças em relação ao design
- O card "Mensagens do WhatsApp (Meta)" sai: o agente não sabe quantas mensagens a Meta cobrou. O valor real fica no WhatsApp Manager.
- O link "perguntas que a IA não soube responder" fica para depois; por ora, o motivo "dúvida fora da base" mostra o volume.

## Critérios de aceite
- [x] Filtro por situação, busca por nome/telefone e contagens por situação no período.
- [x] Mudar a situação com versão antiga devolve 409 e não altera nada.
- [x] Só dá para marcar presença em aula que já começou; outra academia recebe 404.
- [x] Relatório usa o fuso da academia para o mês e para as horas.
- [x] Números do relatório conferidos com dados montados em teste de integração.
- [x] Telas funcionam no celular.
- [ ] Validar com a recepção e com o dono da academia, com dados reais.
