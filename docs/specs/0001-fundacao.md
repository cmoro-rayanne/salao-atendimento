# Spec 0001 — Fundação (semana 1)

## Objetivo
Uma mensagem enviada ao número de teste chega ao Chatwoot e o agente responde em eco, sem duplicar respostas.

## Critérios de aceite
- [x] `POST /webhooks/chatwoot/:secret` recusa segredo errado (401) e payload inválido (400).
- [x] Evento repetido não gera segunda resposta (`processed_events`).
- [x] Conversa `open` (com a equipe) não é respondida pelo bot.
- [x] Mensagens em sequência viram um único job (deduplicação por conversa na fila).
- [x] Loop do agente: responde, chama ferramenta, devolve erro de input ao modelo, transfere por ferramenta ou por limite de passos.
- [ ] Cadastro da WABA e do número de teste na Meta.
- [ ] VPS com `deploy/docker-compose.yml` no ar; Chatwoot conectado ao número de teste.
- [ ] Agent Bot criado no Chatwoot apontando para o agente; eco funcionando ponta a ponta.

## Próxima spec (0002 — Agente)
Adapter do LLM, prompt de sistema, base de conhecimento, ferramentas `registrar_lead` e `transferir_para_humano`, conjunto de avaliação com ~30 perguntas.
