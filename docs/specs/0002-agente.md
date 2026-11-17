# Spec 0002 — Agente com IA (semana 2)

## Objetivo
Trocar o eco por um atendente com IA que responde só com a base de conhecimento da academia, registra o lead e passa para a equipe o que precisa de gente.

## Design
- `ReplyToConversation` (módulo `conversation`) orquestra uma resposta: resolve o tenant pelo `account_id` do Chatwoot, carrega contato, histórico e base, roda `runAgent`, envia a resposta e grava `agent_runs`.
- `LlmClient` com adapter da API da Anthropic (`/v1/messages`, tool use, cache de prompt no system). Modelo por `LLM_MODEL`.
- Prompt montado por função pura (`buildSystemPrompt`) a partir da base ativa; a versão da base fica registrada em cada execução.
- Ferramentas: `registrar_lead` (upsert atômico por tenant + telefone) e `transferir_para_humano` (nota privada + status `open` + registro em `handoffs`).
- Lock por conversa no Redis (`SET NX PX`): se outra resposta da mesma conversa estiver em andamento, o job é retentado depois.
- Job que esgota as tentativas: o cliente recebe aviso de transferência e a conversa vai para a equipe.

## Critérios de aceite
- [x] Resposta em texto é enviada ao Chatwoot e registrada em `agent_runs` com tokens, passos, ferramentas e versão da base.
- [x] Primeira resposta da conversa avisa que é atendimento automatizado (LGPD).
- [x] `registrar_lead` não duplica o lead do mesmo telefone e não apaga dados já preenchidos.
- [x] Transferência (pela IA ou por limite de passos) envia nota privada com o motivo e muda a conversa para `open`.
- [x] Erro do LLM é relançado para a fila tentar de novo; tentativas esgotadas transferem com mensagem ao cliente.
- [x] Conversa sem tenant cadastrado não chama a IA e é transferida.
- [x] Testes unitários com LLM e gateways falsos.
- [ ] Conjunto de avaliação com ~30 perguntas reais da academia (`npm run eval`); hoje há 12 perguntas de exemplo.
- [ ] Teste ponta a ponta no número de teste da Meta.

## Fora do escopo
Agendamento de aula experimental (spec 0003) e painel (spec 0004).
